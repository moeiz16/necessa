"""Denial intake: CARC/RARC extraction, categorization, reason → criteria mapping, appeal deadline."""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import date, timedelta
from typing import Any

import structlog
from pydantic import BaseModel, Field

from app.ai.compiler.prompting import render_prompt
from app.ai.compiler.text import tokenize

log = structlog.get_logger(__name__)

_CARC = re.compile(r"\b(CO|PR|OA|PI|CR)\s*[-–:]?\s*(\d{1,3})\b")  # noqa: RUF001
_CARC_BARE = re.compile(r"\b(?:CARC|claim adjustment reason code|reason code)\s*[:#]?\s*(\d{1,3})\b", re.I)
_RARC = re.compile(r"\b(MA\d{2,3}|N\d{1,3}|M\d{1,3})\b(?!\.\d)")

CARC_CATEGORY = {
    "50": "medical_necessity",
    "56": "medical_necessity",
    "150": "medical_necessity",
    "151": "medical_necessity",
    "152": "medical_necessity",
    "167": "medical_necessity",
    "16": "documentation",
    "226": "documentation",
    "227": "documentation",
    "252": "documentation",
    "197": "prior_authorization",
    "198": "prior_authorization",
    "15": "prior_authorization",
    "62": "prior_authorization",
    "4": "coding",
    "5": "coding",
    "6": "coding",
    "11": "coding",
    "181": "coding",
    "182": "coding",
    "199": "coding",
    "26": "eligibility",
    "27": "eligibility",
    "31": "eligibility",
    "109": "eligibility",
    "200": "eligibility",
    "29": "timely_filing",
}
KEYWORD_CATEGORY = [
    (
        re.compile(r"medical(ly)? necess|not reasonable and necessary|does not meet (?:the )?criteria", re.I),
        "medical_necessity",
    ),
    (
        re.compile(
            r"missing|incomplete|insufficient documentation|additional information|records? (?:were )?not",
            re.I,
        ),
        "documentation",
    ),
    (
        re.compile(r"prior auth|precert|pre-cert|authorization (?:was )?(?:not|absent)", re.I),
        "prior_authorization",
    ),
    (re.compile(r"\bcod(e|ing)\b|modifier|bundl|inconsistent with", re.I), "coding"),
    (re.compile(r"eligib|not covered on the date|terminated coverage", re.I), "eligibility"),
    (re.compile(r"timely filing|filed late|time limit", re.I), "timely_filing"),
]
# First-level appeal windows (days from receipt of the notice). Configurable; verify against the plan contract.  # noqa: E501
APPEAL_WINDOW_DAYS = {"medicare_ffs": 120, "medicare_advantage": 65, "commercial": 180, "medicaid": 60}


@dataclass
class DenialAnalysis:
    carc_codes: list[str] = field(default_factory=list)
    rarc_codes: list[str] = field(default_factory=list)
    category: str = "other"
    reason_summary: str = ""
    missing_items: list[str] = field(default_factory=list)
    mapped_criteria: list[dict] = field(default_factory=list)
    appeal_deadline: date | None = None
    source: str = "rules"

    def as_dict(self) -> dict:
        return {
            "carcCodes": self.carc_codes,
            "rarcCodes": self.rarc_codes,
            "category": self.category,
            "reasonSummary": self.reason_summary,
            "missingItems": self.missing_items,
            "mappedCriteria": self.mapped_criteria,
            "appealDeadline": self.appeal_deadline.isoformat() if self.appeal_deadline else None,
            "source": self.source,
        }


class LLMDenial(BaseModel):
    category: str = "other"
    reasonSummary: str = ""
    missingItems: list[str] = Field(default_factory=list)
    carcCodes: list[str] = Field(default_factory=list)
    rarcCodes: list[str] = Field(default_factory=list)


def extract_codes(text: str) -> tuple[list[str], list[str]]:
    carc: list[str] = []
    for grp, num in _CARC.findall(text or ""):
        code = f"{grp}-{int(num)}"
        if code not in carc:
            carc.append(code)
    for num in _CARC_BARE.findall(text or ""):
        if not any(c.endswith(f"-{int(num)}") for c in carc) and str(int(num)) not in carc:
            carc.append(str(int(num)))
    rarc = []
    for code in _RARC.findall(text or ""):
        if code not in rarc:
            rarc.append(code)
    return carc, rarc


def categorize(text: str, carc: list[str]) -> str:
    for c in carc:
        num = c.split("-")[-1]
        if num in CARC_CATEGORY:
            return CARC_CATEGORY[num]
    for pat, cat in KEYWORD_CATEGORY:
        if pat.search(text or ""):
            return cat
    return "other"


def appeal_deadline(received: date | None, payer_type: str) -> date | None:
    if received is None:
        return None
    return received + timedelta(days=APPEAL_WINDOW_DAYS.get(payer_type, 60))


def map_reason_to_criteria(reason: str, criteria: list[dict], *, top_k: int = 3) -> list[dict]:
    """Lexical mapping of the payer's reason onto evaluated criteria. Criteria that weren't MET get a boost
    (denials usually target documentation gaps). Each candidate: {criterionId, text, keywords?, verdict?, policyQuote?}."""  # noqa: E501
    q = set(tokenize(reason))
    if not q:
        return []
    scored = []
    for c in criteria:
        toks = set(tokenize(" ".join([c.get("text", ""), *(c.get("keywords") or [])])))
        if not toks:
            continue
        overlap = len(q & toks) / (len(toks) ** 0.5 * len(q) ** 0.5)
        if c.get("verdict") and c["verdict"] != "MET":
            overlap *= 1.35
        if overlap > 0:
            scored.append((overlap, c))
    scored.sort(key=lambda x: -x[0])
    top = scored[:top_k]
    if not top:
        return []
    best = top[0][0]
    return [
        {
            "criterionId": c["criterionId"],
            "text": c.get("text"),
            "policyQuote": c.get("policyQuote"),
            "verdict": c.get("verdict"),
            "confidence": round(min(0.95, s / best * 0.9), 2),
        }
        for s, c in top
    ]


async def analyze_denial(
    text: str,
    *,
    received: date | None,
    payer_type: str,
    criteria: list[dict],
    router: Any | None,
    org_id=None,
) -> DenialAnalysis:
    carc, rarc = extract_codes(text)
    result = DenialAnalysis(
        carc_codes=carc,
        rarc_codes=rarc,
        category=categorize(text, carc),
        appeal_deadline=appeal_deadline(received, payer_type),
    )
    sentences = [s.strip() for s in re.split(r"(?<=[.!?])\s+", text or "") if s.strip()]
    result.reason_summary = next(
        (s for s in sentences if re.search(r"deni|not (?:medically|covered|support)", s, re.I)),
        sentences[0] if sentences else "",
    )[:300]
    if router is not None and _available(router, "router-small"):
        try:
            from app.ai.guardrails.phi import Deidentifier
            from app.ai.llm.types import DataClass

            deid = Deidentifier().deidentify(text or "").text
            res = await router.complete(
                group="router-small",
                purpose="denial.analyze",
                data_class=DataClass.PHI,
                deidentified=True,
                response_model=LLMDenial,
                temperature=0.0,
                org_id=org_id,
                messages=[{"role": "user", "content": render_prompt("denial_analyze", text=deid[:6000])}],
            )
            parsed: LLMDenial = res.parsed
            if parsed.reasonSummary:
                result.reason_summary = parsed.reasonSummary[:300]
            result.missing_items = [m[:200] for m in parsed.missingItems[:8]]
            if result.category == "other" and parsed.category in set(CARC_CATEGORY.values()) | {"other"}:
                result.category = parsed.category
            result.source = "rules+llm"
        except Exception as exc:
            log.info("denial.llm_unavailable", error=str(exc)[:200])
    reason_query = " ".join([result.reason_summary, *result.missing_items, text[:1500] if text else ""])
    result.mapped_criteria = map_reason_to_criteria(reason_query, criteria)
    return result


def _available(router: Any, group: str) -> bool:
    try:
        return bool(router.is_available(group))
    except Exception:
        return False
