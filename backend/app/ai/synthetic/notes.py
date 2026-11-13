"""Counterfactual chart generator — exact ground truth for verdict evaluation at scale.

For a criteria tree we assign each leaf a *variant* and synthesize clinical notes accordingly:

    present           snippet documents the criterion            → MET
    paraphrased       same fact, different wording               → MET
    buried            snippet hidden mid-way in a long note       → MET          (lost-in-the-middle)
    ocr_noised        snippet with OCR-style character noise      → MET          (scanned faxes)
    removed           nothing about the criterion                 → INSUFFICIENT
    negated           explicit absence / not-yet-done statement   → NOT_MET or INSUFFICIENT
    contradicted      chart documents the opposite                → NOT_MET
    wrong_date_window documented, but outside the lookback window → INSUFFICIENT

Because we control every sentence, labels are exact — no human annotation needed, and the hard cases
(absence of evidence, negation, buried facts, OCR noise) are tested on purpose.
"""

from __future__ import annotations

import random
import re
from dataclasses import dataclass, field
from datetime import date, timedelta

from app.ai.compiler.logic import evaluate_tree, qualified_id, readiness_of
from app.ai.compiler.schema import CriteriaTree, CriterionLeaf, Verdict, iter_leaves_with_path
from app.ai.compiler.text import normalize_for_match
from app.ai.synthetic.patients import SyntheticPatient

VARIANTS = [
    "present",
    "paraphrased",
    "buried",
    "ocr_noised",
    "removed",
    "negated",
    "contradicted",
    "wrong_date_window",
]
EXPECTED: dict[str, set[str]] = {
    "present": {"MET"},
    "paraphrased": {"MET"},
    "buried": {"MET"},
    "ocr_noised": {"MET"},
    "removed": {"INSUFFICIENT"},
    "negated": {"NOT_MET", "INSUFFICIENT"},
    "contradicted": {"NOT_MET"},
    "wrong_date_window": {"INSUFFICIENT"},
}
PRIMARY = {
    "present": "MET",
    "paraphrased": "MET",
    "buried": "MET",
    "ocr_noised": "MET",
    "removed": "INSUFFICIENT",
    "negated": "INSUFFICIENT",
    "contradicted": "NOT_MET",
    "wrong_date_window": "INSUFFICIENT",
}
REPORT_TYPES = {"imaging_report", "sleep_study", "report", "visual_field", "photo"}
ORDER_TYPES = {"order", "supplier_note", "procedure_plan"}

FILLER = [
    "Review of systems: Constitutional negative for fever, chills or unintended weight loss. Eyes negative for "  # noqa: E501
    "acute vision change. Cardiovascular negative for chest pain or palpitations. Respiratory negative for cough.",  # noqa: E501
    "Medication reconciliation completed with the patient; the list was reviewed line by line and no changes "
    "were made today other than as noted in the plan. Allergies reviewed: no known drug allergies.",
    "Social history: lives with spouse in a single-story home, retired, walks the dog daily when able. "
    "Former smoker, quit more than ten years ago. Alcohol: one to two drinks per week.",
    "Family history non-contributory for the current complaint. Health maintenance: influenza vaccine up to "
    "date; colon cancer screening discussed and patient will schedule.",
    "Patient education provided regarding diagnosis, expected course and warning signs that should prompt "
    "earlier return. Patient verbalized understanding and agreement with the plan of care.",
]


@dataclass
class LeafPlan:
    criterion_id: str  # qualified id
    leaf_id: str
    policy_key: str
    variant: str
    expected: set[str]
    primary: str
    inserted_text: str | None = None
    note_date: date | None = None
    doc_title: str | None = None


@dataclass
class SyntheticCase:
    case_key: str
    patient: SyntheticPatient
    trees: list[CriteriaTree]
    date_of_service: date
    documents: list[dict] = field(default_factory=list)  # {kind, title, note_date, text}
    plan: list[LeafPlan] = field(default_factory=list)
    expected_tree_verdict: str = "INSUFFICIENT"
    expected_readiness: str = "gaps"

    def truth(self) -> dict[str, LeafPlan]:
        return {p.criterion_id: p for p in self.plan}


def ocr_noise(text: str, rng: random.Random) -> str:
    subs = [("rn", "m"), ("cl", "d"), (" the ", " tbe "), ("li", "Ii"), (", ", " , "), (";", ":")]
    out = text
    for a, b in subs:
        if a in out and rng.random() < 0.7:
            out = out.replace(a, b, 1)
    return re.sub(r"  +", " ", out)


def _snippet(leaf: CriterionLeaf, variant: str, rng: random.Random) -> tuple[str | None, str]:
    """Return (template, effective_variant) — falls back when the leaf has no hint for a variant."""
    hints = leaf.synthetic
    present = (hints.present if hints else []) or [
        f"{{date}}: Documented: {leaf.text[0].lower() + leaf.text[1:]}."
    ]
    pick = {
        "present": present,
        "buried": present,
        "ocr_noised": present,
        "wrong_date_window": present,
        "paraphrased": (hints.paraphrased if hints else []) or present,
        "negated": (hints.negated if hints else []),
        "contradicted": (hints.contradicted if hints else []),
    }.get(variant, [])
    if variant == "removed":
        return None, "removed"
    if not pick:
        return None, "removed"
    if variant == "wrong_date_window" and not leaf.lookback_days:
        return None, "removed"
    return rng.choice(pick), variant


def build_case(
    trees: list[CriteriaTree],
    patient: SyntheticPatient,
    *,
    seed: int | str,
    date_of_service: date,
    variants: dict[str, str] | None = None,
    default_variant: str = "present",
    practice: str = "Riverbend Orthopedics & Spine",
    clinician: str = "Sam Whitfield, MD",
) -> SyntheticCase:
    """`variants` maps a qualified criterion id (e.g. "L33718:C2") or bare leaf id to a variant name."""
    rng = random.Random(f"case:{seed}")  # noqa: S311
    variants = variants or {}
    case = SyntheticCase(case_key=str(seed), patient=patient, trees=trees, date_of_service=date_of_service)
    main_lines: list[str] = []
    report_lines: list[tuple[str, date]] = []
    order_lines: list[tuple[str, date]] = []
    buried_lines: list[str] = []
    verdicts: dict[str, Verdict] = {}

    for tree in trees:
        alternates = _secondary_alternatives(tree.root)
        for _path, leaf in iter_leaves_with_path(tree.root):
            qid = qualified_id(tree.policy_key, leaf.id)
            fallback = (
                "removed" if leaf.id in alternates and default_variant == "present" else default_variant
            )
            requested = variants.get(qid) or variants.get(leaf.id) or fallback
            template, variant = _snippet(leaf, requested, rng)
            plan = LeafPlan(
                criterion_id=qid,
                leaf_id=leaf.id,
                policy_key=tree.policy_key,
                variant=variant,
                expected=EXPECTED[variant],
                primary=PRIMARY[variant],
            )
            if template is not None:
                if variant == "wrong_date_window":
                    nd = date_of_service - timedelta(days=(leaf.lookback_days or 365) + rng.randint(30, 120))
                else:
                    nd = date_of_service - timedelta(days=rng.randint(7, 75))
                body = template.replace("{date}: ", "").replace("{date}", "").strip()
                if variant == "ocr_noised":
                    body = ocr_noise(body, rng)
                line = f"{nd.strftime('%m/%d/%Y')}: {body}"
                plan.inserted_text, plan.note_date = body, nd
                kinds = set(leaf.evidence_type)
                if variant == "buried":
                    buried_lines.append(line)
                    plan.doc_title = "Comprehensive visit note"
                elif kinds & REPORT_TYPES:
                    report_lines.append((line, nd))
                    plan.doc_title = "Diagnostic report"
                elif kinds & ORDER_TYPES:
                    order_lines.append((line, nd))
                    plan.doc_title = "Orders & supplier records"
                else:
                    main_lines.append(line)
                    plan.doc_title = "Progress note"
            case.plan.append(plan)
            verdicts[qid] = Verdict(plan.primary)

    def header(title: str, d: date) -> str:
        return (
            f"{practice} — {title}\nPatient: {patient.full_name}    DOB: {patient.dob.strftime('%m/%d/%Y')}    "  # noqa: E501
            f"MRN: {patient.mrn}\nDate of service: {d.strftime('%m/%d/%Y')}    Clinician: {clinician}\n"
        )

    visit = date_of_service - timedelta(days=rng.randint(3, 6))
    if main_lines or not (report_lines or order_lines or buried_lines):
        cc = trees[0].scope or trees[0].title if trees else "follow-up"
        text = (
            header("Progress Note", visit)
            + (
                f"Chief complaint: Follow-up regarding {cc.lower()}.\n"
                "HPI:\n" + "\n".join(main_lines or ["Patient seen for follow-up; see plan."]) + "\n"
                "Assessment and plan:\nFindings reviewed with the patient. Documentation assembled for prior authorization "  # noqa: E501
                "of the requested service. Return after the procedure or sooner if symptoms worsen.\n"
            )
        )
        case.documents.append(
            {"kind": "clinical_note", "title": "Progress note", "note_date": visit, "text": text}
        )
    if report_lines:
        d = max(x[1] for x in report_lines)
        text = header("Diagnostic Report", d) + "Findings:\n" + "\n".join(x[0] for x in report_lines) + "\n"
        case.documents.append(
            {"kind": "imaging_report", "title": "Diagnostic report", "note_date": d, "text": text}
        )
    if order_lines:
        d = max(x[1] for x in order_lines)
        text = (
            header("Orders & Supplier Records", d)
            + "Records:\n"
            + "\n".join(x[0] for x in order_lines)
            + "\n"
        )
        case.documents.append(
            {"kind": "other", "title": "Orders & supplier records", "note_date": d, "text": text}
        )
    if buried_lines:
        d = date_of_service - timedelta(days=rng.randint(20, 40))
        filler = list(FILLER)
        rng.shuffle(filler)
        mid = len(filler) // 2
        body = "\n".join(filler[:mid] + buried_lines + filler[mid:] + filler[:2])
        text = header("Comprehensive Visit Note", d) + "Subjective:\n" + body + "\n"
        case.documents.append(
            {"kind": "clinical_note", "title": "Comprehensive visit note", "note_date": d, "text": text}
        )

    results = [
        evaluate_tree(
            t.root, {k.split(":", 1)[1]: v for k, v in verdicts.items() if k.split(":", 1)[0] == t.policy_key}
        )
        for t in trees
    ]
    from app.ai.compiler.logic import combine_policies

    root = combine_policies(results)
    case.expected_tree_verdict = root.verdict.value
    case.expected_readiness = readiness_of(root).value
    return case


def _secondary_alternatives(node) -> set[str]:
    """Leaf ids under non-primary branches of OR / N_OF_M nodes (a realistic chart documents one path)."""
    from app.ai.compiler.schema import CriteriaNode, iter_leaves

    out: set[str] = set()
    if not isinstance(node, CriteriaNode):
        return out
    keep = (
        1
        if node.op == "OR"
        else (node.n or len(node.children))
        if node.op == "N_OF_M"
        else len(node.children)
    )
    for i, child in enumerate(node.children):
        if i >= keep:
            out |= {leaf.id for leaf in iter_leaves(child)}
        else:
            out |= _secondary_alternatives(child)
    return out


_PENDING = re.compile(
    r"\b(pending|not yet|not been obtained|not performed|referral placed|not taken|no results)\b", re.I
)


class OracleJudge:
    """Scripted judge for demo seeding and pipeline tests: it 'knows' which synthetic sentence documents
    which criterion, so the full graph (retrieval → judge → verification → aggregation) runs offline
    with realistic, verifiable outputs. Never used for real data."""

    def __init__(self) -> None:
        self.truth: dict[str, list[tuple[str, str]]] = {}  # criterion text → [(inserted text, variant)]
        self.hallucinate: set[str] = set()  # criterion texts for which the oracle invents a quote

    def add_case(self, case: SyntheticCase) -> None:
        texts = {}
        for t in case.trees:
            for _p, leaf in iter_leaves_with_path(t.root):
                texts[qualified_id(t.policy_key, leaf.id)] = leaf.text
        for p in case.plan:
            if p.inserted_text:
                self.truth.setdefault(normalize_for_match(texts[p.criterion_id]), []).append(
                    (p.inserted_text, p.variant)
                )

    def judge(self, messages: list[dict], _model=None) -> dict:
        prompt = "\n".join(str(m.get("content", "")) for m in messages)
        m = re.search(r"<criterion[^>]*>\s*(.*?)\s*</criterion>", prompt, re.S)
        crit = normalize_for_match(m.group(1)) if m else ""
        excerpts = re.findall(r'<excerpt chunkId="([^"]+)"[^>]*>\n(.*?)\n</excerpt>', prompt, re.S)
        if crit in self.hallucinate and excerpts:
            return {
                "verdict": "MET",
                "evidence": [
                    {"chunkId": excerpts[0][0], "quote": "Patient meets every requirement of this policy."}
                ],
                "rationale": "Invented support.",
                "confidence": 0.95,
            }
        for text, variant in self.truth.get(crit, []):
            nt = normalize_for_match(text)
            for cid, body in excerpts:
                if nt[:60] and nt[:60] in normalize_for_match(body):
                    quote = _verbatim(text, body)
                    if variant in {"present", "paraphrased", "buried", "ocr_noised"}:
                        return {
                            "verdict": "MET",
                            "evidence": [{"chunkId": cid, "quote": quote}],
                            "rationale": "The excerpt explicitly documents this requirement.",
                            "confidence": 0.9,
                        }
                    if variant == "negated" and _PENDING.search(text):
                        return {
                            "verdict": "INSUFFICIENT",
                            "evidence": [{"chunkId": cid, "quote": quote}],
                            "rationale": "The chart says this is pending / not yet done.",
                            "confidence": 0.8,
                        }
                    if variant in {"contradicted", "negated"}:
                        return {
                            "verdict": "NOT_MET",
                            "evidence": [{"chunkId": cid, "quote": quote}],
                            "rationale": "The excerpt documents that this requirement is not satisfied.",
                            "confidence": 0.85,
                        }
        return {
            "verdict": "INSUFFICIENT",
            "evidence": [],
            "rationale": "None of the excerpts explicitly address this criterion.",
            "confidence": 0.75,
        }

    @staticmethod
    def verify(_messages: list[dict], _model=None) -> dict:
        return {"label": "entails", "reason": "Quoted text directly states the finding."}

    def install(self, router) -> None:
        router.register("case.judge", self.judge)
        router.register("case.verify", self.verify)


def _verbatim(text: str, body: str) -> str:
    """Return the exact span of `body` that matches `text` (case/whitespace-insensitive)."""
    from app.ai.compiler.text import find_quote

    ok, s, e = find_quote(text[:280], body)
    if ok:
        return body[s:e]
    ok, s, e = find_quote(text[:120], body)
    return body[s:e] if ok else text[:200]
