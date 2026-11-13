"""Intent classification for the retrieval strategy matrix (S1-S11).

Layered, cheapest first:
1. **Rules** over the QueryAnalysis (identifiers, aggregation words, change words…) — $0, instant.
2. **Embedding kNN** over ~60 labeled example queries when the rules are not confident.
3. **LLM** (`router-small`, structured output) only if kNN is also unsure and a model is available.
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass

import structlog
from pydantic import BaseModel, Field

from app.ai.guardrails.policy import is_out_of_scope_question
from app.ai.retrieval.understanding import QueryAnalysis

log = structlog.get_logger(__name__)

INTENTS = (
    "exact_lookup",  # S1
    "structured_fact",  # S2
    "analytics",  # S3
    "conceptual",  # S4
    "lay_language",  # S5
    "keyword_heavy",  # S6
    "chart_evidence",  # S7
    "multi_hop",  # S8
    "version_compare",  # S9
    "denial_mapping",  # S10
    "out_of_scope",  # S11
)

_AGG = re.compile(
    r"\b(how many|count|number of|top \d*|most common|average|avg|mean|median|rate|percent(age)?|"
    r"trend|per (day|week|month)|by (status|payer|month|week|assignee|category|criterion)|breakdown|"
    r"distribution|total)\b",
    re.I,
)
_OWN_DATA = re.compile(
    r"\b(my|our|we|us|team'?s?|practice'?s?|org'?s?)\b[^?]{0,40}\b(cases?|denials?|appeals?|"
    r"letters?|evaluations?|submissions?|criteria|gaps?|requests?|patients?)\b|"
    r"\b(cases?|denials?|appeals?|evaluations?|gaps?)\b[^?]{0,30}\b(this|last) (week|month|"
    r"quarter|year)\b",
    re.I,
)
_CHANGE = re.compile(
    r"\b(what (has )?changed|changes? (in|to|since)|difference between|compared? (to|with)|"
    r"previous version|prior version|revision history|updated since|new in version|diff)\b",
    re.I,
)
_DENIAL = re.compile(
    r"\b(denial|denied|denies coverage|CARC|RARC|reason code|appeal(ing)?|overturn|"
    r"adverse determination)\b",
    re.I,
)
_STRUCT = re.compile(
    r"\b(which|list|what) (lcds?|ncds?|articles?|policies|contractors?|macs?|states?|codes?|"
    r"diagnos\w*)\b|\b(is|are) [^?]{0,40}\b(covered|listed|in (the )?(lcd|article|policy))\b|"
    r"\b(covered diagnos\w*|icd-?10 codes? (for|in|that)|jurisdiction|which (mac|contractor))\b|"
    r"\bdoes [^?]{0,40}\b(cover|list|include)\b",
    re.I,
)
_DOCUMENTATION = re.compile(
    r"\b(document\w*|criteria|requirements?|need to (show|submit|include)|records?|"
    r"notes?|medically necessary|medical necessity)\b",
    re.I,
)
_DOMAIN = re.compile(
    r"\b(cover\w*|policy|policies|lcd|ncd|article|criteria|medical necessity|medically necessary|"
    r"prior auth\w*|authorization|documentation|billing|coding|diagnos\w*|icd|cpt|hcpcs|"
    r"medicare|medicaid|payer|claim|procedure|device|therapy|imaging|injection|stimulat\w*|"
    r"arthroscop\w*|surgery|equipment|dme|prosthe\w*|wheelchair|apnea|pain)\b",
    re.I,
)


@dataclass
class IntentResult:
    intent: str
    confidence: float
    reason: str
    method: str  # rules|knn|llm


def classify_rules(q: QueryAnalysis) -> IntentResult:
    text = q.normalized
    words = len(text.split())
    if is_out_of_scope_question(text):
        return IntentResult("out_of_scope", 0.95, "clinical-advice or diagnosis request", "rules")
    if _AGG.search(text) and _OWN_DATA.search(text):
        return IntentResult("analytics", 0.92, "aggregation over the organization's own case data", "rules")
    if _CHANGE.search(text):
        return IntentResult("version_compare", 0.85, "asks what changed between policy versions", "rules")
    if _DENIAL.search(text):
        return IntentResult("denial_mapping", 0.8, "denial / appeal language", "rules")
    struct = bool(_STRUCT.search(text))
    doc = bool(_DOCUMENTATION.search(text))
    if struct and doc and (q.has_identifiers or q.states):
        return IntentResult(
            "multi_hop", 0.82, "structured coverage fact + documentation requirement", "rules"
        )
    if struct and (q.has_identifiers or q.states or q.doc_types):
        return IntentResult(
            "structured_fact", 0.85, "relational question about codes/policies/jurisdictions", "rules"
        )
    if q.source_keys and words <= 6:
        return IntentResult("exact_lookup", 0.9, f"identifier lookup ({', '.join(q.source_keys)})", "rules")
    if q.all_codes and words <= 4:
        return IntentResult("exact_lookup", 0.85, f"code lookup ({', '.join(q.all_codes)})", "rules")
    if q.lay_terms:
        return IntentResult("lay_language", 0.8, f"lay terms: {', '.join(q.lay_terms)}", "rules")
    if q.all_codes or q.source_keys:
        return IntentResult("keyword_heavy", 0.7, "identifiers inside a conceptual question", "rules")
    if not _DOMAIN.search(text):
        return IntentResult("lay_language", 0.45, "no domain vocabulary detected", "rules")
    return IntentResult("conceptual", 0.6, "conceptual policy question", "rules")


# ── kNN over labeled examples ──────────────────────────────────────────────
EXAMPLES: list[tuple[str, str]] = [
    ("What is LCD L33718?", "exact_lookup"),
    ("Show A52369", "exact_lookup"),
    ("E0601", "exact_lookup"),
    ("NCD 150.9", "exact_lookup"),
    ("29881 policy", "exact_lookup"),
    ("Which LCDs list 64561 in Ohio?", "structured_fact"),
    ("Is M17.11 a covered diagnosis for knee arthroscopy?", "structured_fact"),
    ("Which contractors publish the PAP device LCD?", "structured_fact"),
    ("What states does the spinal cord stimulator LCD apply to?", "structured_fact"),
    ("List covered ICD-10 codes for article A57453", "structured_fact"),
    ("How many of our cases were missing PT documentation this month?", "analytics"),
    ("Top 5 gap criteria across my cases", "analytics"),
    ("What is our ready rate by payer?", "analytics"),
    ("Count denials by category last quarter", "analytics"),
    ("Average readiness score per week", "analytics"),
    ("What conservative therapy is required before knee arthroscopy?", "conceptual"),
    ("When is a CPAP device covered beyond the first three months?", "conceptual"),
    ("What are the coverage criteria for spinal cord stimulator trials?", "conceptual"),
    ("Is image guidance required for epidural steroid injections?", "conceptual"),
    ("What documentation is required for a power wheelchair?", "conceptual"),
    ("What makes a skin substitute application medically necessary?", "conceptual"),
    ("nerve zapper for overactive bladder", "lay_language"),
    ("can i get a knee scope", "lay_language"),
    ("my mom needs an electric wheelchair what do we need", "lay_language"),
    ("sleep apnea machine rules", "lay_language"),
    ("back shot for sciatica", "lay_language"),
    ("MUE for E0784", "keyword_heavy"),
    ("KX modifier requirements for L5856", "keyword_heavy"),
    ("Q4186 frequency limits", "keyword_heavy"),
    ("G0289 with 29880 same knee", "keyword_heavy"),
    ("Is M17.11 covered for knee arthroscopy in Texas and what documentation is needed?", "multi_hop"),
    ("Which LCD covers 63650 in Arizona and what are its trial criteria?", "multi_hop"),
    ("What changed in L33718 since last year?", "version_compare"),
    ("Difference between version 4 and 5 of the PAP policy", "version_compare"),
    ("revision history of the knee arthroscopy article", "version_compare"),
    ("Claim denied for missing conservative therapy documentation", "denial_mapping"),
    ("Denial reason CO-50 not medically necessary for 64483", "denial_mapping"),
    ("How do I appeal a denied CPAP claim?", "denial_mapping"),
    ("Should I prescribe gabapentin for this patient?", "out_of_scope"),
    ("What dose of prednisone should I give?", "out_of_scope"),
    ("diagnose my knee pain", "out_of_scope"),
]
_example_vecs: list[list[float]] | None = None


def _cos(a: list[float], b: list[float]) -> float:
    num = sum(x * y for x, y in zip(a, b, strict=False))
    den = math.sqrt(sum(x * x for x in a)) * math.sqrt(sum(y * y for y in b)) or 1.0
    return num / den


async def classify_knn(q: QueryAnalysis, k: int = 5) -> IntentResult | None:
    global _example_vecs
    from app.ai.embeddings import embed_documents, embed_query

    if _example_vecs is None:
        vecs = await embed_documents([t for t, _ in EXAMPLES], purpose="intent.examples")
        if vecs is None:
            return None
        _example_vecs = vecs
    qv = await embed_query(q.expanded, purpose="intent.query")
    if qv is None:
        return None
    sims = sorted(((_cos(qv, v), EXAMPLES[i][1]) for i, v in enumerate(_example_vecs)), reverse=True)[:k]
    votes: dict[str, float] = {}
    for s, label in sims:
        votes[label] = votes.get(label, 0.0) + max(0.0, s)
    if not votes:
        return None
    label, score = max(votes.items(), key=lambda kv: kv[1])
    total = sum(votes.values()) or 1.0
    return IntentResult(
        label, round(min(0.95, score / total), 3), f"kNN vote over {k} labeled examples", "knn"
    )


class _LLMIntent(BaseModel):
    intent: str = Field(description="one of: " + ", ".join(INTENTS))
    confidence: float = Field(ge=0, le=1)


async def classify_llm(q: QueryAnalysis) -> IntentResult | None:
    from app.ai.llm.router import get_llm_router
    from app.ai.prompts.loader import render

    router = get_llm_router()
    if getattr(router, "fake", False) or not router.is_available("router-small"):
        return None
    try:
        prompt, _ = render("route_intent", question=q.normalized, intents=", ".join(INTENTS))
        res = await router.complete(
            group="router-small",
            purpose="route.intent",
            messages=[{"role": "user", "content": prompt}],
            response_model=_LLMIntent,
            max_tokens=80,
        )
        out = res.parsed
        if isinstance(out, _LLMIntent) and out.intent in INTENTS:
            return IntentResult(out.intent, out.confidence, "LLM classification", "llm")
    except Exception as exc:
        log.debug("intent.llm_failed", error=str(exc))
    return None


async def classify(q: QueryAnalysis, *, allow_knn: bool = True, allow_llm: bool = True) -> IntentResult:
    rules = classify_rules(q)
    if rules.confidence >= 0.7 or not allow_knn:
        return rules
    knn = await classify_knn(q)
    best = rules
    if knn and knn.intent != "out_of_scope" and knn.confidence > rules.confidence:
        best = knn
    if best.confidence < 0.5 and allow_llm:
        llm = await classify_llm(q)
        if llm and llm.confidence > best.confidence:
            best = llm
    return best
