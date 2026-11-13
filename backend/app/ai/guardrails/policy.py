"""Policy enforcement on generated text.

Necessa is an *assistive documentation* tool. It must never:
* state or predict a coverage decision for a specific patient/claim ("this will be approved",
  "guaranteed to be covered", "the payer must approve"),
* give clinical advice (prescribe, dose, titrate, start/stop treatment, diagnose).

Detection is sentence-level. Conditional policy language — "the service is covered WHEN the following
criteria are met", "claims will be denied IF documentation is missing" — describes the policy, not a
decision, and is allowed. Violating sentences are replaced with neutral language and a disclaimer is
appended.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

DISCLAIMER = (
    "Necessa summarizes coverage policy and documentation. It does not make or predict coverage "
    "decisions and does not provide clinical advice; a licensed professional must review."
)
DECISION_REPLACEMENT = (
    "Coverage is decided by the payer's review of the submitted documentation; Necessa does not predict "
    "the outcome."
)
CLINICAL_REPLACEMENT = "[Clinical guidance omitted: treatment decisions belong to the treating clinician.]"

_OUTCOME = r"(approved|denied|covered|rejected|paid|authori[sz]ed|reimbursed|overturned|upheld)"
_DECISION_PATTERNS = [
    # "the request will be approved", "this claim is likely to be denied", "it should be covered"
    re.compile(
        r"\b(claim|request|authorization|prior auth\w*|case|service|procedure|device|submission|appeal|"
        r"this|it|patient)\s+(will|would|is going to|is likely to|is expected to|should|shall|is sure to|"
        r"is certain to)\s+(definitely\s+|likely\s+|certainly\s+|surely\s+|probably\s+|almost certainly\s+)?"
        rf"(be\s+|get\s+)?{_OUTCOME}\b",
        re.I,
    ),
    # "guaranteed to be covered", "is certain to be approved", "assured of coverage"
    re.compile(
        r"\b(guarantee[sd]?|guaranteed|assured|certain|sure|100%|definitely)\b[^.!?\n]{0,30}"
        r"\b(approv\w*|cover\w*|payment|paid|reimburs\w*|authoriz\w*)\b",
        re.I,
    ),
    # "the payer must approve", "Medicare has to cover", "the plan is required to pay"
    re.compile(
        r"\b(payer|plan|insurer|insurance|medicare|medicaid|contractor|mac|reviewer|health plan)\s+"
        r"(must|will|has to|have to|is required to|is obligated to|cannot deny|can't deny|should)\s+"
        r"(approve|cover|pay|authorize|reimburse|accept)\b",
        re.I,
    ),
    # "approval is guaranteed", "coverage is certain"
    re.compile(
        r"\b(approval|coverage|payment|authorization)\s+(is|will be)\s+(guaranteed|certain|assured|"
        r"automatic)\b",
        re.I,
    ),
]
_CONDITIONAL = re.compile(
    r"\b(when|if|only if|provided( that)?|as long as|unless|once|whenever|in cases where|"
    r"criteria (are|is) met|requirements are met)\b",
    re.I,
)

_CLINICAL_PATTERNS = [
    # "you should prescribe…", "the physician must stop…", "we should start…"
    re.compile(
        r"\b(you|we|i|the (physician|provider|clinician|doctor|surgeon|patient|member))\s+"
        r"(should|must|need to|ought to|have to|could)\s+(consider\s+)?(prescribe|administer|start|stop|"
        r"discontinue|increase|decrease|reduce|raise|taper|titrate|switch|add|order|give|take|begin|resume)\b",
        re.I,
    ),
    # "I recommend increasing the dose", "we suggest switching to…"
    re.compile(
        r"\b(i|we)\s+(would\s+)?(recommend|suggest|advise|propose)\s+(that\s+\w+\s+)?(increasing|decreasing|"
        r"reducing|starting|stopping|switching|adding|tapering|prescribing|discontinuing|titrating|taking|"
        r"raising|lowering|doubling)\b",
        re.I,
    ),
    # "increase the opioid dose", "double the dosage"
    re.compile(
        r"\b(increase|decrease|raise|lower|double|halve|titrate|adjust)\s+(the\s+)?([a-z-]+\s+){0,2}"
        r"(dose|dosage|dosing)\b",
        re.I,
    ),
    # explicit dosing regimens: "600 mg three times daily", "10 mg q8h"
    re.compile(
        r"\b\d+(\.\d+)?\s?(mg|mcg|µg|g|ml|units?|iu)\b[^.!?\n]{0,25}\b(daily|twice|three times|four times|"
        r"bid|tid|qid|qd|qhs|prn|once|every|q\d+h|per day|a day|at bedtime)\b",
        re.I,
    ),
    re.compile(r"\b(prescribe|administer)\s+\d", re.I),
    # "you should take/stop…" addressed to a patient
    re.compile(r"\byou\s+should\s+(take|stop|start|increase|decrease|skip)\b", re.I),
]

_OUT_OF_SCOPE_Q = re.compile(
    r"\b(should i (prescribe|take|give|stop|start|increase|decrease|switch)|what (dose|dosage)|"
    r"how much [a-z ]{0,30}should (i|he|she|they|the patient) (take|give|get)|diagnose (me|my|this|the)|"
    r"can you diagnose|is (it|this) (cancer|serious|malignant)|is it safe to (take|stop|start)|"
    r"treatment plan for (me|my|this))\b",
    re.I,
)
_SENTENCE = re.compile(r"(?<=[.!?])\s+|\n+")


@dataclass
class PolicyCheck:
    text: str
    violations: list[str] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return not self.violations


def _is_decision(sentence: str) -> bool:
    for pat in _DECISION_PATTERNS:
        m = pat.search(sentence)
        if m is None:
            continue
        # conditional policy language describes criteria, not a prediction for this claim
        if _CONDITIONAL.search(sentence[m.end() :]) or _CONDITIONAL.search(sentence[: m.start()]):
            if not re.search(r"\bguarantee|\bmust approve|\bmust cover|\bcannot deny", sentence, re.I):
                continue
        return True
    return False


def _is_clinical(sentence: str) -> bool:
    return any(p.search(sentence) for p in _CLINICAL_PATTERNS)


def enforce_output_policy(text: str) -> PolicyCheck:
    out = text or ""
    violations: list[str] = []
    pieces = re.split(r"((?<=[.!?])\s+|\n+)", out)  # keep separators to preserve formatting
    rebuilt: list[str] = []
    for piece in pieces:
        if not piece or _SENTENCE.fullmatch(piece):
            rebuilt.append(piece)
            continue
        bullet = re.match(r"^(\s*(?:[-*•]|\d+\.)\s+)", piece)
        prefix = bullet.group(1) if bullet else ""
        if _is_decision(piece):
            if "coverage_decision" not in violations:
                violations.append("coverage_decision")
            rebuilt.append(prefix + DECISION_REPLACEMENT)
        elif _is_clinical(piece):
            if "clinical_advice" not in violations:
                violations.append("clinical_advice")
            rebuilt.append(prefix + CLINICAL_REPLACEMENT)
        else:
            rebuilt.append(piece)
    out = "".join(rebuilt)
    if violations and DISCLAIMER not in out:
        out = f"{out.rstrip()}\n\n_{DISCLAIMER}_"
    return PolicyCheck(text=out, violations=violations)


def is_out_of_scope_question(question: str) -> bool:
    return bool(_OUT_OF_SCOPE_Q.search(question or ""))
