"""Deterministic offline LLM router (tests + `LLM_FAKE=true` dev mode). No network, no models.

* `embed`: feature-hashed bag of stemmed terms + bigrams + code tokens → L2-normalized vector.
  Not semantic like a neural embedder, but deterministic and lexically meaningful, so offline
  retrieval tests exercise the real dense code path.
* `complete`: purpose-keyed handlers (registerable); `qa.answer*` produces an extractive answer
  with citations from the <source> blocks in the prompt.
* `rerank`: lexical overlap.
"""

from __future__ import annotations

import itertools
import math
import re
from collections.abc import AsyncIterator, Callable
from typing import Any

from pydantic import BaseModel, ValidationError

from app.ai.llm import telemetry
from app.ai.llm.config import get_catalog
from app.ai.llm.router import _all_text, lexical_rerank
from app.ai.llm.types import DataClass, LLMResult, PolicyViolation, StructuredOutputError
from app.ai.sparse import is_code_token, token_index, tokenize
from app.ai.textutil import estimate_tokens, extract_json, split_sentences, word_tokens
from app.core.config import get_settings

Handler = Callable[[list[dict], type[BaseModel] | None], Any]


def fake_embedding(text: str, dims: int) -> list[float]:
    toks = tokenize(text)
    vec = [0.0] * dims
    feats: list[tuple[str, float]] = [(t, 2.0 if is_code_token(t) else 1.0) for t in toks]
    feats += [(f"{a}_{b}", 0.5) for a, b in itertools.pairwise(toks)]
    for f, w in feats:
        h = token_index(f)
        vec[h % dims] += w if (h >> 16) & 1 else -w
    norm = math.sqrt(sum(x * x for x in vec)) or 1.0
    return [x / norm for x in vec]


_SOURCE = re.compile(r'<source n="(\d+)"[^>]*>(.*?)</source>', re.S)


def extractive_answer(question: str, sources: list[tuple[int, str]], max_points: int = 4) -> str:
    """Pick the most question-relevant sentences from the provided sources, with [n] citations."""
    q = set(word_tokens(question))
    scored: list[tuple[float, int, str]] = []
    for n, text in sources:
        for sent in split_sentences(text)[:40]:
            st = set(word_tokens(sent))
            if len(st) < 5:
                continue
            score = len(q & st) / (len(q) or 1) + 0.02 * min(len(st), 30) / 30
            scored.append((score, n, sent.strip()))
    scored.sort(key=lambda x: -x[0])
    picked: list[str] = []
    used: set[str] = set()
    for _, n, sent in scored:
        if sent in used:
            continue
        used.add(sent)
        picked.append(f"- {sent} [{n}]")
        if len(picked) >= max_points:
            break
    if not picked:
        return "I could not find enough evidence in the indexed policies to answer this."
    return "Based on the retrieved policy text:\n\n" + "\n".join(picked)


class FakeLLMRouter:
    fake = True

    def __init__(self) -> None:
        self.catalog = get_catalog()
        self.handlers: dict[str, Handler] = {}
        self.calls: list[dict] = []
        self.register("qa.answer", self._qa_answer)

    def register(self, purpose_prefix: str, handler: Handler) -> None:
        self.handlers[purpose_prefix] = handler

    def _handler(self, purpose: str) -> Handler | None:
        best = None
        for prefix, h in self.handlers.items():
            if purpose.startswith(prefix) and (best is None or len(prefix) > len(best[0])):
                best = (prefix, h)
        return best[1] if best else None

    @staticmethod
    def _qa_answer(messages: list[dict], _model: type[BaseModel] | None) -> str:
        text = _all_text(messages)
        q = re.search(r"<question>(.*?)</question>", text, re.S)
        sources = [(int(n), body) for n, body in _SOURCE.findall(text)]
        return extractive_answer(q.group(1) if q else text[-500:], sources)

    # ── interface parity with LLMRouter ─────────────────────────────────────
    def configured_groups(self) -> dict[str, list[str]]:
        return {g: [f"fake:{g}"] for g in self.catalog.groups}

    def is_available(self, group: str) -> bool:
        return group in self.catalog.groups

    def embedding_available(self) -> bool:
        return True

    def rerank_available(self) -> bool:
        return True

    async def status(self) -> dict:
        return {
            "groups": [
                {
                    "name": n,
                    "purpose": g.purpose,
                    "dataClasses": g.data_classes,
                    "deployments": [
                        {
                            "provider": "fake",
                            "model": "deterministic",
                            "configured": True,
                            "healthy": True,
                            "rpm": 0,
                            "rpd": 0,
                            "usedToday": 0,
                            "p50LatencyMs": 0,
                            "errorRate": 0.0,
                            "cooldownUntil": None,
                        }
                    ],
                }
                for n, g in self.catalog.groups.items()
            ],
            "embedding": {
                "model": "fake/hash-embedding",
                "dims": get_settings().embedding_dims,
                "configured": True,
            },
            "reranker": {"chain": [{"provider": "fake", "model": "lexical", "configured": True}]},
            "phiAllowedGroups": sorted(self.catalog.phi_allowed_groups),
            "fake": True,
        }

    def _check(self, group: str, data_class: DataClass, deidentified: bool) -> None:
        g = self.catalog.groups.get(group)
        if g is None:
            from app.ai.llm.types import LLMUnavailable

            raise LLMUnavailable(f"unknown model group '{group}'")
        if DataClass(data_class) == DataClass.PHI and (
            not deidentified or group not in self.catalog.phi_allowed_groups
        ):
            raise PolicyViolation("PHI must be de-identified and routed to an allowed group")

    async def complete(
        self,
        *,
        group: str,
        messages: list[dict],
        purpose: str,
        data_class: DataClass = DataClass.PUBLIC,
        deidentified: bool = False,
        response_model: type[BaseModel] | None = None,
        **kwargs: Any,
    ) -> LLMResult:
        self._check(group, data_class, deidentified)
        self.calls.append({"group": group, "purpose": purpose, "messages": messages})
        handler = self._handler(purpose)
        out: Any = handler(messages, response_model) if handler else ""
        parsed = None
        if response_model is not None:
            try:
                if isinstance(out, BaseModel):
                    parsed = out
                elif isinstance(out, dict):
                    parsed = response_model.model_validate(out)
                elif isinstance(out, str) and out.strip():
                    parsed = response_model.model_validate(extract_json(out))
                else:
                    parsed = response_model.model_validate({})
            except (ValidationError, ValueError) as exc:
                raise StructuredOutputError(f"fake router has no scripted output for '{purpose}'") from exc
            text = parsed.model_dump_json()
        else:
            text = out if isinstance(out, str) else str(out)
        p_tok, c_tok = estimate_tokens(_all_text(messages)), estimate_tokens(text)
        budget = kwargs.get("budget")
        if budget is not None:
            budget.charge(p_tok + c_tok)
        telemetry.record(
            telemetry.CallRecord(
                group=group,
                purpose=purpose,
                provider="fake",
                model="deterministic",
                data_class=DataClass(data_class).value,
                prompt_tokens=p_tok,
                completion_tokens=c_tok,
                org_id=kwargs.get("org_id"),
            )
        )
        return LLMResult(
            text=text,
            parsed=parsed,
            model="deterministic",
            provider="fake",
            prompt_tokens=p_tok,
            completion_tokens=c_tok,
        )

    async def stream(
        self, *, group: str, messages: list[dict], purpose: str, info: dict | None = None, **kwargs: Any
    ) -> AsyncIterator[str]:
        res = await self.complete(
            group=group,
            messages=messages,
            purpose=purpose,
            **{k: v for k, v in kwargs.items() if k in {"data_class", "deidentified", "org_id"}},
        )
        if info is not None:
            info.update(
                provider="fake",
                model="deterministic",
                prompt_tokens=res.prompt_tokens,
                completion_tokens=res.completion_tokens,
                latency_ms=0,
                fallback_used=False,
            )
        for piece in re.findall(r"\S+\s*", res.text):
            yield piece

    async def embed(
        self, texts: list[str], *, task: str = "document", purpose: str = "embed"
    ) -> list[list[float]]:
        dims = get_settings().embedding_dims
        return [fake_embedding(t, dims) for t in texts]

    async def rerank(
        self, query: str, documents: list[str], *, top_n: int, purpose: str = "rerank"
    ) -> list[tuple[int, float]]:
        return lexical_rerank(query, documents, top_n)

    async def rerank_with_info(
        self, query: str, documents: list[str], *, top_n: int, purpose: str = "rerank"
    ) -> tuple[list[tuple[int, float]], str]:
        return lexical_rerank(query, documents, top_n), "fake"
