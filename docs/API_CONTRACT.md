# Necessa — Build Contract (binding for all workstreams)

> This is the single source of truth that lets the platform, RAG-core, agents/eval and frontend workstreams build **in parallel** without colliding.
> If something is ambiguous, follow the conventions here; if something must change, add to it (don't rename).

---

## 0. Hard constraints
- **No local model inference of any kind.** All LLM, embedding, rerank and OCR calls go to **cloud free tiers** through LiteLLM (Groq, Gemini, OpenRouter, Cohere, Jina, Mistral, Cerebras, GitHub Models). A missing API key disables that deployment instead of crashing.
- **Footprint ≤ 5 GB** total: managed free tiers in prod (**Neon Postgres**, **Qdrant Cloud**, **Upstash Redis**). Tests use **SQLite + in-memory Qdrant (`QdrantClient(":memory:")`) + fakes**. **ChromaDB is forbidden.**
- **Synthetic data only.** PHI handling is still fully implemented: rule-based de-identification, encryption at rest, audit, RBAC.
- The system **never outputs a coverage decision** ("approved/denied"). It outputs **documentation readiness**.
- Must run with **zero API keys** in "offline/demo" mode. LLM-dependent steps degrade gracefully with clear `degraded` flags (retrieval-only, heuristic verdicts marked `INSUFFICIENT` + "LLM unavailable"). The frontend has a full **demo mode** with mock data.

## 1. Repository layout & ownership
```
necessa/
├── backend/
│   ├── app/
│   │   ├── main.py                    [A]
│   │   ├── cli.py                     [A]  (Typer; subcommands from B/C via app/ai/cli_rag.py [B], app/ai/cli_cases.py [C])
│   │   ├── core/                      [A]  config.py is SHARED (integrator)
│   │   ├── db/base.py, session.py     SHARED (integrator)
│   │   ├── db/models/platform.py      [A]  orgs, users, memberships, invitations, sessions, api_keys, notifications, audit_log, jobs, feedback, conversations, messages
│   │   ├── db/models/cases.py         [A]  patients, cases, case_documents, case_chunks, case_events, case_evaluations, criterion_results, letters, denials
│   │   ├── db/models/knowledge.py     [B]  states, contractors, contractor_states, policies, policy_versions, policy_sections, policy_chunks, policy_links, policy_contractors, policy_states, policy_codes, policy_code_groups, codes, index_versions, ingestion_runs, llm_calls, response_cache
│   │   ├── db/models/criteria.py      [C]  criteria_sets
│   │   ├── db/models/evals.py         [C]  eval_runs, eval_results
│   │   ├── db/models/__init__.py      SHARED: imports all model modules
│   │   ├── schemas/base.py            SHARED
│   │   ├── schemas/{platform,cases}.py [A]   schemas/{knowledge,assistant}.py [B]   schemas/{evaluation,letters,evals}.py [C]
│   │   ├── services/                  [A]  auth, orgs, cases, documents, audit, notifications, jobs (runner), analytics (SQL KPIs), crypto
│   │   ├── api/v1/                    routers — see §4 for owner of each file
│   │   └── ai/
│   │       ├── llm/                   [B]  router.py, models.yaml, telemetry.py, budget.py
│   │       ├── embeddings.py sparse.py vectorstore.py rerank.py cache.py  [B]
│   │       ├── ingestion/             [B]  mcd.py, codesets.py, html.py, chunker.py, indexer.py, pipeline.py, fixtures/
│   │       ├── retrieval/             [B]  understanding.py, intents.py, strategies.py, fusion.py, retriever.py, context.py, corrective.py
│   │       ├── sql/                   [B]  tools.py (incl. resolve_policies), text_to_sql.py, validator.py, views.py
│   │       ├── graph/                 [B]  coverage_graph.py
│   │       ├── guardrails/            [B]  phi.py, injection.py, output.py, policy.py
│   │       ├── agents/qa_graph.py     [B]
│   │       ├── agents/case_graph.py   [C]
│   │       ├── compiler/              [C]  criteria_compiler.py, schema.py, logic.py (Kleene)
│   │       ├── drafting/              [C]  letters.py, denials.py
│   │       ├── synthetic/             [C]  patients.py (FHIR R4 bundles), notes.py (counterfactual), demo_seed.py
│   │       ├── prompts/               [B: qa_*, sql_*, route_*, guard_*]  [C: criteria_*, judge_*, letter_*, denial_*]
│   │       ├── jobs_rag.py            [B]  JOB_HANDLERS
│   │       └── jobs_cases.py          [C]  JOB_HANDLERS
│   ├── alembic/                       [integrator]
│   └── tests/{platform,rag,cases}/    [A]/[B]/[C]; tests/conftest.py [A]
├── eval/                              [C]  datasets/, generators/, harness/, reports/
├── frontend/                          [D]
├── docs/                              [integrator]
└── .github/workflows/                 ci.yml [integrator], nightly-eval.yml [C], ingest.yml [B]
```

## 2. Cross-cutting conventions
- Python 3.12+, fully `async`. SQLAlchemy 2.0 typed ORM (`Mapped[...]`). Pydantic v2. Use `structlog.get_logger(__name__)`.
- **API JSON is camelCase** (`APIModel` in `app/schemas/base.py`). Python is snake_case.
- IDs are UUIDv4 strings. Timestamps are ISO-8601 UTC. Dates (date of service, effective dates) are `YYYY-MM-DD`.
- **Errors:** RFC 7807 `application/problem+json` (`Problem` schema), raised via `app.core.errors.AppError(status, code, title, detail)`.
- **Pagination:** `?limit=25&cursor=<opaque>` → `{"items": [...], "nextCursor": "...", "total": n}`.
- **Auth:** access JWT (15 min) in httpOnly cookie `necessa_at` **or** `Authorization: Bearer`; refresh token in httpOnly cookie `necessa_rt` (rotating, stored hashed in `sessions`). API keys use `Authorization: Bearer nk_live_...`. For cookie-authenticated unsafe methods, the CSRF double-submit cookie `necessa_csrf` must match the `X-CSRF-Token` header.
- **Tenancy:** active org comes from the JWT claim `org` (switch via `POST /auth/switch-org`). Every query on tenant tables filters `org_id == ctx.org.id`. Never trust a client-supplied org_id.
- **RBAC roles:** `owner, admin, coordinator, clinician, reviewer, rcm_manager, auditor`. Permission helper: `require_perm("cases:write")`. Permission map lives in `app/core/permissions.py` [A]:
  - `cases:read` all roles · `cases:write` owner/admin/coordinator/clinician/rcm_manager · `cases:review` owner/admin/clinician/reviewer
  - `letters:approve` owner/admin/clinician · `policies:read` all · `knowledge:admin` owner/admin · `criteria:review` owner/admin/reviewer/clinician
  - `analytics:read` owner/admin/rcm_manager/auditor/coordinator · `audit:read` owner/admin/auditor · `org:admin` owner/admin · `evals:read` owner/admin
- **Shared FastAPI deps (`app/core/deps.py` [A]):**
  ```python
  get_db -> AsyncSession                       # re-export from app.db.session
  get_ctx -> RequestContext                     # .user, .org, .membership, .role, .request_id, .ip, .user_agent
  require_perm(perm: str) -> Depends(...)      # returns RequestContext; 403 otherwise
  get_optional_ctx -> RequestContext | None
  ```
- **Audit:** `await audit(db, ctx, action="case.evaluate", resource_type="case", resource_id=id, metadata={...})` from `app.services.audit` [A]. Hash-chained (`hash = sha256(prev_hash + canonical_json(row))`).
- **Events / SSE bus (`app/core/events.py` [A]):**
  ```python
  async def publish(channel: str, event: str, data: dict) -> None
  def subscribe(channel: str) -> AsyncIterator[tuple[str, dict]]   # async generator; ends on client disconnect
  def sse_response(channel: str, *, replay: list[tuple[str, dict]] | None = None) -> EventSourceResponse
  ```
  In-process fan-out when there is no Redis. With `REDIS_URL`, uses Redis pub/sub. Channels: `case:{case_id}`, `job:{job_id}`, `org:{org_id}` (notifications).
- **Jobs (`app/services/jobs.py` [A]):** `await enqueue(db, type: str, params: dict, *, org_id, created_by) -> Job`. The runner is an asyncio worker inside the API process (`JOBS_INLINE=true`), backed by the `jobs` table (survives restarts: `queued` jobs resume on boot). Handlers come from `app.ai.jobs_rag.JOB_HANDLERS | app.ai.jobs_cases.JOB_HANDLERS`, typed `async def handler(ctx: JobContext) -> dict`, where `JobContext` has `.job_id .org_id .params .progress(pct: float, message: str)` and `.session()` (async cm) and `.publish(event, data)` (to `job:{id}`).
- **LLM telemetry:** every LLM/embedding/rerank call records an `llm_calls` row (provider, model, group, purpose, data_class, tokens, latency, cache_hit, fallback_used, status). This powers the admin "Models & Providers" page.
- **Data classes:** `PUBLIC | INTERNAL | PHI`. With synthetic-only data, PHI-class calls may use free cloud tiers **only after de-identification**: the router enforces `deidentified=True` for PHI. This is configurable (`PHI_ALLOWED_GROUPS` in models.yaml) so a prod deployment can restrict PHI to BAA endpoints.

## 3. Database schema (portable; see `app/db/base.py`)
Columns are listed as `name type [notes]`. All tenant tables use `OrgScopedMixin` (`org_id`).

### 3.1 Platform [A]
- **organizations**: id, name, slug (unique), npi (nullable), specialty, practice_type (`clinic|hospital|asc|dme|other`), states (list[str] of state abbrevs), payers (list[dict]: `{type, name}`), timezone, settings (dict: `{slaHoursStandard:168, slaHoursExpedited:72, dataRetentionDays:365, requireMfa:false, defaultAsOf:"dos"}`), onboarding_completed_at, created_at, updated_at
- **users**: id, email (unique, lowercase), full_name, title, password_hash, is_active, is_superuser, email_verified_at, mfa_secret_enc, mfa_enabled, avatar_color, last_login_at, preferences (dict: theme, density, notifications), created_at, updated_at
- **memberships**: id, org_id, user_id, role, status (`active|suspended`), created_at · unique(org_id, user_id)
- **invitations**: id, org_id, email, role, token_hash, invited_by, expires_at, accepted_at, revoked_at, created_at
- **sessions**: id, user_id, refresh_token_hash, user_agent, ip, created_at, last_used_at, expires_at, revoked_at
- **api_keys**: id, org_id, name, prefix, key_hash, scopes (list[str]), created_by, last_used_at, expires_at, revoked_at, created_at
- **notifications**: id, org_id, user_id, type, title, body, link, read_at, created_at
- **audit_log**: id (bigint autoincrement), org_id (nullable), actor_id, actor_type (`user|system|api_key`), action, resource_type, resource_id, ip, user_agent, metadata (dict), prev_hash, hash, created_at
- **jobs**: id, org_id (nullable), type, status (`queued|running|succeeded|failed|cancelled`), progress (float 0..1), message, params (dict), result (dict), error, created_by, created_at, started_at, finished_at
- **feedback**: id, org_id, user_id, target_type (`answer|verdict|letter|retrieval`), target_id, rating (`1|-1`), reason, comment, created_at
- **conversations**: id, org_id, user_id, title, pinned, created_at, updated_at
- **messages**: id, org_id, conversation_id, role (`user|assistant`), content, citations (list[dict]), route (dict: RouteTrace), sql (dict|null), usage (dict), feedback (int|null), created_at

### 3.2 Cases [A] (written by [C] during evaluation)
- **patients**: id, org_id, external_ref (synthetic MRN, tokenized), demographics_enc (Fernet JSON: name, dob, address, phone, member_id), sex, birth_year, state, source (`synthetic|upload|manual`), fhir_bundle_enc (nullable), created_at
- **cases**: id, org_id, number (unique per org, `NC-2026-00042`), patient_id, title, status (`draft|evaluating|needs_review|ready|submitted|pending_payer|approved|denied|appealing|closed`), priority (`standard|expedited`), payer_type (`medicare_ffs|medicare_advantage|commercial|medicaid`), payer_name, state, service_codes (list[str]), dx_codes (list[str]), date_of_service (date), place_of_service, assignee_id, due_at, readiness (`unknown|ready|gaps|not_supported`), readiness_score (float 0..1 nullable), policy_refs (list[dict]: `{policyId, policyVersionId, sourceId, title, version}`), latest_evaluation_id, outcome (nullable), outcome_at, submitted_at, tags (list[str]), created_by, created_at, updated_at
- **case_documents**: id, org_id, case_id, kind (`clinical_note|fhir_bundle|pdf|imaging_report|therapy_note|denial_letter|other`), filename, mime, size_bytes, sha256, page_count, text_enc (Fernet extracted text), text_deid (de-identified text), ocr_used (bool), injection_score (float), quarantined (bool), note_date (date nullable), uploaded_by, created_at
- **case_chunks**: id, org_id, case_id, document_id, ordinal, text_deid, section, note_date, char_start, char_end, meta (dict), created_at  ← used for verbatim citation checks; vectors in Qdrant `chart_chunks`
- **case_events**: id, org_id, case_id, actor_id (nullable), type (e.g. `created, status_changed, document_added, evaluation_started, evaluation_completed, verdict_overridden, letter_drafted, letter_approved, denial_recorded, comment`), payload (dict), created_at
- **case_evaluations**: id, org_id, case_id, status (`running|awaiting_review|completed|failed|cancelled`), readiness, readiness_score, policy_version_ids (list[str]), criteria_set_ids (list[str]), tree_result (dict), gaps (list[dict]), model_info (dict), token_usage (dict), degraded (bool), error, started_by, started_at, finished_at
- **criterion_results**: id, org_id, evaluation_id, case_id, criterion_id (str, e.g. `C1`), criterion_text, kind (`positive|negative_attestation|documentation|temporal|numeric`), tree_path, verdict (`MET|NOT_MET|INSUFFICIENT`), confidence (float), rationale, evidence (list[dict]: `{chunkId, documentId, quote, charStart, charEnd, noteDate}`), policy_citation (dict: `{policyVersionId, sectionKey, quote}`), verification (dict: `{quoteValid, entailment, judgeModel, verifierModel, iterations}`), override_verdict (nullable), override_reason, overridden_by, overridden_at, created_at
- **letters**: id, org_id, case_id, kind (`lmn|pa_cover|appeal|peer_to_peer_prep`), status (`draft|in_review|approved|exported`), title, content_md, version (int), citations (list[dict]), model_info (dict), created_by, approved_by, approved_at, created_at, updated_at
- **denials**: id, org_id, case_id, document_id (nullable), received_at (date), reason_text, carc_codes (list[str]), rarc_codes (list[str]), category (`medical_necessity|documentation|coding|eligibility|timely_filing|other`), mapped_criteria (list[dict]: `{criterionId, text, confidence}`), appeal_deadline (date), appeal_letter_id, status (`new|analyzing|appeal_drafted|appealed|overturned|upheld`), analysis (dict), created_at, updated_at

### 3.3 Knowledge [B]
- **states**: id (int, CMS state_id), abbrev, name
- **contractors**: id (int, CMS contractor_id), type_id (int), version (int), name, number, url, dmerc_region (nullable) · pk (id, type_id, version)
- **contractor_states**: contractor_id, contractor_type_id, state_id, active_date, term_date
- **policies**: id (uuid), source (`ncd|lcd|article|payer`), source_key (unique: `L33718`, `A52369`, `NCD-150.9`, `PAYER-<slug>-<id>`), cms_id (int nullable), title, doc_type (`NCD|LCD|Billing and Coding|Article|Response to Comments|Payer Policy`), status (`active|retired|future`), current_version_id, keywords, url, created_at, updated_at
- **policy_versions**: id (uuid), policy_id, version (int), effective_from (date), effective_to (date nullable), retired_at (date nullable), last_updated (datetime), content_hash, summary (nullable, LLM- or rule-generated), raw (dict, trimmed metadata), created_at · unique(policy_id, version)
- **policy_sections**: id, policy_version_id, section_key (`indication|doc_reqs|coding_guidelines|limitations|associated_info|summary_of_evidence|analysis_of_evidence|description|other_comments|cms_cov_policy|util_guide|item_service|bibliography`), title, text (plain text, normalized), ordinal
- **policy_chunks**: id (uuid = Qdrant point id), policy_version_id, section_id, ordinal, parent_id (nullable: parent-child), level (`child|parent`), text, header (contextual header), token_estimate, char_start, char_end, content_hash, embed_model (nullable until embedded), indexed_at
- **policy_links**: from_version_id, to_policy_id, relation (`lcd_article|article_lcd|lcd_ncd|related`), meta (dict)
- **policy_contractors**: policy_version_id, contractor_id, contractor_type_id
- **policy_states**: policy_version_id, state_abbrev, primary (bool)  ← derived via contractor jurisdictions
- **policy_codes**: id, policy_version_id, code_system (`HCPCS|ICD10_COVERED|ICD10_NONCOVERED|ICD10_PCS|BILL_TYPE|REVENUE`), code, group_no, description (stored locally only; never exported/committed), is_range
- **policy_code_groups**: policy_version_id, code_system, group_no, paragraph (plain text)
- **codes**: code_system (`HCPCS|ICD10CM`), code, short_desc, long_desc · pk(code_system, code)
- **index_versions**: id, alias (`policy_chunks|criteria|chart_chunks|semantic_cache`), physical_name, embed_model, dims, sparse_model (`bm25-snowball-v1`), status (`building|ready|active|retired|failed`), points (int), stats (dict: eval smoke results), created_at, activated_at
- **ingestion_runs**: id, source (`mcd|codesets|payer_upload|fixtures`), scope (dict), status, stats (dict), error, started_at, finished_at, job_id
- **llm_calls**: id, org_id (nullable), request_id, group, purpose, provider, model, data_class, prompt_tokens, completion_tokens, latency_ms, cache_hit, fallback_used, attempt, status (`ok|error|rate_limited|blocked`), error, created_at
- **response_cache**: key (pk), value (dict), expires_at · fallback cache table when there's no Redis

### 3.4 Criteria & evals [C]
- **criteria_sets**: id, policy_version_id, status (`draft|needs_review|approved|rejected|superseded`), tree (dict: CriteriaTree), extractor_model, verifier_model, agreement (float), grounding_pass_rate (float), notes, reviewed_by, reviewed_at, created_at
- **eval_runs**: id, suite (`retrieval|verdicts|sql|faithfulness|safety|e2e`), status, metrics (dict), config (dict), git_sha, started_at, finished_at, error
- **eval_results**: id, run_id, item_id, passed, metrics (dict), details (dict)

## 4. REST API (`/api/v1`)
Owners: **[A]** platform · **[B]** knowledge/RAG · **[C]** case AI/evals. Each owner writes the router file shown.

### 4.1 Auth & users — `api/v1/auth.py`, `users.py` [A]
| Method | Path | Body → Response |
|---|---|---|
| POST | `/auth/signup` | `{email, password, fullName}` → `{user, needsOnboarding:true}` + sets cookies |
| POST | `/auth/login` | `{email, password, mfaCode?}` → `{user, orgs:[OrgSummary], activeOrgId, mfaRequired?}` |
| POST | `/auth/refresh` | (cookie) → `{ok:true}` rotate |
| POST | `/auth/logout` | → 204 |
| GET | `/auth/me` | → `{user, activeOrg, membership:{role, permissions[]}, orgs[]}` |
| POST | `/auth/switch-org` | `{orgId}` → `/auth/me` payload |
| POST | `/auth/password/forgot` | `{email}` → 202 (dev: reset link logged + returned in `devLink` when env=dev) |
| POST | `/auth/password/reset` | `{token, password}` → 204 |
| POST | `/auth/mfa/setup` | → `{secret, otpauthUrl}` |
| POST | `/auth/mfa/verify` | `{code}` → `{enabled:true, recoveryCodes[]}` |
| POST | `/auth/mfa/disable` | `{code}` → 204 |
| GET | `/auth/sessions` | → `[{id, userAgent, ip, createdAt, lastUsedAt, current}]` |
| DELETE | `/auth/sessions/{id}` | → 204 |
| GET | `/auth/csrf` | → `{csrfToken}` (+ cookie) |
| PATCH | `/users/me` | `{fullName?, title?, preferences?}` → user |
| POST | `/users/me/password` | `{currentPassword, newPassword}` → 204 |

`User = {id, email, fullName, title, avatarColor, mfaEnabled, preferences, createdAt}` · `OrgSummary = {id, name, slug, role}`

### 4.2 Organizations & onboarding — `orgs.py` [A]
| Method | Path | Notes |
|---|---|---|
| POST | `/orgs` | `{name, npi?, specialty, practiceType, states[], payers[], timezone}` → Org (caller = owner, becomes active org) |
| GET | `/orgs/current` | → Org (incl. settings, onboarding status, counts) |
| PATCH | `/orgs/current` | partial Org (`org:admin`) |
| POST | `/orgs/current/onboarding/complete` | → Org |
| GET | `/orgs/current/members` | → `[Member{id(userId), fullName, email, role, status, lastLoginAt, mfaEnabled}]` |
| PATCH | `/orgs/current/members/{userId}` | `{role?, status?}` |
| DELETE | `/orgs/current/members/{userId}` | |
| GET/POST | `/orgs/current/invitations` | POST `{email, role}` → `{invitation, devLink}` |
| DELETE | `/orgs/current/invitations/{id}` | revoke |
| GET | `/invitations/{token}` (public) | → `{orgName, email, role, expiresAt}` |
| POST | `/invitations/{token}/accept` | `{fullName?, password?}` (new user) → `/auth/me` payload |
| GET/POST/DELETE | `/orgs/current/api-keys[/{id}]` | POST → `{apiKey:{...}, secret:"nk_live_..."}` (shown once) |
| POST | `/orgs/current/demo-data` | [C] seeds synthetic patients + cases → Job |

### 4.3 Cases — `cases.py` [A] (evaluation endpoints in `case_ai.py` [C])
| Method | Path | Notes |
|---|---|---|
| GET | `/cases` | filters: `status, priority, assignee (me|id), readiness, payerType, q, dueBefore, sort (dueAt|-updatedAt|…)` → Page[CaseSummary] |
| POST | `/cases` | `{patientId? , patient?:{fullName, dob, sex, state, memberId}, title?, priority, payerType, payerName, state, serviceCodes[], dxCodes[], dateOfService, placeOfService?, assigneeId?, tags[]}` → Case |
| GET | `/cases/{id}` | → Case; `?reveal=true&reason=…` (needs `phi:reveal`) adds `patientRevealed {fullName, dob, memberId, mrn}` and writes an audit entry with the stated purpose |
| PATCH | `/cases/{id}` | partial; status transitions validated (state machine in `services/cases.py`) |
| DELETE | `/cases/{id}` | soft-delete → status `closed` + audit |
| POST | `/cases/{id}/documents` | multipart `file`, `kind`, `noteDate?` → CaseDocument (text extraction, de-identification and injection scan run synchronously or via job) |
| POST | `/cases/{id}/documents/text` | `{kind, text, noteDate?, title?}` → CaseDocument (paste notes) |
| GET | `/cases/{id}/documents` | → [CaseDocument] |
| GET | `/cases/{id}/documents/{docId}` | → CaseDocument + `text` (de-identified by default; `?reveal=true` decrypts, audited) |
| DELETE | `/cases/{id}/documents/{docId}` | |
| GET | `/cases/{id}/timeline` | → [CaseEvent] |
| POST | `/cases/{id}/comments` | `{body}` → CaseEvent |
| POST | `/cases/{id}/outcome` | `{outcome:"approved|denied|partial|withdrawn", note?}` |
| GET | `/patients` / `/patients/{id}` | masked list / detail |
| GET | `/cases/stats` | counts by status/readiness for the worklist header |

`CaseSummary = {id, number, title, status, priority, payerType, payerName, state, serviceCodes, dxCodes, dateOfService, readiness, readinessScore, dueAt, assignee:{id, fullName, avatarColor}|null, patient:{id, displayName (masked "J. D."), birthYear, sex}, updatedAt}`
`Case = CaseSummary + {placeOfService, policyRefs, latestEvaluationId, outcome, outcomeAt, submittedAt, tags, documentsCount, createdBy, createdAt}`

**Case AI — `case_ai.py` [C]**
| Method | Path | Notes |
|---|---|---|
| POST | `/cases/{id}/policy-suggestions` | → `{matches:[PolicyMatch]}`: deterministic resolution preview for a saved case |
| POST | `/cases/policy-suggestions` | `{serviceCodes, dxCodes, state, payerType, dateOfService}` → `{matches}`: the same preview before a case exists (new-case wizard) |
| POST | `/cases/{id}/evaluate` | `{policyVersionIds?: [...]}` → `{evaluationId, jobId}`; progress streams over SSE |
| GET | `/cases/{id}/events` | **SSE** stream on channel `case:{id}` (replays the current evaluation state first) |
| GET | `/cases/{id}/evaluations` | → [EvaluationSummary] |
| GET | `/cases/{id}/evaluations/{evalId}` | → Evaluation (criteria results, tree, gaps) |
| PATCH | `/cases/{id}/criteria/{resultId}` | `{overrideVerdict, overrideReason}` (`cases:review`) → CriterionResult |
| POST | `/cases/{id}/evaluations/{evalId}/complete-review` | → Evaluation (status completed; case → `ready` or `needs_review`) |
| GET | `/cases/{id}/next-actions` | → `[{type, title, detail, criterionId?, priority}]` (assistive next-best-actions) |
| POST | `/cases/{id}/letters` | `{kind}` → `{letterId, jobId}` (drafting streams `letter.token` on `case:{id}`) |
| GET | `/cases/{id}/letters` / `/letters/{letterId}` | |
| PATCH | `/cases/{id}/letters/{letterId}` | `{contentMd?, status?}` (approve needs `letters:approve`) |
| GET | `/cases/{id}/letters/{letterId}/export?format=pdf|md|docx-lite|fhir` | file download (PDF via a minimal pure-Python writer) |
| POST | `/cases/{id}/denials` | `{documentId? , text?, receivedAt, carcCodes?[]}` → Denial (analysis job) |
| GET | `/cases/{id}/denials` · PATCH `/cases/{id}/denials/{denialId}` | |
| GET | `/cases/{id}/export/fhir` | QuestionnaireResponse-style JSON (DTR-like) |

`PolicyMatch = {policyId, policyVersionId, sourceKey, title, docType, version, effectiveFrom, effectiveTo, matchReasons:[{type:"hcpcs|icd10|state|contractor|link|national|manual", value, detail}], score, contractor:{id,name}|null, criteriaSetStatus:"approved|needs_review|draft|missing"}`
`Evaluation = {id, caseId, status, readiness, readinessScore, degraded, policies:[PolicyMatch], tree: TreeResult, criteria:[CriterionResult], gaps:[Gap], tokenUsage, modelInfo, startedAt, finishedAt}`
`CriterionResult = {id, criterionId, text, kind, treePath, verdict, effectiveVerdict (override ?? verdict), confidence, rationale, evidence:[Evidence], policyCitation, verification, override:{verdict, reason, by:{id,fullName}, at}|null}`
`Gap = {criterionId, title, detail, severity:"blocker|major|minor", suggestedFix, policyQuote}`
`TreeResult = {op:"AND|OR|N_OF_M", n?, criterionId?, text?, verdict, children?:[TreeResult]}`

### 4.4 Knowledge — `policies.py`, `codes.py` [B]
| Method | Path | Notes |
|---|---|---|
| GET | `/policies` | `q, docType, state, contractorId, code, status, asOf, limit, cursor` → Page[PolicySummary]. `q` uses hybrid retrieval grouped by policy; no `q` lists by SQL |
| GET | `/policies/{policyId}` | → PolicyDetail (current version, sections, linked docs, contractors, states, code counts, versions[]) |
| GET | `/policies/{policyId}/versions/{versionId}` | → PolicyVersionDetail (sections w/ text) |
| GET | `/policies/{policyId}/diff?from=v1&to=v2` | → `{sections:[{sectionKey, title, status:"added|removed|changed|same", hunks:[{op:"equal|insert|delete", text}]}]}` |
| GET | `/policies/{policyId}/codes?system=HCPCS&group=` | → Page[PolicyCode] |
| GET | `/policies/{policyId}/criteria` | [C-owned data, B serves read] → CriteriaSet or 404 |
| GET | `/codes/search?q=&system=` | → [{system, code, shortDesc, longDesc?}] (exact code first, then FTS, then trigram/like) |
| GET | `/codes/{system}/{code}` | → code + linked policies (with states/contractors) |
| GET | `/codes/{system}/{code}/graph?state=&asOf=` | → CoverageGraph `{nodes:[{id,type:"code|article|lcd|ncd|contractor|state",label,meta}], edges:[{source,target,type}]}` |
| GET | `/knowledge/stats` | → counts: policies by type, versions, chunks, codes, last ingestion, active index, freshness |
| POST | `/search/retrieve` | debug/inspector: `{query, scope, filters, strategy?, topK}` → RetrievalResult (with full RouteTrace and per-stage scores) |

`PolicySummary = {id, sourceKey, title, docType, status, version, effectiveFrom, effectiveTo, contractors:[{id,name}], states:[str], codeCount, hasCriteria, snippet?, score?}`

### 4.5 Assistant ("Ask Necessa") — `assistant.py` [B]
| Method | Path | Notes |
|---|---|---|
| GET | `/assistant/conversations` | → Page[Conversation] |
| POST | `/assistant/conversations` | `{title?}` → Conversation |
| GET | `/assistant/conversations/{id}` | → Conversation + messages |
| PATCH/DELETE | `/assistant/conversations/{id}` | rename/pin/delete |
| POST | `/assistant/conversations/{id}/messages` | `{content, asOf?, caseId?, mode?:"auto|policy|analytics|codes"}` → **SSE** stream (see §5.2); persists both messages |
| POST | `/assistant/messages/{messageId}/feedback` | `{rating, reason?, comment?}` |
| GET | `/assistant/suggestions?context=dashboard|case:{id}|policy:{id}` | → `[{label, prompt}]` (assistive prompt chips) |
| POST | `/analytics/ask` | `{question}` → `{sql, columns, rows, summary, chartHint:{type:"bar|line|pie|table", x, y}, warnings[]}` (text-to-SQL; also reachable through assistant mode=analytics) |

### 4.6 Analytics — `analytics.py` [A]
| GET | `/analytics/overview?range=30d` | → `{kpis:{openCases, dueSoon, readyRate, avgReadinessScore, gapsCaughtPreSubmission, deniedCases, appealsOverturned, avgTurnaroundHours, estimatedHoursSaved}, trends:{casesByDay:[{date,count}], readinessByWeek:[{week, ready, gaps, notSupported}]}, topGapCriteria:[{criterionText, count}], denialReasons:[{category, count}], payerMix:[{payerType, count}]}` |
| GET | `/analytics/team` | → workload per assignee |
| GET | `/activity` | → recent org activity feed (case_events + audit summaries) |

### 4.7 Notifications, audit, jobs, feedback, health [A]
| GET | `/notifications` · POST `/notifications/{id}/read` · POST `/notifications/read-all` · **SSE** `/notifications/stream` |
| GET | `/audit?actor=&action=&resourceType=&from=&to=` → Page[AuditEntry] · GET `/audit/verify` → `{valid, checked, brokenAt?}` (hash-chain verification) |
| GET | `/jobs/{id}` · **SSE** `/jobs/{id}/events` · GET `/jobs?type=&status=` |
| POST | `/feedback` | generic feedback |
| GET | `/health` (liveness) · `/health/ready` (db, qdrant, redis, providers configured) · `/metrics` (Prometheus) |

### 4.8 Admin — `admin_knowledge.py`, `admin_models.py` [B]; `admin_criteria.py`, `admin_evals.py` [C]; `admin_users.py` [A]
| Method | Path | Notes |
|---|---|---|
| POST | `/admin/ingestion/runs` | `{source:"mcd|codesets|fixtures", scope:"focus|full", policyKeys?[]}` → Job |
| GET | `/admin/ingestion/runs` | → [IngestionRun] |
| GET | `/admin/indexes` | → [IndexVersion] (alias, physical, status, points, stats) |
| POST | `/admin/indexes/{id}/activate` · `/admin/indexes/rollback?alias=` | blue/green alias switch |
| GET | `/admin/models` | → `{groups:[{name, purpose, dataClasses, deployments:[{provider, model, configured, healthy, cooldownUntil, rpm, rpd, usedToday, p50LatencyMs, errorRate}]}], embedding:{model, dims}, reranker:{chain:[...]}}` |
| GET | `/admin/models/usage?range=7d` | → aggregates from llm_calls (by provider/model/group/day; tokens, latency, errors, cache hits, fallbacks) |
| POST | `/admin/models/test` | `{group}` → `{ok, provider, model, latencyMs, sample}` |
| GET | `/admin/cache/stats` · POST `/admin/cache/flush` | |
| GET | `/admin/criteria?status=needs_review` | → Page[CriteriaSetSummary] |
| GET/PATCH | `/admin/criteria/{id}` | edit tree, approve/reject |
| POST | `/admin/criteria/compile` | `{policyVersionIds?[], sourceKeys?[]}` → Job |
| GET | `/admin/evals/runs` · `/admin/evals/runs/{id}` · POST `/admin/evals/runs {suite}` | |
| GET | `/admin/system` | env, versions, git sha, feature flags, data retention, quotas |

## 5. Streaming events (SSE: `event: <name>\ndata: <json>\n\n`)
### 5.1 Case channel `case:{id}` [C publishes]
Every `evaluation.*` and `criterion.*` event carries `evaluationId`, so clients can ignore replayed events from earlier runs. Replay on connect starts with `evaluation.snapshot`.
`evaluation.started {evaluationId, policies:[PolicyMatch], criteriaCount}` ·
`evaluation.phase {phase:"resolving|loading_criteria|indexing_chart|evaluating|aggregating|drafting_gaps|review", message}` ·
`criterion.started {criterionId, text, treePath}` ·
`criterion.evidence {criterionId, evidence:[{chunkId, quote, score, noteDate}]}` ·
`criterion.corrective {criterionId, iteration, reason}` ·
`criterion.verdict {result: CriterionResult}` ·
`evaluation.aggregate {readiness, readinessScore, tree: TreeResult}` ·
`evaluation.gaps {gaps:[Gap]}` ·
`evaluation.awaiting_review {evaluationId}` · `evaluation.completed {evaluation: Evaluation}` · `evaluation.failed {error, retryable}` ·
`letter.started {letterId, kind}` · `letter.token {letterId, text}` · `letter.completed {letter}` ·
`denial.analyzed {denial}` · `heartbeat {}` (every 15 s)

### 5.2 Assistant message stream [B publishes]
`route {intent, confidence, strategy, transforms:[...], filters:{...}, reason}` ·
`retrieval {chunks:[{chunkId, sourceKey, title, sectionKey, version, score, scores:{dense,sparse,bm25,fused,rerank}}], timings:{understandMs, retrieveMs, rerankMs}}` ·
`tool {name, args, result}` (SQL/graph tools) ·
`sql {sql, columns, rows, chartHint}` ·
`token {text}` ·
`citations {items:[{n, chunkId, sourceKey, title, sectionKey, version, quote, url}]}` ·
`guardrail {kind:"injection|phi|policy|abstain|degraded", message}` ·
`done {messageId, usage:{promptTokens, completionTokens}, latencyMs, cached, model, provider}` · `error {message, retryable}`

### 5.3 Job channel `job:{id}`
`progress {progress, message}` · `log {level, message}` · `completed {result}` · `failed {error}`

## 6. Python interfaces between workstreams
```python
# ── [B] app/ai/llm/router.py ───────────────────────────────────────────────
class DataClass(StrEnum): PUBLIC="PUBLIC"; INTERNAL="INTERNAL"; PHI="PHI"
@dataclass
class LLMResult:
    text: str; parsed: BaseModel | None; model: str; provider: str
    prompt_tokens: int; completion_tokens: int; latency_ms: int; cached: bool; fallback_used: bool
class LLMUnavailable(Exception): ...          # all deployments in a group failed/unconfigured
class LLMRouter:
    async def complete(self, *, group: str, messages: list[dict], purpose: str,
                       data_class: DataClass = DataClass.PUBLIC, deidentified: bool = False,
                       response_model: type[BaseModel] | None = None, temperature: float | None = None,
                       max_tokens: int | None = None, org_id: UUID | None = None,
                       cache: bool = True, timeout_s: float | None = None) -> LLMResult
    def stream(self, **same_kwargs_minus_response_model) -> AsyncIterator[str]
    async def embed(self, texts: list[str], *, task: Literal["document", "query"], purpose: str) -> list[list[float]]
    async def rerank(self, query: str, documents: list[str], *, top_n: int, purpose: str) -> list[tuple[int, float]]
    def configured_groups(self) -> dict[str, list[str]]
def get_llm_router() -> LLMRouter              # singleton; tests can override with FakeLLMRouter (app/ai/llm/fake.py [B])
# Model groups (models.yaml): router-small, qa-public, judge, verifier, sql, drafter, compiler-longctx, ocr-vision, guard

# ── [B] app/ai/retrieval/retriever.py ─────────────────────────────────────────
@dataclass
class PolicyFilters:
    as_of: date | None = None; states: list[str] | None = None; payer_type: str | None = None
    contractor_ids: list[int] | None = None; doc_types: list[str] | None = None
    codes: list[str] | None = None; policy_version_ids: list[str] | None = None; section_keys: list[str] | None = None
@dataclass
class RetrievalQuery:
    text: str; org_id: UUID | None; scope: Literal["policy", "criteria", "chart"] = "policy"
    filters: PolicyFilters = field(default_factory=PolicyFilters); case_id: UUID | None = None
    top_k: int = 8; strategy: str | None = None; lookback_days: int | None = None; trace: bool = True
@dataclass
class RetrievedChunk:
    chunk_id: str; text: str; header: str; score: float; scores: dict[str, float]
    source: dict   # policy_id, policy_version_id, source_key, title, section_key, version, effective_from, url | case: document_id, note_date
    char_start: int | None = None; char_end: int | None = None
@dataclass
class RouteTrace:
    intent: str; confidence: float; strategy: str; transforms: list[str]; filters_applied: dict
    retrievers: list[str]; fusion: str; rerank: str | None; corrective_iterations: int
    abstained: bool; reason: str; degraded: list[str]
@dataclass
class RetrievalResult:
    chunks: list[RetrievedChunk]; route: RouteTrace; timings: dict[str, float]
class HybridRetriever:
    async def search(self, q: RetrievalQuery) -> RetrievalResult
def get_retriever() -> HybridRetriever
async def index_chart_chunks(case_id: UUID, org_id: UUID, chunks: list["ChartChunkIn"]) -> None   # [B] retrieval/chart_index.py
@dataclass
class ChartChunkIn: chunk_id: str; document_id: str; text: str; section: str | None; note_date: date | None

# ── [B] app/ai/sql/tools.py ─────────────────────────────────────────────────
async def resolve_policies(db, *, service_codes: list[str], dx_codes: list[str], state: str | None,
                           payer_type: str, date_of_service: date) -> list[PolicyMatchDTO]   # deterministic
async def covered_dx_for_policy(db, policy_version_id: str, dx_codes: list[str]) -> dict[str, Literal["covered","noncovered","unlisted"]]
async def find_policies_by_code(db, code: str, state: str | None, as_of: date | None) -> list[dict]

# ── [B] app/ai/guardrails/phi.py & injection.py ────────────────────────────────
@dataclass
class DeidResult: text: str; replacements: dict[str, str]; counts: dict[str, int]
class Deidentifier:
    def deidentify(self, text: str, known: dict[str, str] | None = None) -> DeidResult   # known: {"name": "...", "dob": "...", "mrn": "..."}
    def rehydrate(self, text: str, replacements: dict[str, str]) -> str
@dataclass
class InjectionVerdict: score: float; label: Literal["clean","suspicious","malicious"]; reasons: list[str]
async def scan_injection(text: str, *, source: str, use_llm: bool = True) -> InjectionVerdict
def verify_quote(quote: str, source_text: str) -> tuple[bool, int | None, int | None]   # whitespace/case-normalized verbatim check

# ── [B] app/ai/agents/qa_graph.py ───────────────────────────────────────────
async def run_assistant_turn(*, db, org_id: UUID, user_id: UUID, conversation_id: UUID, content: str,
                             as_of: date | None, case_id: UUID | None, mode: str = "auto"
                             ) -> AsyncIterator[tuple[str, dict]]   # yields (event_name, data) per §5.2

# ── [C] app/ai/agents/case_graph.py ─────────────────────────────────────────
async def run_case_evaluation(ctx: JobContext) -> dict      # job type "case.evaluate"; params {caseId, evaluationId, policyVersionIds?}
async def draft_letter_job(ctx: JobContext) -> dict          # job type "letter.draft"
async def analyze_denial_job(ctx: JobContext) -> dict        # job type "denial.analyze"
async def compile_criteria_job(ctx: JobContext) -> dict      # job type "criteria.compile"
async def seed_demo_job(ctx: JobContext) -> dict             # job type "demo.seed"
# [C] app/ai/compiler/logic.py
def kleene_and(vals) / kleene_or(vals) / n_of_m(n, vals) / evaluate_tree(tree, verdicts) -> TreeResult

# ── [B] job handlers: "ingest.mcd", "ingest.codesets", "ingest.fixtures", "index.activate", "eval.retrieval"
```

## 7. Environment variables (`.env.example` at the repo root)
`DATABASE_URL, QDRANT_URL, QDRANT_API_KEY, REDIS_URL, SECRET_KEY, PHI_ENCRYPTION_KEY, GROQ_API_KEY, GEMINI_API_KEY, OPENROUTER_API_KEY, COHERE_API_KEY, JINA_API_KEY, MISTRAL_API_KEY, CEREBRAS_API_KEY, GITHUB_MODELS_TOKEN, EMBEDDING_MODEL, EMBEDDING_DIMS, LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY, ACCEPT_CMS_LICENSE, INGEST_SCOPE, DEMO_MODE, ENVIRONMENT, CORS_ORIGINS, PUBLIC_APP_URL` · frontend: `NEXT_PUBLIC_API_BASE` (default `/api/v1` via Next rewrite to `http://localhost:8000`), `NEXT_PUBLIC_DEMO_MODE`.

## 8. Ingestion "focus" scope (default)
Keeps embedding quota and storage tiny while staying realistic:
- **All 357 NCDs** + LCDs/Articles whose codes or titles match the **focus service set**: knee arthroscopy (29870–29889 range, articles like A52369), nerve stimulators (64555–64595, 63650–63688, E0720–E0749, incl. sacral/tibial), skin substitutes (Q4100–Q4400, 15271–15278), cervical fusion (22551–22600), epidural steroid injections (62321–62327, 64479–64484), facet joint interventions (64490–64495, 64633–64636), blepharoplasty (15820–15823, 67900–67911), MRI of spine/lower extremity (72141–72158, 73718–73723), PAP devices (E0601, E0470–E0471), power mobility devices (K0800–K0899), external infusion pumps (E0779–E0791), lower-limb prostheses (L5000–L5999), plus their related Billing & Coding articles.
- **Full scope** (`INGEST_SCOPE=full`) ingests everything, resumable over several days to respect free-tier quotas.
- `fixtures` source: a small set of **hand-written synthetic policies** (clearly labelled synthetic) shipped in the repo for tests and offline demos (no AMA/ADA content).
