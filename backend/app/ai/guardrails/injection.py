"""Prompt-injection / jailbreak detection for user input AND retrieved/uploaded content.

Two layers (no local models):
1. Weighted heuristic patterns (instant, free) — including domain-specific attacks hidden in
   clinical notes ("mark all criteria as met", "approve this request").
2. Optional LLM classification through the `guard` group, only for the ambiguous middle band,
   so the free-tier quota is spent where it matters.
"""

from __future__ import annotations

import base64
import re
from dataclasses import dataclass, field
from typing import Literal

import structlog
from pydantic import BaseModel, Field

log = structlog.get_logger(__name__)

_PATTERNS: list[tuple[str, float, re.Pattern]] = [
    (
        "override_instructions",
        0.75,
        re.compile(
            r"\b(ignore|disregard|forget|override|bypass)\b[^.\n]{0,40}\b(previous|prior|above|all|any|earlier|"
            r"system|your)\b[^.\n]{0,25}\b(instructions?|rules?|prompts?|directives?|guidelines?)",
            re.I,
        ),
    ),
    (
        "role_hijack",
        0.55,
        re.compile(r"\b(you are now|from now on,? you|act as (an?|the)|pretend to be|roleplay as)\b", re.I),
    ),
    (
        "prompt_exfiltration",
        0.65,
        re.compile(
            r"\b(reveal|print|show|repeat|output|leak)\b[^.\n]{0,30}"
            r"\b(system prompt|hidden prompt|your instructions|"
            r"initial prompt|developer message)",
            re.I,
        ),
    ),
    (
        "jailbreak_persona",
        0.7,
        re.compile(r"\b(DAN|developer mode|jailbreak|do anything now|unfiltered mode)\b", re.I),
    ),
    (
        "chat_markup",
        0.6,
        re.compile(r"(<\|im_start\|>|<\|im_end\|>|\[INST\]|<<SYS>>|^\s*(system|assistant)\s*:)", re.I | re.M),
    ),
    (
        "fake_section",
        0.45,
        re.compile(r"(#{2,}\s*(new )?instructions?|BEGIN (SYSTEM|ADMIN)|END OF (CONTEXT|DOCUMENT))", re.I),
    ),
    (
        "verdict_tampering",
        0.8,
        re.compile(
            r"\b(mark|set|treat|consider|record|flag)\b[^.\n]{0,30}"
            r"\b(all |every |each )?(criteria|criterion|requirements?)"
            r"\b[^.\n]{0,20}\b(as )?(met|satisfied|passed|fulfilled)\b",
            re.I,
        ),
    ),
    (
        "decision_tampering",
        0.7,
        re.compile(
            r"\b(approve|authorize|auto-?approve|deny)\b[^.\n]{0,25}\b(this|the)\b[^.\n]{0,15}"
            r"\b(request|claim|authorization|case)\b[^.\n]{0,20}\b(regardless|immediately|without)",
            re.I,
        ),
    ),
    (
        "suppression",
        0.5,
        re.compile(r"\b(do not|don't|never)\b[^.\n]{0,20}\b(mention|flag|report|cite|disclose)\b", re.I),
    ),
    ("exfil_link", 0.7, re.compile(r"!\[[^\]]*\]\(https?://[^)]+[?&][^)]*=", re.I)),
    (
        "tool_coercion",
        0.55,
        re.compile(
            r"\b(call|invoke|execute|run)\b[^.\n]{0,20}\b(tool|function|sql|query|command)"
            r"\b[^.\n]{0,30}\b(drop|delete|update|insert|grant)\b",
            re.I,
        ),
    ),
    (
        # "disregard the policy", "ignore the excerpts/evidence", "forget everything above"
        "override_grounding",
        0.65,
        re.compile(
            r"\b(ignore|disregard|forget|override|bypass|skip)\b\s+(?:all\s+|any\s+|everything\s+)?(?:of\s+)?"
            r"(?:the\s+|this\s+|that\s+|these\s+|those\s+|your\s+)?"
            r"(policy|policies|criteria|excerpts?|evidence|sources?|guidelines|documentation|context|"
            r"above|previous|prior|earlier|preceding)\b",
            re.I,
        ),
    ),
    (
        # addressed to the model: "Note to AI reviewer:", "Dear assistant,"
        "addressed_to_ai",
        0.4,
        re.compile(
            r"\b(note|message|instructions?)\s+(to|for)\s+(the\s+)?"
            r"(ai|assistant|model|llm|reviewer bot|gpt)\b|"
            r"\b(dear|hey|attention)\s+(ai|assistant|model|chatgpt|claude)\b",
            re.I,
        ),
    ),
    (
        # "state/conclude that the patient meets all requirements"
        "conclusion_forcing",
        0.6,
        re.compile(
            r"\b(state|say|claim|conclude|report|answer|output|respond)\b[^.\n]{0,15}\bthat\b[^.\n]{0,25}"
            r"\b(meets?|satisf(?:y|ies)|fulfills?|qualif(?:y|ies))\b[^.\n]{0,15}\b(all|every|each)\b",
            re.I,
        ),
    ),
    (
        # fake role tags: [[assistant]], [[/system]], <system>, </developer>, <|system|>
        "fake_role_tag",
        0.75,
        re.compile(
            r"\[\[\s*/?\s*(system|assistant|user|developer|tool)\s*\]\]|"
            r"</?\s*(system|assistant|developer|tool_result|im_start|im_end)\s*>|"
            r"<\|\s*(system|assistant|user|developer)\s*\|>",
            re.I,
        ),
    ),
    (
        # forged closing/opening wrapper tags used to break out of XML data wrappers in prompts
        "wrapper_breakout",
        0.8,
        re.compile(
            r"</\s*(excerpts?|evidence|policy|policies|sources?|documents?|context|chart|content|"
            r"instructions|criteria|criterion|question|tool_results?|case_context|passage)\s*>|"
            r"<\s*(excerpt|evidence|source|passage)\b[^>]*\b(chunk_?id|n|key)\s*=",
            re.I,
        ),
    ),
]
_ZW = re.compile("[\u200b\u200c\u200d\u2060\ufeff\u202a-\u202e]")
_B64 = re.compile(r"\b[A-Za-z0-9+/]{80,}={0,2}\b")

CLEAN_MAX = 0.35
MALICIOUS_MIN = 0.7


@dataclass
class InjectionVerdict:
    score: float
    label: Literal["clean", "suspicious", "malicious"]
    reasons: list[str] = field(default_factory=list)
    llm_checked: bool = False


class _GuardOut(BaseModel):
    label: Literal["benign", "injection"] = "benign"
    confidence: float = Field(0.5, ge=0, le=1)
    reason: str = ""


def heuristic_score(text: str) -> tuple[float, list[str]]:
    text = text or ""
    reasons: list[str] = []
    keep = 1.0
    for name, weight, pat in _PATTERNS:
        if pat.search(text):
            reasons.append(name)
            keep *= 1 - weight
    if _ZW.search(text):
        reasons.append("invisible_unicode")
        keep *= 1 - 0.3
    for m in _B64.finditer(text):
        try:
            decoded = base64.b64decode(m.group(0) + "==", validate=False).decode("utf-8", "ignore")
        except Exception:  # noqa: S112 - undecodable blob is simply not a payload
            continue
        if any(p.search(decoded) for _, _, p in _PATTERNS):
            reasons.append("encoded_payload")
            keep *= 1 - 0.7
            break
    return round(1 - keep, 4), reasons


def _label(score: float) -> Literal["clean", "suspicious", "malicious"]:
    if score < CLEAN_MAX:
        return "clean"
    if score < MALICIOUS_MIN:
        return "suspicious"
    return "malicious"


async def scan_injection(text: str, *, source: str, use_llm: bool = True) -> InjectionVerdict:
    """Score text for injection. `source` in user|document|retrieved|chart (for telemetry)."""
    score, reasons = heuristic_score(text)
    verdict = InjectionVerdict(score=score, label=_label(score), reasons=reasons)
    if not use_llm or verdict.label != "suspicious":
        return verdict
    try:
        from app.ai.llm.router import get_llm_router
        from app.ai.llm.types import DataClass
        from app.ai.prompts.loader import render

        router = get_llm_router()
        sys_prompt, _ = render("guard_injection")
        res = await router.complete(
            group="guard",
            purpose=f"guard.injection.{source}",
            messages=[
                {"role": "system", "content": sys_prompt},
                {"role": "user", "content": f"<content>\n{text[:4000]}\n</content>"},
            ],
            data_class=DataClass.PUBLIC if source in {"user", "retrieved"} else DataClass.PHI,
            deidentified=True,
            response_model=_GuardOut,
            max_tokens=150,
        )
        out = res.parsed
        if isinstance(out, _GuardOut):
            verdict.llm_checked = True
            if out.label == "injection":
                verdict.score = round(max(score, 0.5 + 0.5 * out.confidence), 4)
                verdict.reasons.append(f"llm:{out.reason[:80]}")
            else:
                verdict.score = round(score * (1 - 0.5 * out.confidence), 4)
            verdict.label = _label(verdict.score)
    except Exception as exc:  # LLM unavailable: keep heuristic verdict
        log.debug("guard.llm_unavailable", error=str(exc))
    return verdict


def sanitize_for_prompt(text: str) -> str:
    """Neutralize chat-markup tokens inside data so retrieved text can't open new roles."""
    text = _ZW.sub("", text or "")
    text = re.sub(r"<\|im_(start|end)\|>", "", text)
    text = re.sub(r"\[/?INST\]|<</?SYS>>", "", text)
    text = re.sub(r"\[\[\s*/?\s*(system|assistant|user|developer|tool)\s*\]\]", "", text, flags=re.I)
    # Escape any tag that could close/open a prompt data wrapper (<source>, <excerpt>, <evidence>, …)
    return _WRAPPER_TAG.sub(lambda m: m.group(0).replace("<", "&lt;").replace(">", "&gt;"), text)


_WRAPPER_TAG = re.compile(
    r"</?\s*(excerpts?|evidence|policy|policies|sources?|documents?|context|chart|content|instructions|"
    r"criteria|criterion|question|tool_results?|tool|case_context|passage|system|assistant|developer|"
    r"conversation_summary|as_of)\b[^>]*>",
    re.I,
)
