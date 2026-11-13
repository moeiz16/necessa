# Necessa — Medical-Necessity Intelligence for Prior Authorization & Denial Appeals

> **One line:** Necessa reads insurance coverage policies and a patient's chart, tells front-office staff **exactly which coverage criteria are met, not met, or not yet documented** (with citations to both), and drafts the prior-auth letter or denial appeal. It de-identifies patient data before any model sees it, costs $0 to run, and runs a hybrid RAG pipeline (dense + sparse + full-text + text-to-SQL + graph) whose quality is enforced by evals.

| | |
|---|---|
| **Status** | v1.0: implemented (see [ARCHITECTURE.md](ARCHITECTURE.md) for the as-built design) |
| **Domain** | US healthcare revenue cycle: prior authorization (PA), medical necessity, denial appeals |
| **Run target** | Managed free tiers (Neon, Qdrant Cloud, Upstash, free LLM APIs) or a zero-signup offline mode (SQLite + embedded Qdrant). No local model inference |
| **Budget** | **$0**: open-source software and free cloud tiers; ≤ 5 GB local footprint |
| **Data in dev** | Public CMS data + synthetic patients only. **No real PHI ever** |
| **Name** | *Necessa*, from "medical **necess**ity". A web search found no product or GitHub project by this name. Re-check GitHub, the domain and the USPTO before publishing |

---

## Table of Contents
1. [Problem Statement](#1-problem-statement)
2. [Users & Jobs-to-be-Done](#2-users--jobs-to-be-done)
3. [Scope & Non-Goals](#3-scope--non-goals)
4. [Functional Requirements](#4-functional-requirements)
5. [Non-Functional Requirements](#5-non-functional-requirements)
6. [Compliance & Regulatory Requirements](#6-compliance--regulatory-requirements)
7. [Knowledge Base: Free, Public Datasets](#7-knowledge-base-free-public-datasets)
8. [Solution Overview](#8-solution-overview)
9. [Risks & Open Questions](#9-risks--open-questions)
10. [Sources](#10-sources)

---

## 1. Problem Statement

### 1.1 The pain
Before many tests, procedures, devices and drugs, the insurer must approve them in advance. This is **prior authorization**. To get approval, the provider has to prove **medical necessity**: the patient's chart must show every criterion in the insurer's coverage policy. For example: "≥ 6 weeks of failed conservative therapy, documented functional limitation, imaging within 60 days, no contraindication X."

- The **AMA's 2025 Prior Authorization Physician Survey** (fielded Dec 2025, 1,000 physicians) reports about **40 prior authorizations per physician per week**, taking about **13 hours of physician and staff time per week**. **40%** of physicians employ staff who work *exclusively* on prior auth.
- Policies are long, change often, and differ by payer, plan type, state (Medicare contractor jurisdiction) and **date of service**. Local Coverage Determinations (LCDs) are updated weekly in the CMS Medicare Coverage Database.
- Most denials and delays come from **missing or badly presented documentation**, not from the care being unnecessary. Staff find the gap only *after* a denial and then write an appeal by hand.

### 1.2 Why now (2026)
| Driver | What changed | Why it matters for Necessa |
|---|---|---|
| **CMS-0057-F** (Interoperability & Prior Authorization Final Rule) | Since **Jan 1, 2026**, impacted payers must issue expedited decisions in **72 h** and standard decisions in **7 calendar days**, and give a **specific denial reason**. A **FHIR-based Prior Authorization API** is due **Jan 1, 2027** | Faster payer clocks put pressure on providers to submit complete requests the first time. Specific denial reasons make appeals easier to automate. FHIR (HL7 Da Vinci CRD/DTR/PAS) becomes the shared format |
| **CMS WISeR Model** | Since **Jan 2026**, AI/ML-assisted prior auth applies to selected services (skin substitutes, nerve stimulators, knee arthroscopy, …) in **traditional Medicare** in 6 states (AZ, NJ, OH, OK, TX, WA). It is politically contested | Providers now face *AI-assisted reviewers*. They need documentation that is just as rigorous, which levels the field |
| **State AI laws** | Many states (e.g. WA SB 5395, IA HF 2635, AZ, CO, CA SB 1120) say AI cannot be the **sole basis** to deny a claim, and a licensed clinician must decide | It confirms the design principle: **AI assists, humans decide**. Necessa never decides coverage |

### 1.3 Who already tries to solve it, and the gap
- **Commercial tools** (e.g. Experian Health, Change Healthcare/Optum clearance tools, Solventum, Craneware medical-necessity checkers) are mostly priced and integrated for large health systems and payers. Small and mid-size practices still work through portals, PDFs and fax.
- **Open-source projects** on GitHub (e.g. *PA Navigator*, *autonomous-medical-pre-auth-agent*) are useful demos with recurring weaknesses:
  1. They ask for a **holistic yes/no** from one LLM call instead of evaluating criteria one by one.
  2. They count **absence of evidence as "met"**. The PA Navigator author reports "no contraindications documented" being marked as met.
  3. They cover **one payer** and have **no policy versioning** or date-of-service awareness.
  4. They send **PHI to cloud LLM APIs**.
  5. They have **no evaluation harness**: quality is anecdotal.

### 1.4 Problem statement (formal)
> **Front-office and revenue-cycle staff at small and mid-size US practices cannot quickly and reliably find out whether a patient's documentation satisfies the specific, version-correct coverage criteria of the applicable payer policy. As a result, requests are incomplete, payers deny avoidable claims, appeals are slow and manual, care is delayed, and staff lose many hours each week.**
>
> **Necessa** will (1) find the applicable policy for a given payer, service, diagnosis, state and date of service, (2) break that policy into atomic, machine-checkable criteria grounded in the source text, (3) find evidence for each criterion in the patient chart and judge it **met / not met / insufficient evidence** with citations, (4) report the documentation gaps before submission, and (5) draft submission and appeal letters for human review. It does this **without sending PHI off the machine**, at **$0 run cost**, and with quality measured by automated evaluation.

### 1.5 Why RAG, and why *hybrid* RAG
- **Why RAG and not fine-tuning:** policies change weekly, every answer must cite its source, and the corpus is public and versioned. Retrieval keeps knowledge fresh and auditable. Fine-tuning would freeze stale rules into model weights and cannot cite.
- **Why hybrid:** the questions take very different forms, and no single retriever handles all of them:
  - **Exact identifiers** (`L33718`, `64561`, `M17.11`): dense vectors handle these badly. Sparse/BM25 and SQL handle them well.
  - **Conceptual language** ("tried physical therapy" ≈ "completed 8 PT sessions"): dense vectors win.
  - **Structured facts** ("which LCDs in Ohio list code X", "how many of my cases failed the PT criterion"): this is relational data, so **text-to-SQL** or graph traversal answers it, not text search.
  - **Relationships** (policy → billing article → codes → contractor → state): **graph** traversal.

### 1.6 Success metrics (product)
| Metric | Target (pilot / synthetic eval) |
|---|---|
| Time to prepare a PA packet | ↓ 50% vs. manual baseline (timed task study) |
| Avoidable-denial proxy: gaps caught pre-submission on seeded-gap cases | ≥ 90% |
| **False-"met" rate** (we say met, ground truth says not met / insufficient). *North-star safety metric* | ≤ 2% |
| Reviewer override rate | Tracked; falling over time |
| Citation validity (citation points to text that supports the claim) | 100% structurally enforced; ≥ 95% semantically |

---

## 2. Users & Jobs-to-be-Done

| Persona | Job-to-be-done | Key needs |
|---|---|---|
| **PA Coordinator** (front office) | "Before I submit, tell me what's missing so it doesn't get denied." | Fast checklist, clear gaps, one-click packet |
| **Clinician** | "Draft the letter of medical necessity from my notes. I'll review and sign." | Accurate draft, cites chart, no invented facts |
| **Denials / RCM Manager** | "This got denied. Map the reason to the policy and draft the appeal." | Denial parsing, reason → criteria mapping, analytics |
| **Compliance Officer / Auditor** | "Show me who saw which PHI, what the AI suggested, and what the human decided." | Immutable audit trail, model/prompt versions, data lineage |
| **Admin / Engineer** | "Keep it running, cheap and correct." | Routing config, quotas, cache stats, eval dashboard, traces |

---

## 3. Scope & Non-Goals

**In scope (v1)**
- Medicare FFS (NCD/LCD/Billing Articles from the CMS MCD) and the CMS prior-auth service lists. Optional: **1–3 commercial payers' public medical policies** downloaded locally.
- Procedures, imaging and DME, where criteria are documentation-heavy.
- Chart input: Synthea FHIR R4 bundles, PDFs (including scanned "fax" PDFs), free text.
- English only (language is detected; non-English input is flagged).

**Non-goals (explicit)**
- ❌ Making or predicting the coverage **decision**. We output *documentation readiness*, never "approved/denied".
- ❌ Clinical diagnosis or treatment recommendations.
- ❌ Submitting to payers (stretch: export a Da Vinci PAS-style FHIR bundle; no live submission).
- ❌ Pharmacy/drug PA in v1 (different rules: formularies, step therapy, NCPDP).
- ❌ Shipping CPT descriptors or payer PDFs in the repo (licensing, see §6).
- ❌ Fine-tuning in v1 (see ADR-011; revisited only if evals plateau).

---

## 4. Functional Requirements

Priority: **M** = Must, **S** = Should, **C** = Could.

### 4.1 Knowledge ingestion & governance
| ID | Requirement | Pri |
|---|---|---|
| FR-01 | Ingest the CMS MCD downloads (NCDs, LCDs, Billing Articles, contractors/jurisdictions) **incrementally**: detect changed documents by content hash; re-index only the delta | M |
| FR-02 | Ingest code sets: ICD-10-CM, HCPCS Level II, NCCI PTP/MUE edits. Link codes ↔ articles ↔ policies | M |
| FR-03 | Ingest uploaded payer PDFs, including **scanned PDFs (OCR)**, with layout, headings and tables preserved | M |
| FR-04 | Keep **full version history**: effective dates, retirement and supersession for every policy. Answer "as of date X" | M |
| FR-05 | **Policy diff**: show what changed between versions, and alert on open cases affected by a change | S |
| FR-06 | **Criteria compilation**: turn each policy into an atomic criteria tree (AND/OR/N-of-M). Each criterion carries a **verbatim source span**. Low-agreement extractions go to a human review queue | M |
| FR-07 | Source allowlist and provenance: every chunk records origin URL/file, checksum, retrieval timestamp, parser version and embedding model version | M |

### 4.2 Case workflow
| ID | Requirement | Pri |
|---|---|---|
| FR-10 | Create a case: payer, plan type, patient state, service code(s), diagnosis code(s), date of service, chart (FHIR bundle / PDF / text) | M |
| FR-11 | **PHI detection & tokenization at intake** (names, MRN, member ID, DOB, addresses, phone, …). Raw PHI is stored encrypted; downstream stages see tokens where possible | M |
| FR-12 | **Deterministic policy resolution** (payer + code + dx + jurisdiction + date of service → policy versions). If ambiguous, ask the user; never guess | M |
| FR-13 | For **each criterion**: retrieve chart evidence, then judge it **MET / NOT_MET / INSUFFICIENT_EVIDENCE** with chart citations (document, span) and policy citations (section, span) | M |
| FR-14 | **Deterministic aggregation** of criterion verdicts using 3-valued (Kleene) logic over the criteria tree → *documentation readiness*: Ready / Gaps / Not-supported | M |
| FR-15 | **Gap report** with concrete, actionable fixes ("Add PT dates and outcome; policy §3.1 requires ≥ 6 weeks") | M |
| FR-16 | **Human-in-the-loop review**: the reviewer accepts or overrides each verdict with a reason. Overrides are logged and feed the eval set | M |
| FR-17 | Draft a **Letter of Medical Necessity / PA cover letter** using only verified facts, rendered with PHI re-inserted locally | M |
| FR-18 | **Denial intake**: parse the denial letter (reason text, CARC/RARC codes if present), map it to criteria, draft the appeal | S |
| FR-19 | Export: PDF packet, JSON, FHIR QuestionnaireResponse (DTR-like). Stretch: PAS-like Claim bundle | S |
| FR-20 | **Streaming progress**: per-criterion progress events in the UI (SSE) | M |

### 4.3 Knowledge Q&A & analytics
| ID | Requirement | Pri |
|---|---|---|
| FR-30 | Conversational **policy Q&A** with citations, follow-ups and as-of-date control | M |
| FR-31 | **Structured lookups** ("which LCDs list 64561 in Ohio?", "is M17.11 a covered dx for article A57xxx?") via SQL/graph tools | M |
| FR-32 | **Analytics in natural language** over the user's own case data ("top 5 gap criteria this month") via **safe text-to-SQL** | S |
| FR-33 | **Abstain** with "not enough evidence" when retrieval confidence is low, and say what is missing | M |

### 4.4 Platform
| ID | Requirement | Pri |
|---|---|---|
| FR-40 | AuthN (email + password with TOTP MFA, rotating sessions, API keys; OIDC-ready), RBAC roles: `owner`, `admin`, `coordinator`, `clinician`, `reviewer`, `rcm_manager`, `auditor`; multi-tenant orgs | M |
| FR-41 | **Audit trail viewer**: who, what, when, which model, prompt version and retrieved sources, per action | M |
| FR-42 | Admin console: model routing table, provider quota status, cache hit rates, eval scores, token usage | S |
| FR-43 | Feedback capture (👍/👎 + reason) on every answer and verdict | M |
| FR-44 | Public REST API (OpenAPI), idempotency keys, webhooks for case completion | S |
| FR-45 | Data retention controls: per-tenant TTL for case data, hard delete, export | S |

---

## 5. Non-Functional Requirements

Targets are for the free-tier cloud mode unless marked *(prod)*. Measured values are published by the eval harness in `eval/reports/`.

| ID | Category | Requirement / Target |
|---|---|---|
| NFR-01 | **Latency: retrieval** | Hybrid retrieval (filter + dense + sparse + fusion) p95 ≤ 250 ms; + cross-encoder rerank (40 → 8) p95 ≤ 800 ms |
| NFR-02 | **Latency: Q&A** | Time-to-first-token p95 ≤ 2.5 s on a free cloud tier; ≤ 6 s when falling back to a slower provider; cache hit ≤ 100 ms |
| NFR-03 | **Latency: case eval** | First criterion verdict streamed ≤ 10 s; full case (≈10 criteria) p95 ≤ 90 s within free-tier rate limits |
| NFR-04 | **Throughput** *(prod)* | 50 concurrent case evaluations per worker pool; horizontal scale by queue depth |
| NFR-05 | **Quality** | Policy retrieval Recall@10 ≥ 0.90, nDCG@10 ≥ 0.75; criterion verdict macro-F1 ≥ 0.85; **false-met ≤ 2%**; faithfulness ≥ 0.90; text-to-SQL execution accuracy ≥ 0.85 |
| NFR-06 | **Cost** | $0 run cost locally. Token budget ≤ 40k tokens/case and ≤ 6k/Q&A turn (enforced). Daily per-provider quota guard |
| NFR-07 | **Privacy** | **No identifiable PHI leaves the system**: only de-identified text reaches external providers, PHI-class calls without de-identification are refused by the router, logs are redacted. Verified by tests and the safety eval suite |
| NFR-08 | **Security** | OWASP ASVS L2 for web; OWASP LLM Top 10 (2025) controls (see ARCHITECTURE.md §12); MFA *(prod)*; TLS everywhere; PHI encrypted at rest |
| NFR-09 | **Availability** *(prod)* | 99.9% monthly for API; graceful degradation when LLM providers fail (local fallback, retrieval-only mode) |
| NFR-10 | **Durability** *(prod)* | RPO ≤ 15 min (Postgres WAL archiving), RTO ≤ 1 h; Qdrant snapshots daily; index is rebuildable from source |
| NFR-11 | **Scalability** | Stateless API/workers; Qdrant sharding/replication; tenant-aware partitioning; corpus target 1M+ chunks |
| NFR-12 | **Freshness** | Policy changes reflected ≤ 24 h after the CMS weekly refresh; every answer shows the policy version + effective date |
| NFR-13 | **Auditability** | 100% of AI suggestions traceable to inputs, retrieved chunk IDs, model, prompt version, parameters; tamper-evident log |
| NFR-14 | **Reproducibility** | Pinned model revisions (hash), prompt versions, index versions; same input + versions → same retrieval set |
| NFR-15 | **Maintainability** | Typed Python (mypy strict) + TS strict; ≥ 80% coverage on core logic; ADRs for decisions |
| NFR-16 | **Portability** | `make dev` brings up the full stack; works offline after models/data are downloaded |
| NFR-17 | **Accessibility** | WCAG 2.1 AA for the web UI |
| NFR-18 | **Explainability** | Every verdict shows: criterion text, policy span, chart span(s), model rationale (short), confidence |

---

## 6. Compliance & Regulatory Requirements

> Not legal advice. These are engineering requirements derived from the regulations; a compliance professional must review them before real-PHI use.

### 6.1 Regulation → requirement → implementation
| Regulation / standard | What it requires (short) | How Necessa implements it |
|---|---|---|
| **HIPAA Privacy Rule**: minimum necessary; de-identification (§164.514: Safe Harbor's 18 identifiers / Expert Determination) | Use and disclose only the PHI needed; de-identify when possible | PHI tokenization at intake; LLM prompts get the **minimum chart spans per criterion**; Safe-Harbor-style redaction before any external call |
| **HIPAA Security Rule**, technical safeguards §164.312 | Access control, audit controls, integrity, person/entity authentication, transmission security | Session auth + TOTP MFA + RBAC + Postgres RLS; hash-chained audit log; TLS 1.2+; checksums on documents; session timeouts |
| **HIPAA Security Rule NPRM** (Jan 2025; final rule now targeted ~2027) | Proposes making **encryption and MFA mandatory**, asset inventory, network segmentation | Designed to the *proposed* bar now: field encryption at rest + TLS in transit, TOTP MFA, org-level MFA enforcement, dependency inventory |
| **HIPAA BAA** | Any vendor that touches PHI must sign a Business Associate Agreement | Free cloud tiers have no BAA, and some (e.g. Gemini's unpaid tier) may use content to improve products, so this project runs on **synthetic data only** and sends **only de-identified text** to providers. In production, PHI-class model groups are pointed at BAA-covered endpoints by config (`phi_allowed_groups` in `models.yaml`) |
| **HITECH / Breach Notification** | Notify on breach of unsecured PHI | Encryption makes PHI "secured"; breach runbook; access anomaly alerts |
| **CMS-0057-F** | Payer timeframes (72 h / 7 d), specific denial reasons, FHIR PA API by 2027 | Denial-reason parser; data model aligned to **Da Vinci CRD/DTR/PAS** concepts; FHIR export |
| **State AI-in-UR laws** (e.g. WA SB 5395, IA HF 2635, AZ, CO, CA SB 1120) | AI must not be the sole basis for adverse decisions; a clinician decides | Provider-side assistive tool; **no decision output**; mandatory human review step; disclosure banner |
| **FDA: non-device Clinical Decision Support criteria** (FD&C Act §520(o)(1)(E)) | Software that supports an HCP, shows the basis so the HCP can review it independently, and doesn't analyze images/signals generally falls outside device regulation | Administrative documentation tool; shows **all sources and reasoning**; no image/signal analysis; no treatment recommendations |
| **ONC HTI-1** decision-support transparency (relevant if it becomes certified health IT) | Source attributes / transparency for decision support interventions | Model card + "source attributes" page: data sources, model versions, eval results, known limitations |
| **AMA CPT® licensing** | CPT descriptors are copyrighted; licenses required; uploading CPT data into public/open AI systems is prohibited | **Repo ships no CPT descriptors.** Use **HCPCS Level II (public domain)** and ICD-10-CM (public). CPT **numbers** appearing in CMS documents are used as identifiers only, locally, after the user accepts the MCD license. `data/` is git-ignored |
| **Payer policy copyright** | Commercial payers' policies are copyrighted | Downloader scripts only; files stay local; never committed |
| **NIST AI RMF 1.0 + GenAI Profile (AI 600-1)** | Govern / Map / Measure / Manage AI risk | Risk register (§9), eval gates (ARCHITECTURE.md §16), degradation runbook (ARCHITECTURE.md §13) |
| **SOC 2 (readiness)** *(prod)* | Security, availability, confidentiality controls | Change management via PRs + CI, access reviews, logging, backups, vendor inventory |
| **OWASP LLM Top 10 (2025)** | LLM-specific risks | Mapped in ARCHITECTURE.md §12 |

### 6.2 Data classification (drives routing, storage and logging)
| Class | Examples | Allowed LLM endpoints | Storage | Logs |
|---|---|---|---|---|
| `PUBLIC` | CMS policies, code sets, public payer policies | Local + free cloud tiers | Plain | Full prompt/response |
| `INTERNAL` | Tenant config, aggregate analytics | Local (+ cloud only if no row-level data) | Plain | Full |
| `PHI` | Charts, case data, letters, denial letters | **De-identified text only**, allowed groups only (prod: BAA endpoints) | Fernet-encrypted fields | **Redacted**: hashes + token IDs, never raw text |

Every LLM call carries a `data_class` tag. The router **rejects** PHI-class calls that aren't de-identified or that target a group outside `phi_allowed_groups`, and a second regex scan blocks payloads that still look identifying. The two controls are independent of each other.

---

## 7. Knowledge Base: Free, Public Datasets

> All free and online. CMS reorganizes URLs from time to time, so the ingestion code keeps URLs in config and verifies checksums.

| # | Dataset | Source | Format | Use in Necessa | License / notes |
|---|---|---|---|---|---|
| D1 | **Medicare Coverage Database (MCD) downloads**: NCDs, LCDs, Billing Articles, contractors, jurisdictions | cms.gov → Medicare Coverage Database → Downloads | CSV + MS Access (weekly refresh), HTML text inside fields | Core policy corpus (text), structured tables (SQL), graph edges | Requires accepting AMA/ADA/NUBC terms at download. Local use only |
| D2 | **ICD-10-CM** code files + descriptions | CMS / CDC NCHS | TXT/XML | Dx lookup, synonym expansion, coverage linkage | Public domain |
| D3 | **HCPCS Level II** quarterly files | CMS | TXT/XLSX | Service lookup, synonyms | Public domain |
| D4 | **NCCI** PTP edits & MUEs | CMS | XLSX/CSV | Coding-conflict warnings | Public |
| D5 | **CMS Internet-Only Manuals** (Pub 100-02 Benefit Policy, 100-03 NCD Manual, 100-08 Program Integrity Manual) | CMS | PDF | Documentation-requirement rules, "reasonable & necessary" language | Public |
| D6 | **CMS Prior Authorization & Pre-Claim Review** lists (e.g. OPD services) + **WISeR** service list | CMS | PDF/HTML | Which services require PA, mapped to policies | Public |
| D7 | **Synthea** synthetic patients | github.com/synthetichealth/synthea | FHIR R4 (+ US Core DocumentReference notes), C-CDA, CSV, text | Synthetic charts for dev and eval (no PHI risk) | Apache-2.0. Notes are templated, so Necessa generates its own deterministic FHIR patients and counterfactual notes in the same shape |
| D8 | **HL7 Da Vinci CRD / DTR / PAS** IGs + reference implementations | hl7.org/fhir/us/davinci-* ; github.com/HL7-DaVinci | FHIR IG, Java RIs | Data model alignment, export formats, test fixtures | HL7 / open-source |
| D9 | **Public commercial payer medical policies** (1–3 payers) | Payer websites | PDF/HTML | Multi-payer realism; tests the PDF/OCR/table path | Copyrighted: local only, never committed |
| D10 | *(optional)* Synthetic clinical notes on Hugging Face (e.g. `dlyog/synth_clin_notes`) | huggingface.co | Parquet/JSON | Extra note variety for robustness tests | Verify license and quality before use |

**Why this dataset is a strong RAG testbed:** it mixes semi-structured CSV with HTML fields, long PDFs, tables, scanned documents, exact codes, versioned and temporal data, a relational structure (policy ↔ article ↔ code ↔ contractor ↔ state), and frequent updates. That covers nearly every hard case RAG faces in production.

---

---

## 8. Solution Overview
Necessa is implemented as a FastAPI backend, a Next.js web app and a set of offline evaluation suites. The as-built design (topology, hybrid retrieval, reranking, text-to-SQL, the case-evaluation graph, model routing, caching, guardrails, failure modes and the checklist coverage map) is in **[ARCHITECTURE.md](ARCHITECTURE.md)**. Module boundaries and every endpoint are in **[API_CONTRACT.md](API_CONTRACT.md)**. Design decisions are recorded in **[adr/](adr/)**.

In one paragraph: CMS coverage data is ingested into Postgres (the system of record) and indexed into Qdrant with dense embeddings plus in-house BM25 sparse vectors. Each policy is compiled into a tree of atomic criteria whose leaves quote the policy verbatim. For a case, the policy is resolved deterministically, each criterion's evidence is retrieved from the de-identified chart, a model judges it (MET / NOT_MET / INSUFFICIENT), a model from a different family verifies the evidence, and Kleene three-valued logic aggregates the result into *documentation readiness*. A human reviews before anything is drafted or exported.

---

## 9. Risks & Open Questions

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Free-tier limits and model rosters change | High | Medium | Config-only routing, fallbacks across providers, quota tracking, degraded modes that still work with no model at all |
| CMS export format or URLs change | Medium | Medium | Schema checks on ingest, smoke eval before an index goes live, alias rollback |
| Free-tier models judge criteria poorly | Medium | High | Per-criterion judging with verbatim-quote verification and cross-family entailment checks; false-MET is the release gate |
| Contractor editions word the same requirement differently | High | Medium | Criteria transfer only on 100% verbatim re-grounding; otherwise queued for human review |
| CPT licensing misunderstanding | Low | High | No CPT descriptors in the repo; CMS data stays local and git-ignored |
| Users treat output as a coverage decision | Medium | High | No decision field anywhere, policy-language filter, mandatory review, disclaimers |
| Regulatory shifts (WISeR, state laws, HIPAA final rule) | Medium | Low–Med | This document is versioned and reviewed when rules change |

**Open questions**
1. Which commercial payers' public policies to add after Medicare (the ingestion pipeline already supports payer documents)?
2. Should the criteria review queue support assignment and second-reviewer sign-off for organizations that require it?

---

## 10. Sources

- AMA, 2025 prior authorization survey coverage: [AMA press release](https://www.ama-assn.org/press-center/ama-press-releases/ama-survey-prior-authorization-reform-pledge-falls-short-physicians) · [AMA leadership commentary](https://www.ama-assn.org/about/leadership/latest-prior-auth-survey-shows-promised-reform-remains-elusive) · [Becker's: 10 updates](https://www.beckersasc.com/asc-coding-billing-and-collections/physicians-vs-prior-authorization-10-updates/)
- CMS-0057-F: [CMS fact sheet](https://www.cms.gov/newsroom/fact-sheets/cms-interoperability-and-prior-authorization-final-rule-cms-0057-f) · [CMS fact sheet PDF](https://www.cms.gov/files/document/fact-sheet-cms-interoperability-and-prior-authorization-final-rule-cms-0057-f.pdf)
- WISeR Model: [Georgetown CHIR analysis](https://medicare.chir.georgetown.edu/new-cms-wiser-model-revives-concerns-of-prior-authorization-and-artificial-intelligence/) · [Forvis Mazars provider guide](https://www.forvismazars.us/forsights/2025/12/cms-wiser-model-what-providers-need-to-know-by-january-2026) · [PYA explainer](https://www.pyapc.com/insights/is-wiser-wise-cms-innovation-centers-new-prior-authorization-program-explained/)
- State AI laws: [Becker's: 7 AI health insurance state laws in 2026](https://www.beckerspayer.com/policy-updates/7-ai-health-insurance-state-laws-passed-in-2026/) · [Rise Health summary](https://www.risehealth.org/insights-articles/ai-health-insurance-state-laws-2026/) · [PYMNTS](https://www.pymnts.com/?p=3939264)
- CMS MCD downloads: [CMS MLN "How to MCD": Downloads chapter](https://www.cms.gov/Outreach-and-Education/MLN/Educational-Tools/MLN901347-How-to-MCD/mcd/mcd/chapter_6_downloads/)
- HIPAA Security Rule status: [Paubox: final rule pushed to 2027](https://www.paubox.com/blog/hhs-pushes-final-hipaa-security-rule-update-to-2027) · [ComplianceHub](https://compliancehub.wiki/blog/hipaa-security-rule-final-rule-may-2026-mfa-encryption-uncertainty)
- CPT licensing / HCPCS: [AMA CPT licensing FAQs (AI)](https://www.ama-assn.org/practice-management/cpt/licensing-cpt-ai-faqs) · [DOL OWCP code set notice](https://www.dol.gov/agencies/owcp/regs/feeschedule/fee)
- Gemini free-tier data use: [Gemini API Additional Terms](https://ai.google.dev/terms) · [Gemini logs policy](https://ai.google.dev/gemini-api/docs/logs-policy)
- Free LLM tiers (2026): [OpenRouter: free LLM APIs compared](https://openrouter.ai/blog/tutorials/free-llm-apis-compared/) · [continuumcode: real limits](https://continuumcode.ai/guides/free-llm-api/) · [gravity.fast tracker](https://gravity.fast/data/free-llm-api-tiers/)
- Embeddings: [Modal: MTEB leaderboard overview](https://frontend.modal.com/blog/mteb-leaderboard-article) · [AIMultiple: open-source embedding models](https://aimultiple.com/open-source-embedding-models)
- Qdrant: [Hybrid search docs](https://qdrant.tech/documentation/search-tuning/hybrid-search/) · [2025 recap](https://qdrant.tech/blog/2025-recap/)
- LiteLLM: [litellm.ai](https://www.litellm.ai/) · [TrueFoundry: what is LiteLLM](https://www.truefoundry.com/blog/what-is-litellm)
- LangGraph HITL: [LangGraph interrupts docs](https://docs.langchain.com/oss/langgraph/interrupts)
- Langfuse self-host: [Langfuse self-host pricing](https://langfuse.com/pricing-self-host)
- OWASP LLM Top 10 2025: [HackerOne overview](https://www.hackerone.com/ai/owasp-top-10-llms-2025) · [Invicti](https://invicti.com/blog/web-security/owasp-top-10-risks-llm-security-2025)
- Prompt-injection classifiers: [pytector](https://pypi.org/project/pytector/0.3.0/)
- Synthea: [Synthea HL7 FHIR wiki](https://github.com/synthetichealth/synthea/wiki/HL7-FHIR) · [MITRE Synthea overview](https://mitre.github.io/fhir-for-research/modules/synthea-overview)
- Da Vinci IGs: [DTR STU2](https://hl7.org/fhir/us/davinci-dtr/STU2/) · [PAS IG](https://build.fhir.org/ig/HL7/davinci-pas/en/) · [CRD RI](https://github.com/HL7-DaVinci/CRD)
- Existing OSS / research on PA: [PA Navigator (Devpost)](https://devpost.com/software/pa-navigator) · [DEV: autonomous pre-auth agent](https://dev.to/exploredataaiml/building-an-autonomous-medical-pre-authorization-agent-with-python-2mnh) · [arXiv 2404.17977](https://arxiv.org/pdf/2404.17977v1.pdf) · [Duke DIHI project](https://dihi.org/project/using-ai-to-reduce-the-burden-of-prior-authorizations-2/)
- Production RAG failure modes: [Zartis](https://www.zartis.com/rag-in-production-what-nobody-tells-you-until-youre-debugging-it) · [Towards AI: 7 lessons](https://pub.towardsai.net/production-rag-systems-7-lessons-we-learned-the-hard-way-5f41609fdbcd)
- Commercial landscape: [Change Healthcare clearance authorization](https://changehealthcare.com/revenue-cycle-management/financial-clearance/clearance-authorization) · [Experian medical necessity](https://www.experian.com/content/dam/marketing/na/healthcare/brochures/medical-necessity-brochure.pdf) · [Solventum medical necessity](https://www.solventum.com/content/dam/public/language-masters/en/hisb/document/2025/medical-necessity-dictionaries-fact-sheet-his-pm-en.pdf)

> Figures and regulatory statuses were current as of research on 2026-11-13. Several came from secondary sources. Re-verify them against primary sources (CMS, Federal Register, statute text) before quoting them publicly.
