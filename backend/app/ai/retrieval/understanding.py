"""Query understanding — cheap first, LLM last.

normalize → abbreviation expansion → regex entity extraction (HCPCS/CPT, ICD-10, LCD/Article/NCD ids,
dates, states, payer type, doc types, section hints, clinically meaningful qualifiers) → self-query
filters. No model calls here; the router decides later whether an LLM rewrite is worth it.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import date, datetime

from app.ai.textutil import dedupe_keep_order, normalize_unicode, normalize_ws

ABBREVIATIONS: dict[str, str] = {
    "PT": "physical therapy",
    "OT": "occupational therapy",
    "ESI": "epidural steroid injection",
    "SCS": "spinal cord stimulator",
    "OSA": "obstructive sleep apnea",
    "CPAP": "continuous positive airway pressure",
    "BIPAP": "bi-level positive airway pressure",
    "BPAP": "bi-level positive airway pressure",
    "PAP": "positive airway pressure",
    "PMD": "power mobility device",
    "PWC": "power wheelchair",
    "POV": "power operated vehicle",
    "DME": "durable medical equipment",
    "DMEPOS": "durable medical equipment",
    "MRI": "magnetic resonance imaging",
    "CT": "computed tomography",
    "OA": "osteoarthritis",
    "TKA": "total knee arthroplasty",
    "LCD": "local coverage determination",
    "NCD": "national coverage determination",
    "MAC": "Medicare administrative contractor",
    "LMN": "letter of medical necessity",
    "ADL": "activities of daily living",
    "ADLS": "activities of daily living",
    "NSAID": "anti-inflammatory medication",
    "NSAIDS": "anti-inflammatory medication",
    "AHI": "apnea-hypopnea index",
    "TENS": "transcutaneous electrical nerve stimulation",
    "NMES": "neuromuscular electrical stimulation",
    "RFA": "radiofrequency ablation",
    "DOS": "date of service",
    "FFS": "fee-for-service",
    "SNS": "sacral nerve stimulation",
    "PTNS": "percutaneous tibial nerve stimulation",
    "KL": "Kellgren-Lawrence",
    "BMI": "body mass index",
    "CRPS": "complex regional pain syndrome",
    "PSG": "polysomnography",
    "HSAT": "home sleep apnea test",
    "ROM": "range of motion",
}

LAY_SYNONYMS: dict[str, str] = {
    "nerve zapper": "nerve stimulator neurostimulator",
    "bladder pacemaker": "sacral nerve stimulation",
    "back shot": "epidural steroid injection",
    "spine shot": "epidural steroid injection",
    "sleep apnea machine": "positive airway pressure device CPAP E0601",
    "breathing machine": "positive airway pressure",
    "cpap machine": "continuous positive airway pressure E0601",
    "knee scope": "knee arthroscopy",
    "scope my knee": "knee arthroscopy",
    "torn cartilage": "meniscal tear",
    "torn meniscus": "meniscal tear",
    "electric wheelchair": "power wheelchair power mobility device",
    "mobility scooter": "power operated vehicle",
    "scooter": "power operated vehicle",
    "skin graft": "skin substitute",
    "wound graft": "skin substitute",
    "eyelid surgery": "blepharoplasty",
    "droopy eyelids": "blepharoplasty ptosis",
    "fake leg": "lower limb prosthesis",
    "artificial leg": "lower limb prosthesis",
    "pain pump": "infusion pump",
    "pain stimulator": "spinal cord stimulator",
    "back stimulator": "spinal cord stimulator",
    "tens unit": "transcutaneous electrical nerve stimulator",
    "neck fusion": "cervical fusion",
    "physio": "physical therapy",
    "pinched nerve": "radiculopathy",
    "sciatica": "lumbar radiculopathy",
    "worn out knee": "osteoarthritis of the knee",
}

US_STATES: dict[str, str] = {
    "alabama": "AL",
    "alaska": "AK",
    "arizona": "AZ",
    "arkansas": "AR",
    "california": "CA",
    "colorado": "CO",
    "connecticut": "CT",
    "delaware": "DE",
    "florida": "FL",
    "georgia": "GA",
    "hawaii": "HI",
    "idaho": "ID",
    "illinois": "IL",
    "indiana": "IN",
    "iowa": "IA",
    "kansas": "KS",
    "kentucky": "KY",
    "louisiana": "LA",
    "maine": "ME",
    "maryland": "MD",
    "massachusetts": "MA",
    "michigan": "MI",
    "minnesota": "MN",
    "mississippi": "MS",
    "missouri": "MO",
    "montana": "MT",
    "nebraska": "NE",
    "nevada": "NV",
    "new hampshire": "NH",
    "new jersey": "NJ",
    "new mexico": "NM",
    "new york": "NY",
    "north carolina": "NC",
    "north dakota": "ND",
    "ohio": "OH",
    "oklahoma": "OK",
    "oregon": "OR",
    "pennsylvania": "PA",
    "rhode island": "RI",
    "south carolina": "SC",
    "south dakota": "SD",
    "tennessee": "TN",
    "texas": "TX",
    "utah": "UT",
    "vermont": "VT",
    "virginia": "VA",
    "washington": "WA",
    "west virginia": "WV",
    "wisconsin": "WI",
    "wyoming": "WY",
    "district of columbia": "DC",
    "puerto rico": "PR",
}
_ABBREV_STATES = set(US_STATES.values())
_AMBIGUOUS_STATES = {
    "IN",
    "OR",
    "ME",
    "OK",
    "PA",
    "MA",
    "DE",
    "HI",
    "ID",
    "AS",
    "CO",
    "LA",
    "MD",
    "OH",
    "MS",
    "CT",
    "PR",
    "SC",
    "NE",
    "GA",
    "AL",
}

RE_LCD = re.compile(r"\bL\s?(\d{5})\b", re.I)
RE_ARTICLE = re.compile(r"\bA\s?(\d{5})\b")
RE_NCD = re.compile(r"\bNCD[\s#:-]*(\d{2,3}\.\d{1,3}(?:\.\d{1,2})?)\b", re.I)
RE_NCD_BARE = re.compile(r"\b(?:section|manual)\s+(\d{2,3}\.\d{1,3}(?:\.\d{1,2})?)\b", re.I)
RE_HCPCS = re.compile(r"\b([A-V][0-9]{4})\b")
RE_CPT = re.compile(r"(?<![\d.])(\d{4}[0-9FTU])(?![\d.])")
RE_ICD10 = re.compile(r"\b([A-TV-Z][0-9][0-9A-Z](?:\.[0-9A-Z]{1,4})?)\b")
RE_DATE_ISO = re.compile(r"\b(\d{4})-(\d{2})-(\d{2})\b")
RE_DATE_US = re.compile(r"\b(\d{1,2})/(\d{1,2})/(\d{4})\b")
RE_AS_OF_YEAR = re.compile(r"\b(?:as of|in|during|since|effective)\s+(20\d{2}|19\d{2})\b", re.I)
RE_STATE_PREP = re.compile(r"\b(?:in|for|from)\s+([A-Z]{2})\b")

PAYER_PATTERNS = [
    ("medicare_advantage", re.compile(r"\b(medicare advantage|MA plan|part c)\b", re.I)),
    ("medicaid", re.compile(r"\bmedicaid\b", re.I)),
    (
        "commercial",
        re.compile(
            r"\b(commercial|private (?:insurance|payer|plan)|synthetic health plan|payer policy)\b", re.I
        ),
    ),
    (
        "medicare_ffs",
        re.compile(r"\b(traditional medicare|original medicare|fee[- ]for[- ]service|FFS|medicare)\b", re.I),
    ),
]
DOC_TYPE_PATTERNS = [
    ("LCD", re.compile(r"\b(LCDs?|local coverage determinations?)\b", re.I)),
    ("NCD", re.compile(r"\b(NCDs?|national coverage determinations?)\b", re.I)),
    ("Billing and Coding", re.compile(r"\b(billing and coding|billing article|coding article)\b", re.I)),
    ("Payer Policy", re.compile(r"\b(payer policy|commercial policy|medical policy)\b", re.I)),
]
SECTION_HINTS = [
    (
        "doc_reqs",
        re.compile(
            r"\b(document(?:ation|ed)?|records?|chart|notes?|what (?:do i|should i) (?:need|submit)|"
            r"submit|paperwork)\b",
            re.I,
        ),
    ),
    (
        "dx_support",
        re.compile(r"\b(covered diagnos\w*|icd-?10 codes?|diagnosis codes?|supporting diagnos\w*)\b", re.I),
    ),
    (
        "indication",
        re.compile(
            r"\b(criteria|indications?|medically necessary|medical necessity|requirements?|"
            r"eligib\w*|qualif\w*|covered when)\b",
            re.I,
        ),
    ),
    (
        "limitations",
        re.compile(r"\b(limitations?|not covered|non-?covered|exclusions?|contraindicat\w*)\b", re.I),
    ),
    ("util_guide", re.compile(r"\b(frequency|how often|utilization|per year|times a year|limits?)\b", re.I)),
    ("code_groups", re.compile(r"\b(modifiers?|billing codes?|cpt|hcpcs|procedure codes?)\b", re.I)),
    (
        "revision_history",
        re.compile(r"\b(changed?|changes|revision|revised|updated?|history|what's new)\b", re.I),
    ),
]
QUALIFIERS = re.compile(
    r"\b(with(?:out)? contrast|bilateral|unilateral|left|right|initial|replacement|repeat|"
    r"trial|permanent)\b",
    re.I,
)


@dataclass
class QueryAnalysis:
    original: str
    normalized: str
    expanded: str
    lcd_ids: list[str] = field(default_factory=list)
    article_ids: list[str] = field(default_factory=list)
    ncd_sections: list[str] = field(default_factory=list)
    hcpcs: list[str] = field(default_factory=list)
    cpt: list[str] = field(default_factory=list)
    icd10: list[str] = field(default_factory=list)
    states: list[str] = field(default_factory=list)
    dates: list[date] = field(default_factory=list)
    as_of: date | None = None
    payer_type: str | None = None
    doc_types: list[str] = field(default_factory=list)
    section_hints: list[str] = field(default_factory=list)
    qualifiers: list[str] = field(default_factory=list)
    lay_terms: list[str] = field(default_factory=list)
    abbreviations: list[str] = field(default_factory=list)
    synonym_expansion: str = ""

    @property
    def source_keys(self) -> list[str]:
        return (
            [f"L{x}" for x in self.lcd_ids]
            + [f"A{x}" for x in self.article_ids]
            + [f"NCD-{x}" for x in self.ncd_sections]
        )

    @property
    def service_codes(self) -> list[str]:
        return dedupe_keep_order(self.hcpcs + self.cpt)

    @property
    def all_codes(self) -> list[str]:
        return dedupe_keep_order(self.hcpcs + self.cpt + self.icd10)

    @property
    def has_identifiers(self) -> bool:
        return bool(self.source_keys or self.all_codes)

    def entities(self) -> dict:
        return {
            "sourceKeys": self.source_keys,
            "serviceCodes": self.service_codes,
            "icd10": self.icd10,
            "states": self.states,
            "asOf": self.as_of.isoformat() if self.as_of else None,
            "payerType": self.payer_type,
            "docTypes": self.doc_types,
            "sectionHints": self.section_hints,
            "qualifiers": self.qualifiers,
            "layTerms": self.lay_terms,
        }


def _parse_dates(text: str) -> list[date]:
    out: list[date] = []
    for m in RE_DATE_ISO.finditer(text):
        try:
            out.append(date(int(m.group(1)), int(m.group(2)), int(m.group(3))))
        except ValueError:
            pass
    for m in RE_DATE_US.finditer(text):
        try:
            out.append(datetime.strptime(m.group(0), "%m/%d/%Y").date())
        except ValueError:
            pass
    return out


def understand(text: str) -> QueryAnalysis:
    original = text or ""
    norm = normalize_ws(normalize_unicode(original))
    a = QueryAnalysis(original=original, normalized=norm, expanded=norm)

    a.lcd_ids = dedupe_keep_order(RE_LCD.findall(norm))
    a.article_ids = dedupe_keep_order(RE_ARTICLE.findall(norm))
    a.ncd_sections = dedupe_keep_order(RE_NCD.findall(norm) + RE_NCD_BARE.findall(norm))
    id_spans = " ".join(a.source_keys)
    a.hcpcs = dedupe_keep_order(
        c.upper()
        for c in RE_HCPCS.findall(norm)
        if f"L{c[1:]}" not in id_spans and f"A{c[1:]}" not in id_spans and not RE_ICD10.fullmatch(c)
    )
    a.cpt = dedupe_keep_order(RE_CPT.findall(norm))
    icd = []
    for c in RE_ICD10.findall(norm):
        cu = c.upper()
        if cu in a.hcpcs or re.fullmatch(r"[LA]\d{5}", cu):
            continue
        # ICD-10 needs a dot or 3-char category with letter start; avoid matching HCPCS like E0601
        if "." in cu or (len(cu) == 3 and cu[0].isalpha() and cu[1].isdigit()):
            icd.append(cu)
    a.icd10 = dedupe_keep_order(icd)

    low = norm.lower()
    states = [ab for name, ab in US_STATES.items() if re.search(rf"\b{name}\b", low)]
    for tok in re.findall(r"\b[A-Z]{2}\b", norm):
        if tok in _ABBREV_STATES and tok not in _AMBIGUOUS_STATES:
            states.append(tok)
    states += [m for m in RE_STATE_PREP.findall(norm) if m in _ABBREV_STATES]
    a.states = dedupe_keep_order(states)

    a.dates = _parse_dates(norm)
    m = re.search(r"\bas of\b", low)
    if a.dates and (m or "date of service" in low or "dos" in low):
        a.as_of = a.dates[0]
    elif (y := RE_AS_OF_YEAR.search(norm)) and int(y.group(1)) <= date.today().year:
        a.as_of = date(int(y.group(1)), 12, 31) if int(y.group(1)) < date.today().year else None

    for ptype, pat in PAYER_PATTERNS:
        if pat.search(norm):
            a.payer_type = ptype
            break
    a.doc_types = [dt for dt, pat in DOC_TYPE_PATTERNS if pat.search(norm)]
    a.section_hints = [k for k, pat in SECTION_HINTS if pat.search(norm)]
    a.qualifiers = dedupe_keep_order(q.lower() for q in QUALIFIERS.findall(norm))

    # abbreviation expansion (uppercase tokens only — "pt" usually means patient)
    expansions = []
    for tok in dedupe_keep_order(re.findall(r"\b[A-Z][A-Za-z]{1,6}\b", norm)):
        key = tok.upper()
        if key in ABBREVIATIONS and (tok.isupper() or key in {"BIPAP", "CPAP", "NSAIDS", "ADLS"}):
            expansions.append(ABBREVIATIONS[key])
            a.abbreviations.append(tok)
    # lay-language synonyms
    syn = []
    for lay, clinical in LAY_SYNONYMS.items():
        if re.search(rf"\b{re.escape(lay)}\b", low):
            a.lay_terms.append(lay)
            syn.append(clinical)
    a.synonym_expansion = " ".join(dedupe_keep_order(syn))
    extra = " ".join(dedupe_keep_order(expansions))
    a.expanded = f"{norm} ({extra})" if extra else norm
    return a


def expand_with_synonyms(a: QueryAnalysis) -> str:
    return f"{a.expanded} {a.synonym_expansion}".strip() if a.synonym_expansion else a.expanded
