"""Rule-based PHI de-identification (no ML models — zero RAM footprint).

Strategy (defense in depth):
1. **Known identifiers first.** At intake we *know* the patient's name, DOB, MRN, member ID,
   address, phone from the FHIR Patient resource / case form, so exact (case-insensitive,
   whole-word) replacement is far more reliable than NER.
2. **Pattern recognizers** for the HIPAA Safe Harbor identifier families that appear in notes:
   SSN, Medicare Beneficiary Identifier (MBI), labelled MRN / member / subscriber IDs, NPI, phone,
   fax, email, URLs, street addresses, ZIP (only when anchored to a state — bare 5-digit numbers
   are usually CPT codes!), names after titles (Mr./Ms./Dr./Patient:), labelled DOB.
3. **Dates are shifted, not destroyed**, by a deterministic per-patient offset so clinical
   intervals ("PT for 6 weeks", "imaging within 60 days") survive for criterion judging. DOB is
   always tokenized; ages ≥ 90 are generalized to "90+".

Tokens are consistent within a document (`[PATIENT_NAME_1]`), and `replacements` lets the
drafting step re-hydrate output locally so PHI never needs to leave the trust boundary.
"""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta

MONTHS = (
    "January|February|March|April|May|June|July|August|September|October|November|December|"
    "Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec"
)

RE_SSN = re.compile(r"\b(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}\b")
RE_MBI = re.compile(
    r"\b[1-9][AC-HJKMNP-RT-Yac-hjkmnp-rt-y][AC-HJKMNP-RT-Yac-hjkmnp-rt-y0-9]\d"
    r"[AC-HJKMNP-RT-Yac-hjkmnp-rt-y][AC-HJKMNP-RT-Yac-hjkmnp-rt-y0-9]\d"
    r"[AC-HJKMNP-RT-Yac-hjkmnp-rt-y]{2}\d{2}\b"
)
RE_LABELLED_ID = re.compile(
    r"\b(MRN|Medical Record(?: Number| No\.?| #)?|Member(?: ID| #| Number)|Subscriber(?: ID| #)|"
    r"Policy(?: No\.?| Number| #)|Account(?: No\.?| Number| #)|Patient ID|Claim(?: No\.?| Number| #))"
    r"\s*[:#]?\s*([A-Z0-9][A-Z0-9\-]{4,})",
    re.IGNORECASE,
)
RE_NPI = re.compile(r"\bNPI\s*[:#]?\s*(\d{10})\b", re.IGNORECASE)
RE_PHONE = re.compile(r"(?<!\d)(?:\+?1[\s.-]?)?\(?\b\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b")
RE_EMAIL = re.compile(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b")
RE_URL = re.compile(r"\bhttps?://[^\s<>\"]+", re.IGNORECASE)
RE_ADDRESS = re.compile(
    r"\b\d{1,6}\s+(?:[NSEW]\.?\s+)?(?:[A-Z][a-zA-Z]+\s){1,3}"
    r"(?:Street|St|Avenue|Ave|Road|Rd|Lane|Ln|Drive|Dr|Boulevard|Blvd|Court|Ct|Way|Place|Pl|Terrace|Ter|"
    r"Circle|Cir|Parkway|Pkwy|Highway|Hwy)\b\.?(?:,?\s*(?:Apt|Unit|Suite|Ste|#)\s*[A-Za-z0-9-]+)?"
)
RE_ZIP_ANCHORED = re.compile(r"\b([A-Z]{2})\s+(\d{5}(?:-\d{4})?)\b")
RE_ZIP_LABELLED = re.compile(r"\b(?:ZIP|Zip Code|Postal Code)\s*[:#]?\s*(\d{5}(?:-\d{4})?)\b", re.IGNORECASE)
RE_TITLED_NAME = re.compile(
    r"\b(Mr|Mrs|Ms|Miss|Mx|Dr|Patient|Pt|Name|Spouse|Wife|Husband|Daughter|Son|Caregiver)\.?:?\s+"
    r"((?:[A-Z][a-z'\-]+|[A-Z]\.)(?:\s+(?:[A-Z][a-z'\-]+|[A-Z]\.)){0,2})"
)
RE_DOB = re.compile(
    r"\b(?:DOB|D\.O\.B\.|Date of Birth|Birth ?date|Born)\s*[:#]?\s*"
    rf"((?:\d{{1,2}}[/-]\d{{1,2}}[/-]\d{{2,4}})|(?:\d{{4}}-\d{{2}}-\d{{2}})|(?:(?:{MONTHS})\.?\s+\d{{1,2}},?\s+\d{{4}}))",
    re.IGNORECASE,
)
RE_AGE_90 = re.compile(r"\b(9\d|1[0-2]\d)[\s-]*(?:year|yr)s?[\s-]*old\b", re.IGNORECASE)
RE_DATE_ISO = re.compile(r"\b(\d{4})-(\d{2})-(\d{2})\b")
RE_DATE_US = re.compile(r"\b(\d{1,2})/(\d{1,2})/(\d{4}|\d{2})\b")
RE_DATE_LONG = re.compile(rf"\b({MONTHS})\.?\s+(\d{{1,2}}),?\s+(\d{{4}})\b")

_MONTH_NUM = {
    m.lower(): i
    for i, m in enumerate(
        [
            "january",
            "february",
            "march",
            "april",
            "may",
            "june",
            "july",
            "august",
            "september",
            "october",
            "november",
            "december",
        ],
        start=1,
    )
}
_MONTH_NUM.update({k[:3]: v for k, v in list(_MONTH_NUM.items())})
_MONTH_NUM["sept"] = 9

# Words that follow a title but are not names (e.g. "Patient Reports", "Dr. Office")
_NOT_NAMES = {
    "reports",
    "report",
    "states",
    "stated",
    "denies",
    "presents",
    "presented",
    "was",
    "is",
    "has",
    "had",
    "office",
    "note",
    "notes",
    "visit",
    "history",
    "education",
    "instructions",
    "the",
    "and",
    "with",
    "tolerated",
    "underwent",
    "completed",
    "continues",
    "returns",
    "reported",
    "complains",
    "agrees",
}


@dataclass
class DeidResult:
    text: str
    replacements: dict[str, str] = field(default_factory=dict)  # token/shifted value -> original
    counts: dict[str, int] = field(default_factory=dict)

    @property
    def total(self) -> int:
        return sum(self.counts.values())


class _Tokenizer:
    def __init__(self) -> None:
        self.by_value: dict[tuple[str, str], str] = {}
        self.replacements: dict[str, str] = {}
        self.counts: dict[str, int] = {}

    def token(self, kind: str, original: str) -> str:
        key = (kind, original.strip().lower())
        if key in self.by_value:
            return self.by_value[key]
        n = sum(1 for k in self.by_value if k[0] == kind) + 1
        tok = f"[{kind}_{n}]"
        self.by_value[key] = tok
        self.replacements[tok] = original
        return tok

    def bump(self, kind: str) -> None:
        self.counts[kind] = self.counts.get(kind, 0) + 1


def _offset_days(seed: str) -> int:
    h = int(hashlib.sha256(seed.encode()).hexdigest()[:8], 16)
    return -(h % 29 + 7)  # shift back 7..35 days, deterministic per patient


class Deidentifier:
    """De-identify free text. `date_policy`: shift (default) | token | keep."""

    def __init__(self, date_policy: str = "shift") -> None:
        if date_policy not in {"shift", "token", "keep"}:
            raise ValueError("date_policy must be shift|token|keep")
        self.date_policy = date_policy

    # ── public API ──────────────────────────────────────────────────────────
    def deidentify(self, text: str, known: dict[str, str] | None = None) -> DeidResult:
        known = {k: v for k, v in (known or {}).items() if v}
        t = _Tokenizer()
        out = text or ""

        # DOB first (labelled), before generic date handling
        def _dob(m: re.Match) -> str:
            t.bump("DOB")
            return m.group(0).replace(m.group(1), t.token("DOB", m.group(1)))

        out = RE_DOB.sub(_dob, out)

        # Known identifiers (exact, whole word, case-insensitive)
        kind_map = {
            "name": "PATIENT_NAME",
            "full_name": "PATIENT_NAME",
            "first_name": "PATIENT_NAME",
            "last_name": "PATIENT_NAME",
            "dob": "DOB",
            "birth_date": "DOB",
            "mrn": "MRN",
            "member_id": "MEMBER_ID",
            "mbi": "MEMBER_ID",
            "ssn": "SSN",
            "address": "ADDRESS",
            "phone": "PHONE",
            "email": "EMAIL",
            "city": "LOCATION",
            "employer": "EMPLOYER",
            "caregiver": "PERSON",
            "relative": "PERSON",
        }
        values: list[tuple[str, str]] = []
        for k, v in known.items():
            kind = kind_map.get(k.lower(), "IDENTIFIER")
            values.append((kind, v))
            if kind == "PATIENT_NAME" and " " in v.strip():
                for part in v.split():
                    if len(part.strip(".,")) >= 3:
                        values.append(("PATIENT_NAME", part.strip(".,")))
            if kind == "DOB":
                values.extend(("DOB", alt) for alt in _date_variants(v))
        # longest first so "John Smith" wins over "John"
        for kind, v in sorted(values, key=lambda kv: -len(kv[1])):
            pat = re.compile(rf"(?<![\w\[]){re.escape(v)}(?![\w\]])", re.IGNORECASE)
            if pat.search(out):
                tok = t.token(kind, v)
                n = len(pat.findall(out))
                out = pat.sub(tok, out)
                t.counts[kind] = t.counts.get(kind, 0) + n

        patterns: list[tuple[str, re.Pattern, int]] = [
            ("SSN", RE_SSN, 0),
            ("EMAIL", RE_EMAIL, 0),
            ("URL", RE_URL, 0),
            ("MEMBER_ID", RE_MBI, 0),
            ("NPI", RE_NPI, 1),
            ("ID", RE_LABELLED_ID, 2),
            ("PHONE", RE_PHONE, 0),
            ("ADDRESS", RE_ADDRESS, 0),
            ("ZIP", RE_ZIP_LABELLED, 1),
        ]
        for kind, pat, grp in patterns:

            def _sub(m: re.Match, kind=kind, grp=grp) -> str:
                val = m.group(grp)
                if kind == "ID" and not any(ch.isdigit() for ch in val):
                    return m.group(0)
                t.bump(kind)
                tok = t.token(kind, val)
                return m.group(0).replace(val, tok) if grp else tok

            out = pat.sub(_sub, out)

        def _zip(m: re.Match) -> str:
            t.bump("ZIP")
            return f"{m.group(1)} {t.token('ZIP', m.group(2))}"

        out = RE_ZIP_ANCHORED.sub(_zip, out)

        def _name(m: re.Match) -> str:
            name = m.group(2)
            first = name.split()[0].lower().strip(".")
            if first in _NOT_NAMES or len(name) < 2:
                return m.group(0)
            title = m.group(1).lower()
            kind = "PROVIDER" if title == "dr" else "PERSON"
            t.bump(kind)
            return m.group(0).replace(name, t.token(kind, name))

        out = RE_TITLED_NAME.sub(_name, out)

        def _age(m: re.Match) -> str:
            t.bump("AGE90")
            return "90+ years old"

        out = RE_AGE_90.sub(_age, out)

        if self.date_policy != "keep":
            seed = "|".join(sorted(f"{k}={v}" for k, v in known.items())) or "anon"
            out = self._dates(out, t, _offset_days(seed))

        return DeidResult(text=out, replacements=t.replacements, counts=t.counts)

    def rehydrate(self, text: str, replacements: dict[str, str]) -> str:
        out = text or ""
        for tok, original in sorted(replacements.items(), key=lambda kv: -len(kv[0])):
            out = out.replace(tok, original)
        return out

    # ── internals ───────────────────────────────────────────────────────────
    def _dates(self, text: str, t: _Tokenizer, offset: int) -> str:
        def shift(d: date, fmt: str, original: str) -> str:
            if self.date_policy == "token":
                t.bump("DATE")
                return t.token("DATE", original)
            nd = d + timedelta(days=offset)
            if fmt == "iso":
                new = nd.isoformat()
            elif fmt == "us4":
                new = f"{nd.month:02d}/{nd.day:02d}/{nd.year}"
            elif fmt == "us2":
                new = f"{nd.month:02d}/{nd.day:02d}/{nd.year % 100:02d}"
            else:
                new = nd.strftime("%B %-d, %Y")
            if new != original:
                t.replacements[new] = original
                t.bump("DATE_SHIFTED")
            return new

        def iso(m: re.Match) -> str:
            try:
                return shift(date(int(m.group(1)), int(m.group(2)), int(m.group(3))), "iso", m.group(0))
            except ValueError:
                return m.group(0)

        def us(m: re.Match) -> str:
            y = m.group(3)
            year = int(y) + (2000 if len(y) == 2 and int(y) < 50 else 1900 if len(y) == 2 else 0)
            try:
                return shift(
                    date(year, int(m.group(1)), int(m.group(2))), "us4" if len(y) == 4 else "us2", m.group(0)
                )
            except ValueError:
                return m.group(0)

        def long(m: re.Match) -> str:
            mon = _MONTH_NUM.get(m.group(1).lower().rstrip("."))
            if not mon:
                return m.group(0)
            try:
                return shift(date(int(m.group(3)), mon, int(m.group(2))), "long", m.group(0))
            except ValueError:
                return m.group(0)

        text = RE_DATE_ISO.sub(iso, text)
        text = RE_DATE_US.sub(us, text)
        return RE_DATE_LONG.sub(long, text)


def _date_variants(value: str) -> list[str]:
    for fmt in ("%Y-%m-%d", "%m/%d/%Y", "%m/%d/%y", "%B %d, %Y"):
        try:
            d = datetime.strptime(value.strip(), fmt).date()
            break
        except ValueError:
            continue
    else:
        return []
    return list(
        {
            d.isoformat(),
            f"{d.month:02d}/{d.day:02d}/{d.year}",
            f"{d.month}/{d.day}/{d.year}",
            d.strftime("%B %-d, %Y"),
        }
        - {value}
    )


# ── High-risk residual scan (used by the LLM router as a last line of defense) ──
_HIGH_RISK = [
    ("SSN", RE_SSN),
    ("EMAIL", RE_EMAIL),
    ("MBI", RE_MBI),
    ("LABELLED_ID", RE_LABELLED_ID),
    ("DOB", RE_DOB),
    ("PHONE", RE_PHONE),
]


def detect_high_risk(text: str) -> list[str]:
    """Return identifier families still present. Ignores already-tokenized values."""
    found: list[str] = []
    for kind, pat in _HIGH_RISK:
        for m in pat.finditer(text or ""):
            val = m.group(m.lastindex or 0) if m.lastindex else m.group(0)
            if val.startswith("[") and val.endswith("]"):
                continue
            if kind == "LABELLED_ID" and not any(ch.isdigit() for ch in val):
                continue
            found.append(kind)
            break
    return found
