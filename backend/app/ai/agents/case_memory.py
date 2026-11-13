"""In-memory ports for the case agent — used by unit tests and the offline verdict eval suite."""

from __future__ import annotations

import uuid
from datetime import date
from typing import Any

from app.ai.agents.case_chart import ChartChunk, LexicalIndex
from app.ai.agents.case_graph import CaseSnapshot, LoadedCriteria
from app.ai.agents.case_results import criterion_result_api
from app.ai.compiler.schema import CriteriaTree, CriterionLeaf


class InMemoryCasePorts:
    def __init__(
        self, snapshot: CaseSnapshot, trees: list[CriteriaTree], *, cancel_after: int | None = None
    ) -> None:
        self.snapshot = snapshot
        self.trees = trees
        self.events: list[tuple[str, dict]] = []
        self.results: list[dict] = []
        self.summary: dict | None = None
        self.failed: str | None = None
        self.chunks: list[ChartChunk] = []
        self._cancel_after = cancel_after
        self._checks = 0

    async def load_case(self) -> CaseSnapshot:
        return self.snapshot

    async def resolve_policies(self, snap: CaseSnapshot) -> list[dict]:
        return [
            {
                "policyId": t.policy_key,
                "policyVersionId": None,
                "sourceKey": t.policy_key,
                "title": t.title,
                "docType": "Payer Policy" if t.synthetic else "LCD",
                "version": t.policy_version,
                "matchReasons": [
                    {"type": "hcpcs", "value": c, "detail": "service code"}
                    for c in t.services
                    if c in snap.service_codes
                ],
                "score": 1.0,
                "criteriaSetStatus": "approved",
            }
            for t in self.trees
        ]

    async def load_criteria(self, snap: CaseSnapshot, matches: list[dict]) -> list[LoadedCriteria]:
        by_key = {m["sourceKey"]: m for m in matches}
        return [
            LoadedCriteria(tree=t, match=by_key.get(t.policy_key, {}), criteria_set_id=None)
            for t in self.trees
        ]

    async def index_chart(self, snap: CaseSnapshot, chunks: list[ChartChunk]) -> list[str]:
        self.chunks = chunks
        return []

    async def retrieve(
        self,
        snap: CaseSnapshot,
        leaf: CriterionLeaf,
        query: str,
        lexical: LexicalIndex,
        window: tuple[date | None, date | None],
        top_k: int,
    ) -> tuple[list[tuple[ChartChunk, float]], list[str]]:
        return lexical.search(query, top_k=top_k, not_before=window[0], not_after=window[1]), []

    async def persist_result(self, result: dict) -> dict:
        row = {**result, "id": str(uuid.uuid4())}
        self.results.append(row)
        return criterion_result_api(row)

    async def finish(self, summary: dict) -> dict:
        self.summary = summary
        return {"status": "awaiting_review", **{k: v for k, v in summary.items() if k != "tree_result"}}

    async def fail(self, error: str) -> None:
        self.failed = error

    async def publish(self, event: str, data: dict) -> None:
        self.events.append((event, data))

    async def cancelled(self) -> bool:
        self._checks += 1
        return self._cancel_after is not None and self._checks > self._cancel_after

    def event_names(self) -> list[str]:
        return [e for e, _ in self.events]

    def verdicts(self) -> dict[str, Any]:
        return {r["criterion_id"]: r["verdict"] for r in self.results}
