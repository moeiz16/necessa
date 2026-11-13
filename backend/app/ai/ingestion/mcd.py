"""CMS Medicare Coverage Database (MCD) CSV export parser.

Reads the weekly `current_lcd`, `current_article` and `ncd` CSV exports (UTF-8, HTML inside fields)
into normalized `ParsedDoc`s. Link tables contain rows for *older* versions too, so every join is
pinned to the document's current version (falling back to its highest listed version).

Licensing: HCPCS Level II and ICD-10 descriptions are public domain. CPT® descriptors (5-digit
numeric / Category II-III codes) are AMA content: they are kept in the local `policy_codes` table for
the licensed user's own lookups, but are NEVER written into chunk text that may reach an LLM.
"""

from __future__ import annotations

import csv
import re
import sys
from collections import defaultdict
from collections.abc import Iterable, Iterator
from dataclasses import dataclass, field
from datetime import UTC, date, datetime
from pathlib import Path

import structlog

from app.ai.ingestion.html import html_to_text
from app.ai.ingestion.scope import FOCUS_KEYWORDS, code_in_focus
from app.ai.textutil import sha256_hex

log = structlog.get_logger(__name__)
csv.field_size_limit(sys.maxsize)

MCD_VIEW = "https://www.cms.gov/medicare-coverage-database/view"
_CPT = re.compile(r"^(\d{5}|\d{4}[FTU])$")


def is_cpt(code: str) -> bool:
    return bool(_CPT.match(code.strip().upper()))


@dataclass
class ParsedSection:
    key: str
    title: str
    text: str


@dataclass
class ParsedCode:
    system: str
    code: str
    group_no: int
    description: str | None
    is_range: bool = False


@dataclass
class ParsedDoc:
    source: str  # lcd|article|ncd|payer
    source_key: str
    cms_id: int | None
    version: int
    title: str
    doc_type: str
    status: str
    effective_from: date | None
    effective_to: date | None
    retired_at: date | None
    last_updated: datetime | None
    url: str | None
    keywords: str | None = None
    sections: list[ParsedSection] = field(default_factory=list)
    codes: list[ParsedCode] = field(default_factory=list)
    code_groups: list[tuple[str, int, str]] = field(default_factory=list)
    contractors: list[tuple[int, int, int]] = field(default_factory=list)  # (id, type_id, version)
    primary_state_ids: list[int] = field(default_factory=list)
    national: bool = False
    links: list[tuple[str, str, dict]] = field(default_factory=list)  # (to_source_key, relation, meta)
    raw: dict = field(default_factory=dict)
    org_id: str | None = None

    def content_hash(self) -> str:
        parts = [self.title, str(self.version), str(self.effective_from), str(self.effective_to), self.status]
        parts += [f"{s.key}:{s.text}" for s in self.sections]
        parts += sorted(f"{c.system}:{c.code}:{c.group_no}" for c in self.codes)
        return sha256_hex(*parts)


@dataclass
class ContractorRow:
    id: int
    type_id: int
    version: int
    name: str
    number: str | None
    type_label: str | None
    url: str | None
    dmerc_region: str | None


def parse_date(s: str | None) -> date | None:
    if not s or not s.strip():
        return None
    try:
        return datetime.strptime(s.strip()[:10], "%Y-%m-%d").date()
    except ValueError:
        return None


def parse_dt(s: str | None) -> datetime | None:
    if not s or not s.strip():
        return None
    for fmt in ("%Y-%m-%d %H:%M:%S.%f", "%Y-%m-%d %H:%M:%S"):
        try:
            return datetime.strptime(s.strip(), fmt).replace(tzinfo=UTC)
        except ValueError:
            continue
    return None


def _int(s: str | None, default: int = 0) -> int:
    try:
        return int(str(s).strip())
    except (TypeError, ValueError):
        return default


def _status(raw_status: str, eff: date | None, retired: date | None, end: date | None) -> str:
    today = date.today()
    if retired and retired <= today:
        return "retired"
    if end and end < today:
        return "retired"
    if raw_status.strip().upper() == "P" or (eff and eff > today):
        return "future"
    return "active"


class MCDReader:
    """Streaming reader over an extracted MCD export directory (data/raw)."""

    def __init__(self, raw_dir: Path) -> None:
        self.raw = Path(raw_dir)
        self.lcd_dir = self.raw / "current_lcd" / "csv"
        self.art_dir = self.raw / "current_article" / "csv"
        self.ncd_dir = self.raw / "ncd" / "csv"

    def available(self) -> bool:
        return (self.lcd_dir / "lcd.csv").exists() and (self.art_dir / "article.csv").exists()

    def rows(self, path: Path) -> Iterator[dict[str, str]]:
        if not path.exists():
            return
        with path.open(newline="", encoding="utf-8", errors="replace") as fh:
            yield from csv.DictReader(fh)

    # ── reference tables ────────────────────────────────────────────────────
    def states(self) -> dict[int, tuple[str, str]]:
        return {
            _int(r["state_id"]): (r["state_abbrev"].strip(), r["description"].strip())
            for r in self.rows(self.lcd_dir / "state_lookup.csv")
            if r.get("state_abbrev")
        }

    def contractors(self) -> list[ContractorRow]:
        types = {
            _int(r["contractor_type_id"]): r["description"].strip()
            for r in self.rows(self.lcd_dir / "contractor_type_lookup.csv")
        }
        regions = {
            r["region_id"]: r.get("mac_description") or r.get("description")
            for r in self.rows(self.lcd_dir / "dmerc_region_lookup.csv")
        }
        out = []
        for r in self.rows(self.lcd_dir / "contractor.csv"):
            out.append(
                ContractorRow(
                    id=_int(r["contractor_id"]),
                    type_id=_int(r["contractor_type_id"]),
                    version=_int(r["contractor_version"], 1),
                    name=r["contractor_bus_name"].strip(),
                    number=r.get("contractor_number") or None,
                    type_label=types.get(_int(r["contractor_type_id"])),
                    url=(r.get("url") or None),
                    dmerc_region=regions.get(r.get("dmerc_rgn") or "") or None,
                )
            )
        return out

    def contractor_jurisdictions(self) -> list[dict]:
        out = []
        for r in self.rows(self.lcd_dir / "contractor_jurisdiction.csv"):
            out.append(
                {
                    "contractor_id": _int(r["contractor_id"]),
                    "contractor_type_id": _int(r["contractor_type_id"]),
                    "contractor_version": _int(r["contractor_version"], 1),
                    "state_id": _int(r["state_id"]),
                    "active_date": parse_date(r.get("active_date")),
                    "term_date": parse_date(r.get("term_date")),
                }
            )
        return out


def _pin(rows: Iterable[dict], id_col: str, ver_col: str, current: dict[int, int]) -> dict[int, list[dict]]:
    """Group link rows by doc id, keeping only the doc's current version (else its max listed version)."""
    by: dict[int, dict[int, list[dict]]] = defaultdict(lambda: defaultdict(list))
    for r in rows:
        did = _int(r.get(id_col))
        if did in current:
            by[did][_int(r.get(ver_col))].append(r)
    out: dict[int, list[dict]] = {}
    for did, versions in by.items():
        cur = current[did]
        out[did] = versions.get(cur) or versions[max(versions)]
    return out


def _focus_title(title: str) -> bool:
    t = title.lower()
    return any(k in t for k in FOCUS_KEYWORDS)


class MCDParser:
    def __init__(self, reader: MCDReader) -> None:
        self.r = reader
        self.ncd_by_id: dict[int, str] = {}

    # ── NCDs ────────────────────────────────────────────────────────────────
    def ncds(self) -> list[ParsedDoc]:
        docs = []
        for row in self.r.rows(self.r.ncd_dir / "ncd_trkg.csv"):
            sect = row["NCD_mnl_sect"].strip()
            ncd_id = _int(row["NCD_id"])
            key = f"NCD-{sect}" if sect else f"NCD-ID{ncd_id}"
            self.ncd_by_id[ncd_id] = key
            eff = parse_date(row.get("NCD_efctv_dt"))
            term = parse_date(row.get("NCD_trmntn_dt"))
            ver = _int(row.get("NCD_vrsn_num"), 1)
            sections = [
                ParsedSection(
                    "item_service", "Item/Service Description", html_to_text(row.get("itm_srvc_desc"))
                ),
                ParsedSection(
                    "indication",
                    "Indications and Limitations of Coverage",
                    html_to_text(row.get("indctn_lmtn")),
                ),
                ParsedSection("cross_reference", "Cross Reference", html_to_text(row.get("xref_txt"))),
                ParsedSection("other_comments", "Other", html_to_text(row.get("othr_txt"))),
                ParsedSection(
                    "revision_history", "Transmittal and Revision History", html_to_text(row.get("rev_hstry"))
                ),
            ]
            docs.append(
                ParsedDoc(
                    source="ncd",
                    source_key=key,
                    cms_id=ncd_id,
                    version=ver,
                    title=f"{row['NCD_mnl_sect_title'].strip()} ({sect})"
                    if sect
                    else row["NCD_mnl_sect_title"].strip(),
                    doc_type="NCD",
                    status=_status("A", eff, term, None),
                    effective_from=eff,
                    effective_to=term,
                    retired_at=term,
                    last_updated=parse_dt(row.get("last_updt_tmstmp")),
                    url=f"{MCD_VIEW}/ncd.aspx?ncdid={ncd_id}&ncdver={ver}",
                    keywords=row.get("ncd_keyword") or None,
                    sections=[s for s in sections if s.text],
                    national=True,
                    raw={
                        "manualSection": sect,
                        "transmittal": row.get("trnsmtl_num"),
                        "transmittalUrl": row.get("trnsmtl_url"),
                        "underReview": row.get("under_rvw") == "True",
                    },
                )
            )
        return docs

    # ── selection ───────────────────────────────────────────────────────────
    def select(self, scope: str, policy_keys: list[str] | None = None) -> tuple[set[int], set[int]]:
        """Return (lcd_ids, article_ids) for the scope: focus | full | explicit keys."""
        lcd_rows = {(_int(r["lcd_id"])): r for r in self.r.rows(self.r.lcd_dir / "lcd.csv")}
        art_rows = {(_int(r["article_id"])): r for r in self.r.rows(self.r.art_dir / "article.csv")}
        if scope == "full" and not policy_keys:
            return set(lcd_rows), set(art_rows)
        lcd_cur = {i: _int(r["lcd_version"]) for i, r in lcd_rows.items()}
        art_cur = {i: _int(r["article_version"]) for i, r in art_rows.items()}
        lcds: set[int] = set()
        arts: set[int] = set()
        if policy_keys:
            for k in policy_keys:
                k = k.strip().upper()
                if k.startswith("L") and k[1:].isdigit():
                    lcds.add(int(k[1:]))
                elif k.startswith("A") and k[1:].isdigit():
                    arts.add(int(k[1:]))
        else:
            art_codes = _pin(
                self.r.rows(self.r.art_dir / "article_x_hcpc_code.csv"),
                "article_id",
                "article_version",
                art_cur,
            )
            for aid, rows in art_codes.items():
                if any(code_in_focus(x["hcpc_code_id"]) for x in rows):
                    arts.add(aid)
            lcd_codes = _pin(
                self.r.rows(self.r.lcd_dir / "lcd_x_hcpc_code.csv"), "lcd_id", "lcd_version", lcd_cur
            )
            for lid, rows in lcd_codes.items():
                if any(code_in_focus(x["hcpc_code_id"]) for x in rows):
                    lcds.add(lid)
            lcds |= {i for i, r in lcd_rows.items() if _focus_title(r["title"])}
            arts |= {
                i for i, r in art_rows.items() if _focus_title(r["title"]) and r["article_type"] in {"6", "1"}
            }
        # expand through related-document links (LCD <-> billing & coding article)
        art_rel = _pin(
            self.r.rows(self.r.art_dir / "article_related_documents.csv"),
            "article_id",
            "article_version",
            art_cur,
        )
        for aid in list(arts):
            for x in art_rel.get(aid, []):
                if _int(x.get("r_lcd_id")) in lcd_rows:
                    lcds.add(_int(x["r_lcd_id"]))
        lcd_rel = _pin(
            self.r.rows(self.r.lcd_dir / "lcd_related_documents.csv"), "lcd_id", "lcd_version", lcd_cur
        )
        for lid in list(lcds):
            for x in lcd_rel.get(lid, []):
                rid = _int(x.get("r_article_id"))
                if rid in art_rows and art_rows[rid]["article_type"] in {"6", "1"}:
                    arts.add(rid)
        return lcds & set(lcd_rows), arts & set(art_rows)

    # ── LCDs ────────────────────────────────────────────────────────────────
    def lcds(self, ids: set[int]) -> list[ParsedDoc]:
        rows = {
            (_int(r["lcd_id"])): r
            for r in self.r.rows(self.r.lcd_dir / "lcd.csv")
            if _int(r["lcd_id"]) in ids
        }
        cur = {i: _int(r["lcd_version"]) for i, r in rows.items()}
        d = self.r.lcd_dir
        codes = _pin(self.r.rows(d / "lcd_x_hcpc_code.csv"), "lcd_id", "lcd_version", cur)
        groups = _pin(self.r.rows(d / "lcd_x_hcpc_code_group.csv"), "lcd_id", "lcd_version", cur)
        contractors = _pin(self.r.rows(d / "lcd_x_contractor.csv"), "lcd_id", "lcd_version", cur)
        primary = _pin(self.r.rows(d / "lcd_x_primary_jurisdiction.csv"), "lcd_id", "lcd_version", cur)
        related = _pin(self.r.rows(d / "lcd_related_documents.csv"), "lcd_id", "lcd_version", cur)
        related_ncd = _pin(self.r.rows(d / "lcd_related_ncd_documents.csv"), "lcd_id", "lcd_version", cur)
        history: dict[int, list[dict]] = defaultdict(list)
        for r in self.r.rows(d / "lcd_x_revision_history.csv"):
            if _int(r["lcd_id"]) in ids:
                history[_int(r["lcd_id"])].append(r)
        docs = []
        for lid, row in rows.items():
            ver = cur[lid]
            eff = parse_date(row.get("rev_eff_date")) or parse_date(row.get("orig_det_eff_date"))
            end = parse_date(row.get("rev_end_date")) or parse_date(row.get("ent_det_end_date"))
            retired = parse_date(row.get("date_retired"))
            fields = [
                ("indication", "Coverage Indications, Limitations, and/or Medical Necessity", "indication"),
                ("cms_cov_policy", "CMS National Coverage Policy", "cms_cov_policy"),
                ("doc_reqs", "Documentation Requirements", "doc_reqs"),
                ("util_guide", "Utilization Guidelines", "util_guide"),
                ("coding_guidelines", "Coding Guidelines", "coding_guidelines"),
                ("dx_support", "ICD-10-CM Codes that Support Medical Necessity", "diagnoses_support"),
                (
                    "dx_nonsupport",
                    "ICD-10-CM Codes that DO NOT Support Medical Necessity",
                    "diagnoses_dont_support",
                ),
                ("associated_info", "Associated Information", "associated_info"),
                ("summary_of_evidence", "Summary of Evidence", "summary_of_evidence"),
                (
                    "analysis_of_evidence",
                    "Analysis of Evidence (Rationale for Determination)",
                    "analysis_of_evidence",
                ),
                ("appendices", "Appendices", "appendices"),
                ("source_info", "Sources of Information", "source_info"),
                ("bibliography", "Bibliography", "bibliography"),
                ("synopsis_changes", "Synopsis of Changes", "synopsis_changes"),
            ]
            sections = [ParsedSection(k, t, html_to_text(row.get(col))) for k, t, col in fields]
            code_list = [
                ParsedCode(
                    "HCPCS",
                    x["hcpc_code_id"].strip().upper(),
                    _int(x.get("hcpc_code_group")),
                    (x.get("long_description") or x.get("short_description") or "").strip() or None,
                    x.get("range", "N") not in {"N", ""},
                )
                for x in codes.get(lid, [])
            ]
            grp = [
                ("HCPCS", _int(x["hcpc_code_group"]), html_to_text(x.get("paragraph")))
                for x in groups.get(lid, [])
            ]
            sections.append(_code_group_section(grp, code_list))
            sections.append(_history_section(history.get(lid, [])))
            links: list[tuple[str, str, dict]] = []
            for x in related.get(lid, []):
                if _int(x.get("r_article_id")):
                    links.append(
                        (
                            f"A{_int(x['r_article_id'])}",
                            "lcd_article",
                            {"version": _int(x.get("r_article_version"))},
                        )
                    )
                elif _int(x.get("r_lcd_id")):
                    links.append((f"L{_int(x['r_lcd_id'])}", "related", {}))
            for x in related_ncd.get(lid, []):
                key = self.ncd_by_id.get(_int(x.get("r_ncd_id")))
                if key:
                    links.append((key, "lcd_ncd", {}))
            docs.append(
                ParsedDoc(
                    source="lcd",
                    source_key=f"L{lid}",
                    cms_id=lid,
                    version=ver,
                    title=row["title"].strip(),
                    doc_type="LCD",
                    status=_status(row.get("status", "A"), eff, retired, end),
                    effective_from=eff,
                    effective_to=end,
                    retired_at=retired,
                    last_updated=parse_dt(row.get("last_updated")),
                    url=f"{MCD_VIEW}/lcd.aspx?lcdid={lid}&ver={ver}",
                    keywords=row.get("keywords") or None,
                    sections=[s for s in sections if s.text],
                    codes=code_list,
                    code_groups=grp,
                    contractors=[
                        (
                            _int(x["contractor_id"]),
                            _int(x["contractor_type_id"]),
                            _int(x["contractor_version"], 1),
                        )
                        for x in contractors.get(lid, [])
                    ],
                    primary_state_ids=[_int(x["state_id"]) for x in primary.get(lid, [])],
                    links=links,
                    raw={
                        "determinationNumber": row.get("determination_number") or None,
                        "originalEffective": row.get("orig_det_eff_date", "")[:10] or None,
                        "lastReviewed": row.get("last_reviewed_on", "")[:10] or None,
                        "sourceLcdId": row.get("source_lcd_id") or None,
                        "macInitiated": row.get("mac_initiated"),
                    },
                )
            )
        return docs

    # ── Articles ────────────────────────────────────────────────────────────
    def articles(self, ids: set[int]) -> list[ParsedDoc]:
        d = self.r.art_dir
        types = {
            r["article_type_id"]: r["description"].strip() for r in self.r.rows(d / "article_type_lookup.csv")
        }
        rows = {
            _int(r["article_id"]): r for r in self.r.rows(d / "article.csv") if _int(r["article_id"]) in ids
        }
        cur = {i: _int(r["article_version"]) for i, r in rows.items()}
        hcpcs = _pin(self.r.rows(d / "article_x_hcpc_code.csv"), "article_id", "article_version", cur)
        hgroups = _pin(self.r.rows(d / "article_x_hcpc_code_group.csv"), "article_id", "article_version", cur)
        icd_cov = _pin(self.r.rows(d / "article_x_icd10_covered.csv"), "article_id", "article_version", cur)
        icd_cov_g = _pin(
            self.r.rows(d / "article_x_icd10_covered_group.csv"), "article_id", "article_version", cur
        )
        icd_non = _pin(
            self.r.rows(d / "article_x_icd10_noncovered.csv"), "article_id", "article_version", cur
        )
        icd_non_g = _pin(
            self.r.rows(d / "article_x_icd10_noncovered_group.csv"), "article_id", "article_version", cur
        )
        pcs = _pin(self.r.rows(d / "article_x_icd10_pcs_code.csv"), "article_id", "article_version", cur)
        bill = _pin(self.r.rows(d / "article_x_bill_code.csv"), "article_id", "article_version", cur)
        rev = _pin(self.r.rows(d / "article_x_revenue_code.csv"), "article_id", "article_version", cur)
        contractors = _pin(self.r.rows(d / "article_x_contractor.csv"), "article_id", "article_version", cur)
        related = _pin(self.r.rows(d / "article_related_documents.csv"), "article_id", "article_version", cur)
        related_ncd = _pin(
            self.r.rows(d / "article_related_ncd_documents.csv"), "article_id", "article_version", cur
        )
        history: dict[int, list[dict]] = defaultdict(list)
        for r in self.r.rows(d / "article_x_revision_history.csv"):
            if _int(r["article_id"]) in ids:
                history[_int(r["article_id"])].append(r)
        docs = []
        for aid, row in rows.items():
            ver = cur[aid]
            eff = parse_date(row.get("article_eff_date"))
            end = parse_date(row.get("article_end_date")) or parse_date(row.get("article_rev_end_date"))
            retired = parse_date(row.get("date_retired"))
            codes: list[ParsedCode] = []
            codes += [
                ParsedCode(
                    "HCPCS",
                    x["hcpc_code_id"].strip().upper(),
                    _int(x.get("hcpc_code_group")),
                    (x.get("long_description") or x.get("short_description") or "").strip() or None,
                    x.get("range", "N") not in {"N", ""},
                )
                for x in hcpcs.get(aid, [])
            ]
            codes += [
                ParsedCode(
                    "ICD10_COVERED",
                    x["icd10_code_id"].strip().upper(),
                    _int(x.get("icd10_covered_group")),
                    (x.get("description") or "").strip() or None,
                    x.get("range", "N") not in {"N", ""},
                )
                for x in icd_cov.get(aid, [])
            ]
            codes += [
                ParsedCode(
                    "ICD10_NONCOVERED",
                    x["icd10_code_id"].strip().upper(),
                    _int(x.get("icd10_noncovered_group")),
                    (x.get("description") or "").strip() or None,
                    x.get("range", "N") not in {"N", ""},
                )
                for x in icd_non.get(aid, [])
            ]
            codes += [
                ParsedCode(
                    "ICD10_PCS",
                    x["icd10_pcs_code_id"].strip().upper(),
                    _int(x.get("icd10_pcs_code_group")),
                    (x.get("description") or "").strip() or None,
                )
                for x in pcs.get(aid, [])
            ]
            codes += [
                ParsedCode(
                    "BILL_TYPE", x["bill_code_id"].strip(), 0, (x.get("description") or "").strip() or None
                )
                for x in bill.get(aid, [])
            ]
            codes += [
                ParsedCode(
                    "REVENUE", x["revenue_code_id"].strip(), 0, (x.get("description") or "").strip() or None
                )
                for x in rev.get(aid, [])
            ]
            groups = [
                ("HCPCS", _int(x["hcpc_code_group"]), html_to_text(x.get("paragraph")))
                for x in hgroups.get(aid, [])
            ]
            groups += [
                ("ICD10_COVERED", _int(x["icd10_covered_group"]), html_to_text(x.get("paragraph")))
                for x in icd_cov_g.get(aid, [])
            ]
            groups += [
                ("ICD10_NONCOVERED", _int(x["icd10_noncovered_group"]), html_to_text(x.get("paragraph")))
                for x in icd_non_g.get(aid, [])
            ]
            sections = [
                ParsedSection("description", "Article Guidance", html_to_text(row.get("description"))),
                ParsedSection(
                    "cms_cov_policy", "CMS National Coverage Policy", html_to_text(row.get("cms_cov_policy"))
                ),
                ParsedSection("other_comments", "Other Comments", html_to_text(row.get("other_comments"))),
                ParsedSection(
                    "icd10_info", "Additional ICD-10 Information", html_to_text(row.get("add_icd10_info"))
                ),
                _code_group_section(
                    [g for g in groups if g[0] == "HCPCS"], [c for c in codes if c.system == "HCPCS"]
                ),
                _dx_group_section(groups, codes),
                _history_section(history.get(aid, [])),
            ]
            links: list[tuple[str, str, dict]] = []
            for x in related.get(aid, []):
                if _int(x.get("r_lcd_id")):
                    links.append(
                        (f"L{_int(x['r_lcd_id'])}", "article_lcd", {"version": _int(x.get("r_lcd_version"))})
                    )
                elif _int(x.get("r_article_id")):
                    links.append((f"A{_int(x['r_article_id'])}", "related", {}))
            for x in related_ncd.get(aid, []):
                key = self.ncd_by_id.get(_int(x.get("r_ncd_id")))
                if key:
                    links.append((key, "article_ncd", {}))
            docs.append(
                ParsedDoc(
                    source="article",
                    source_key=f"A{aid}",
                    cms_id=aid,
                    version=ver,
                    title=row["title"].strip(),
                    doc_type=types.get(row.get("article_type", ""), "Article"),
                    status=_status(row.get("status", "A"), eff, retired, end),
                    effective_from=eff,
                    effective_to=end,
                    retired_at=retired,
                    last_updated=parse_dt(row.get("last_updated")),
                    url=f"{MCD_VIEW}/article.aspx?articleid={aid}&ver={ver}",
                    keywords=row.get("keywords") or None,
                    sections=[s for s in sections if s.text],
                    codes=codes,
                    code_groups=groups,
                    contractors=[
                        (
                            _int(x["contractor_id"]),
                            _int(x["contractor_type_id"]),
                            _int(x["contractor_version"], 1),
                        )
                        for x in contractors.get(aid, [])
                    ],
                    links=links,
                    raw={
                        "articleType": row.get("article_type"),
                        "sourceArticleId": row.get("source_article_id") or None,
                        "publishedOn": row.get("article_pub_date", "")[:10] or None,
                    },
                )
            )
        return docs


def _code_list_line(codes: list[ParsedCode]) -> str:
    """HCPCS Level II with (public-domain) descriptions; CPT as numbers only (AMA licensing)."""
    parts = []
    for c in codes[:400]:
        if is_cpt(c.code) or not c.description:
            parts.append(f"{c.code}")
        else:
            parts.append(f"{c.code} ({c.description.title()[:90]})")
    return "; ".join(parts)


def _code_group_section(groups: list[tuple[str, int, str]], codes: list[ParsedCode]) -> ParsedSection:
    by_group: dict[int, list[ParsedCode]] = defaultdict(list)
    for c in codes:
        by_group[c.group_no].append(c)
    lines = []
    for g in sorted({*by_group, *[x[1] for x in groups]}):
        para = next((p for s, n, p in groups if n == g and s == "HCPCS" and p), "")
        listed = _code_list_line(by_group.get(g, []))
        if para or listed:
            lines.append(f"Group {g}: {para}".strip() + (f"\nCodes: {listed}" if listed else ""))
    return ParsedSection("code_groups", "CPT/HCPCS Codes", "\n\n".join(lines))


def _dx_group_section(groups: list[tuple[str, int, str]], codes: list[ParsedCode]) -> ParsedSection:
    lines = []
    for system, label in (("ICD10_COVERED", "covered"), ("ICD10_NONCOVERED", "non-covered")):
        counts: dict[int, int] = defaultdict(int)
        for c in codes:
            if c.system == system:
                counts[c.group_no] += 1
        for g in sorted({*counts, *[n for s, n, _ in groups if s == system]}):
            para = next((p for s, n, p in groups if s == system and n == g and p), "")
            if para or counts.get(g):
                lines.append(f"ICD-10-CM {label} group {g} ({counts.get(g, 0)} codes): {para}".strip())
    return ParsedSection("dx_support", "ICD-10-CM Codes (Covered / Non-Covered)", "\n\n".join(lines))


def _history_section(rows: list[dict]) -> ParsedSection:
    rows = sorted(rows, key=lambda r: (_int(r.get("rev_hist_num")), r.get("rev_hist_date", "")))
    lines = []
    for r in rows[-25:]:
        txt = html_to_text(r.get("rev_hist_exp"))
        if txt:
            lines.append(f"{(r.get('rev_hist_date') or '')[:10]} (rev {r.get('rev_hist_num')}): {txt}")
    return ParsedSection("revision_history", "Revision History", "\n".join(lines))


def parse_mcd(
    raw_dir: Path, scope: str = "focus", policy_keys: list[str] | None = None, limit: int | None = None
) -> tuple[list[ParsedDoc], MCDReader]:
    reader = MCDReader(raw_dir)
    if not reader.available():
        raise FileNotFoundError(f"MCD CSV exports not found under {raw_dir} — run `necessa ingest download`")
    p = MCDParser(reader)
    ncds = p.ncds()
    lcd_ids, art_ids = p.select(scope, policy_keys)
    if limit:
        lcd_ids = set(sorted(lcd_ids)[:limit])
        art_ids = set(sorted(art_ids)[: limit * 2])
    docs = ncds + p.lcds(lcd_ids) + p.articles(art_ids)
    log.info("mcd.parsed", scope=scope, ncds=len(ncds), lcds=len(lcd_ids), articles=len(art_ids))
    return docs, reader
