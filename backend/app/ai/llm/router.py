"""Multi-provider LLM router over LiteLLM (free tiers), with production controls.

Why a custom router on top of `litellm.acompletion` instead of `litellm.Router`:
the routing decision depends on *our* policies — data class (PHI only to allowed groups and only
when de-identified), proactive daily-quota avoidance, org/request token budgets, and structured
output repair — which are cleaner to enforce and test in one place. LiteLLM remains the provider
abstraction (one call shape for Groq, Gemini, OpenRouter, Mistral, Cerebras, GitHub, Cohere, Jina).
"""

from __future__ import annotations

import asyncio
import json
import math
import os
import random
import re
import time
from collections.abc import AsyncIterator
from typing import Any
from uuid import UUID

import structlog
from pydantic import BaseModel, ValidationError

from app.ai.guardrails.phi import detect_high_risk
from app.ai.llm import telemetry
from app.ai.llm.budget import RequestBudget, get_quota_tracker
from app.ai.llm.config import CatalogConfig, Deployment, Group, get_catalog
from app.ai.llm.types import (
    BudgetExceeded,
    DataClass,
    EmbeddingUnavailable,
    LLMResult,
    LLMUnavailable,
    PolicyViolation,
    StructuredOutputError,
)
from app.ai.textutil import estimate_tokens, extract_json, sha256_hex, word_tokens
from app.core.config import get_settings

log = structlog.get_logger(__name__)

_THINK = re.compile(r"<think>.*?</think>\s*", re.S | re.I)
_PUBLIC_BLOCKING = {"SSN", "MBI", "DOB", "LABELLED_ID"}


def _litellm():
    import litellm

    litellm.drop_params = True
    litellm.suppress_debug_info = True
    litellm.telemetry = False
    s = get_settings()
    if s.langfuse_public_key and s.langfuse_secret_key.get_secret_value():
        os.environ.setdefault("LANGFUSE_PUBLIC_KEY", s.langfuse_public_key)
        os.environ.setdefault("LANGFUSE_SECRET_KEY", s.langfuse_secret_key.get_secret_value())
        os.environ.setdefault("LANGFUSE_HOST", s.langfuse_host)
        if "langfuse" not in (litellm.success_callback or []):
            litellm.success_callback = [*list(litellm.success_callback or []), "langfuse"]
            litellm.failure_callback = [*list(litellm.failure_callback or []), "langfuse"]
    return litellm


def _retry_after_seconds(exc: Exception) -> float | None:
    for attr in ("response", "litellm_response_headers", "headers"):
        obj = getattr(exc, attr, None)
        headers = getattr(obj, "headers", obj)
        if headers is None:
            continue
        try:
            val = headers.get("retry-after") or headers.get("Retry-After")
        except Exception:  # noqa: S112 - header container without .get
            continue
        if val:
            try:
                return float(val)
            except ValueError:
                return None
    m = re.search(r"try again in ([\d.]+)\s*(ms|s)", str(exc), re.I)
    if m:
        v = float(m.group(1))
        return v / 1000 if m.group(2).lower() == "ms" else v
    return None


def _classify_error(exc: Exception) -> str:
    name = type(exc).__name__.lower()
    msg = str(exc).lower()
    if "ratelimit" in name or "429" in msg or "rate limit" in msg or "quota" in msg:
        return "rate_limited"
    if "authentication" in name or "permissiondenied" in name or "401" in msg or "invalid api key" in msg:
        return "auth"
    if "notfound" in name or "does not exist" in msg or "decommissioned" in msg:
        return "not_found"
    if "contextwindow" in name or "context length" in msg:
        return "context"
    if "badrequest" in name or "unsupported" in msg:
        return "bad_request"
    return "transient"


def _schema_instruction(model: type[BaseModel]) -> str:
    schema = json.dumps(model.model_json_schema(), separators=(",", ":"))
    return (
        "\n\nRespond with ONLY one JSON object (no prose, no code fences) that validates against this "
        f"JSON Schema:\n{schema}"
    )


def _all_text(messages: list[dict]) -> str:
    parts: list[str] = []
    for m in messages:
        c = m.get("content")
        if isinstance(c, str):
            parts.append(c)
        elif isinstance(c, list):
            parts.extend(str(p.get("text", "")) for p in c if isinstance(p, dict))
    return "\n".join(parts)


class LLMRouter:
    def __init__(self, catalog: CatalogConfig | None = None) -> None:
        self.catalog = catalog or get_catalog()
        self.quota = get_quota_tracker()
        self._embed_last_call = 0.0
        self._embed_lock = asyncio.Lock()

    # ── introspection ───────────────────────────────────────────────────────
    def configured_groups(self) -> dict[str, list[str]]:
        return {name: [d.id for d in g.available()] for name, g in self.catalog.groups.items()}

    def group(self, name: str) -> Group:
        g = self.catalog.groups.get(name)
        if g is None:
            raise LLMUnavailable(f"unknown model group '{name}'")
        return g

    def is_available(self, group: str) -> bool:
        g = self.catalog.groups.get(group)
        return bool(g and g.available())

    def embedding_available(self) -> bool:
        p = self.catalog.embedding.provider
        return bool(p and p.configured)

    def rerank_available(self) -> bool:
        return any((s.provider and s.provider.configured) for s in self.catalog.rerank_chain)

    async def status(self) -> dict:
        groups = []
        for name, g in self.catalog.groups.items():
            deps = []
            for d in g.deployments:
                deps.append(
                    {
                        "provider": d.provider.name,
                        "model": d.model,
                        "configured": d.provider.configured,
                        "rpm": d.provider.rpm,
                        "rpd": d.provider.rpd,
                        "usedToday": await self.quota.used_today(d.id),
                        **self.quota.health(d.id),
                    }
                )
            groups.append(
                {"name": name, "purpose": g.purpose, "dataClasses": g.data_classes, "deployments": deps}
            )
        emb = self.catalog.embedding
        return {
            "groups": groups,
            "embedding": {"model": emb.model, "dims": emb.dims, "configured": self.embedding_available()},
            "reranker": {
                "chain": [
                    {"provider": s.provider.name, "model": s.model, "configured": s.provider.configured}
                    if s.provider
                    else {"llmGroup": s.llm_group, "configured": self.is_available(s.llm_group or "")}
                    for s in self.catalog.rerank_chain
                ]
                + [{"provider": "lexical", "model": "token-overlap", "configured": True}]
            },
            "phiAllowedGroups": sorted(self.catalog.phi_allowed_groups),
            "fake": False,
        }

    # ── policy checks ───────────────────────────────────────────────────────
    def _enforce_data_class(
        self, group: Group, data_class: DataClass, deidentified: bool, messages: list[dict], purpose: str
    ) -> None:
        if data_class.value not in group.data_classes:
            self._blocked(group.name, purpose, data_class, f"group does not accept {data_class} data")
        if data_class == DataClass.PHI:
            if not deidentified:
                self._blocked(
                    group.name, purpose, data_class, "PHI must be de-identified before any LLM call"
                )
            if group.name not in self.catalog.phi_allowed_groups:
                self._blocked(group.name, purpose, data_class, "group not allowed for PHI")
        residual = detect_high_risk(_all_text(messages))
        if data_class != DataClass.PHI:
            residual = [r for r in residual if r in _PUBLIC_BLOCKING]
        if residual:
            self._blocked(
                group.name, purpose, data_class, f"residual identifiers detected: {','.join(residual)}"
            )

    def _blocked(self, group: str, purpose: str, data_class: DataClass, reason: str) -> None:
        telemetry.record(
            telemetry.CallRecord(
                group=group,
                purpose=purpose,
                provider="-",
                model="-",
                data_class=data_class.value,
                status="blocked",
                error=reason,
            )
        )
        raise PolicyViolation(reason)

    async def _candidates(self, group: Group) -> list[Deployment]:
        out = []
        for d in group.available():
            if self.quota.cooling_until(d.id):
                continue
            if await self.quota.over_daily_quota(d.id, d.provider.rpd):
                continue
            out.append(d)
        return out

    # ── completion ──────────────────────────────────────────────────────────
    async def complete(
        self,
        *,
        group: str,
        messages: list[dict],
        purpose: str,
        data_class: DataClass = DataClass.PUBLIC,
        deidentified: bool = False,
        response_model: type[BaseModel] | None = None,
        temperature: float | None = None,
        max_tokens: int | None = None,
        org_id: UUID | None = None,
        cache: bool = True,
        timeout_s: float | None = None,
        budget: RequestBudget | None = None,
        request_id: str | None = None,
    ) -> LLMResult:
        g = self.group(group)
        data_class = DataClass(data_class)
        self._enforce_data_class(g, data_class, deidentified, messages, purpose)
        temp = g.temperature if temperature is None else temperature
        max_tok = max_tokens or g.max_tokens
        msgs = [dict(m) for m in messages]
        if response_model is not None:
            instr = _schema_instruction(response_model)
            if msgs and msgs[0].get("role") == "system":
                msgs[0]["content"] = f"{msgs[0]['content']}{instr}"
            else:
                msgs.insert(0, {"role": "system", "content": instr.strip()})
        estimate = estimate_tokens(_all_text(msgs)) + max_tok
        if budget is not None and not budget.can_spend(estimate // 2):
            raise BudgetExceeded(f"{budget.label} budget exhausted")
        if not await self.quota.org_budget_ok(str(org_id) if org_id else None, estimate):
            raise BudgetExceeded("organization daily token budget exhausted")

        cache_key = None
        if cache and temp == 0:
            cache_key = "llm:" + sha256_hex(
                group,
                json.dumps(msgs, sort_keys=True, default=str),
                response_model.__name__ if response_model else "",
                str(max_tok),
            )
            from app.ai.cache import exact_get

            hit = await exact_get(cache_key)
            if hit is not None:
                parsed = (
                    response_model.model_validate(hit["parsed"])
                    if response_model and hit.get("parsed")
                    else None
                )
                telemetry.record(
                    telemetry.CallRecord(
                        group=group,
                        purpose=purpose,
                        provider=hit.get("provider", "cache"),
                        model=hit.get("model", ""),
                        data_class=data_class.value,
                        cache_hit=True,
                        org_id=org_id,
                        request_id=request_id,
                    )
                )
                return LLMResult(
                    text=hit["text"],
                    parsed=parsed,
                    model=hit.get("model", ""),
                    provider=hit.get("provider", ""),
                    cached=True,
                )

        candidates = await self._candidates(g)
        if not candidates:
            raise LLMUnavailable(
                f"no available deployment for group '{group}' (missing keys, cooldown or quota)"
            )

        litellm = _litellm()
        attempts: list[dict] = []
        timeout = timeout_s or float(
            self.catalog.defaults.get("timeout_s", get_settings().llm_default_timeout_s)
        )
        max_retries = int(self.catalog.defaults.get("max_retries_per_deployment", 1))
        last_exc: Exception | None = None
        for idx, dep in enumerate(candidates):
            for attempt in range(max_retries + 1):
                t0 = time.perf_counter()
                try:
                    kwargs: dict[str, Any] = {
                        "model": dep.litellm_model,
                        "messages": msgs,
                        "temperature": temp,
                        "max_tokens": max_tok,
                        "api_key": dep.provider.api_key(),
                        "timeout": timeout,
                        "num_retries": 0,
                    }
                    if response_model is not None and dep.provider.json_mode:
                        kwargs["response_format"] = {"type": "json_object"}
                    resp = await litellm.acompletion(**kwargs)
                    text = _THINK.sub("", resp.choices[0].message.content or "").strip()
                    usage = getattr(resp, "usage", None)
                    p_tok = int(getattr(usage, "prompt_tokens", 0) or estimate_tokens(_all_text(msgs)))
                    c_tok = int(getattr(usage, "completion_tokens", 0) or estimate_tokens(text))
                    parsed = None
                    if response_model is not None:
                        parsed, text, extra = await self._parse_or_repair(
                            litellm, kwargs, text, response_model
                        )
                        p_tok += extra[0]
                        c_tok += extra[1]
                    latency = int((time.perf_counter() - t0) * 1000)
                    await self.quota.record_request(dep.id, p_tok + c_tok, latency, True)
                    if org_id:
                        await self.quota.add_org_tokens(str(org_id), p_tok + c_tok)
                    if budget is not None:
                        budget.charge(p_tok + c_tok)
                    telemetry.record(
                        telemetry.CallRecord(
                            group=group,
                            purpose=purpose,
                            provider=dep.provider.name,
                            model=dep.model,
                            data_class=data_class.value,
                            prompt_tokens=p_tok,
                            completion_tokens=c_tok,
                            latency_ms=latency,
                            fallback_used=idx > 0,
                            attempt=len(attempts) + 1,
                            org_id=org_id,
                            request_id=request_id,
                        )
                    )
                    result = LLMResult(
                        text=text,
                        parsed=parsed,
                        model=dep.model,
                        provider=dep.provider.name,
                        prompt_tokens=p_tok,
                        completion_tokens=c_tok,
                        latency_ms=latency,
                        fallback_used=idx > 0,
                        attempts=attempts,
                    )
                    if cache_key:
                        from app.ai.cache import exact_set

                        await exact_set(
                            cache_key,
                            {
                                "text": text,
                                "model": dep.model,
                                "provider": dep.provider.name,
                                "parsed": parsed.model_dump() if parsed else None,
                            },
                            ttl=86400,
                        )
                    return result
                except BudgetExceeded:
                    raise
                except StructuredOutputError as exc:
                    last_exc = exc
                    attempts.append({"deployment": dep.id, "error": "structured_output"})
                    await self.quota.record_request(dep.id, 0, int((time.perf_counter() - t0) * 1000), False)
                    break  # next deployment
                except Exception as exc:
                    last_exc = exc
                    kind = _classify_error(exc)
                    latency = int((time.perf_counter() - t0) * 1000)
                    attempts.append({"deployment": dep.id, "error": kind, "detail": str(exc)[:300]})
                    await self.quota.record_request(dep.id, 0, latency, False)
                    telemetry.record(
                        telemetry.CallRecord(
                            group=group,
                            purpose=purpose,
                            provider=dep.provider.name,
                            model=dep.model,
                            data_class=data_class.value,
                            latency_ms=latency,
                            fallback_used=idx > 0,
                            attempt=len(attempts),
                            status="rate_limited" if kind == "rate_limited" else "error",
                            error=f"{kind}: {str(exc)[:500]}",
                            org_id=org_id,
                            request_id=request_id,
                        )
                    )
                    if kind == "rate_limited":
                        ra = _retry_after_seconds(exc)
                        self.quota.cooldown(dep.id, ra or float(self.catalog.defaults.get("cooldown_s", 60)))
                        break
                    if kind in {"auth", "not_found"}:
                        self.quota.cooldown(
                            dep.id, float(self.catalog.defaults.get("auth_error_cooldown_s", 3600))
                        )
                        break
                    if kind in {"bad_request", "context"}:
                        break
                    if attempt < max_retries:
                        await asyncio.sleep(min(4.0, 0.4 * (2**attempt)) + random.random() * 0.3)  # noqa: S311
                        continue
                    self.quota.cooldown(dep.id, 15)
        log.warning("llm.group_exhausted", group=group, purpose=purpose, attempts=attempts)
        if isinstance(last_exc, StructuredOutputError):
            raise last_exc
        raise LLMUnavailable(
            f"all deployments failed for group '{group}': {attempts[-1] if attempts else ''}"
        )

    async def _parse_or_repair(
        self, litellm: Any, kwargs: dict, text: str, model: type[BaseModel]
    ) -> tuple[BaseModel, str, tuple[int, int]]:
        try:
            return model.model_validate(extract_json(text)), text, (0, 0)
        except (ValueError, ValidationError) as first_err:
            repair_msgs = [
                *kwargs["messages"],
                {"role": "assistant", "content": text[:6000]},
                {
                    "role": "user",
                    "content": (
                        f"That output was invalid: {str(first_err)[:600]}\n"
                        "Return ONLY the corrected JSON object."
                    ),
                },
            ]
            try:
                resp = await litellm.acompletion(**{**kwargs, "messages": repair_msgs})
                fixed = _THINK.sub("", resp.choices[0].message.content or "").strip()
                usage = getattr(resp, "usage", None)
                extra = (
                    int(getattr(usage, "prompt_tokens", 0) or 0),
                    int(getattr(usage, "completion_tokens", 0) or 0),
                )
                return model.model_validate(extract_json(fixed)), fixed, extra
            except Exception as exc:
                raise StructuredOutputError(f"schema repair failed: {exc}") from exc

    # ── streaming ───────────────────────────────────────────────────────────
    async def stream(
        self,
        *,
        group: str,
        messages: list[dict],
        purpose: str,
        data_class: DataClass = DataClass.PUBLIC,
        deidentified: bool = False,
        temperature: float | None = None,
        max_tokens: int | None = None,
        org_id: UUID | None = None,
        timeout_s: float | None = None,
        budget: RequestBudget | None = None,
        info: dict | None = None,
        request_id: str | None = None,
        **_: Any,
    ) -> AsyncIterator[str]:
        """Yield text deltas. Falls back across deployments until the first token arrives.
        `info` (if given) is filled with provider/model/usage/latency at the end."""
        g = self.group(group)
        data_class = DataClass(data_class)
        self._enforce_data_class(g, data_class, deidentified, messages, purpose)
        temp = g.temperature if temperature is None else temperature
        max_tok = max_tokens or g.max_tokens
        estimate = estimate_tokens(_all_text(messages)) + max_tok
        if budget is not None and not budget.can_spend(estimate // 2):
            raise BudgetExceeded(f"{budget.label} budget exhausted")
        candidates = await self._candidates(g)
        if not candidates:
            raise LLMUnavailable(f"no available deployment for group '{group}'")
        litellm = _litellm()
        timeout = timeout_s or float(self.catalog.defaults.get("timeout_s", 45))
        for idx, dep in enumerate(candidates):
            t0 = time.perf_counter()
            produced: list[str] = []
            usage = None
            try:
                resp = await litellm.acompletion(
                    model=dep.litellm_model,
                    messages=messages,
                    temperature=temp,
                    max_tokens=max_tok,
                    api_key=dep.provider.api_key(),
                    timeout=timeout,
                    stream=True,
                    stream_options={"include_usage": True},
                    num_retries=0,
                )
                in_think = False
                async for chunk in resp:
                    u = getattr(chunk, "usage", None)
                    if u:
                        usage = u
                    if not getattr(chunk, "choices", None):
                        continue
                    delta = getattr(chunk.choices[0].delta, "content", None) or ""
                    if not delta:
                        continue
                    if "<think>" in delta:
                        in_think = True
                    if in_think:
                        if "</think>" in delta:
                            in_think = False
                            delta = delta.split("</think>", 1)[1]
                        else:
                            continue
                    produced.append(delta)
                    yield delta
                text = "".join(produced)
                p_tok = int(getattr(usage, "prompt_tokens", 0) or estimate_tokens(_all_text(messages)))
                c_tok = int(getattr(usage, "completion_tokens", 0) or estimate_tokens(text))
                latency = int((time.perf_counter() - t0) * 1000)
                await self.quota.record_request(dep.id, p_tok + c_tok, latency, True)
                if org_id:
                    await self.quota.add_org_tokens(str(org_id), p_tok + c_tok)
                if budget is not None:
                    budget.used += p_tok + c_tok
                telemetry.record(
                    telemetry.CallRecord(
                        group=group,
                        purpose=purpose,
                        provider=dep.provider.name,
                        model=dep.model,
                        data_class=data_class.value,
                        prompt_tokens=p_tok,
                        completion_tokens=c_tok,
                        latency_ms=latency,
                        fallback_used=idx > 0,
                        org_id=org_id,
                        request_id=request_id,
                    )
                )
                if info is not None:
                    info.update(
                        provider=dep.provider.name,
                        model=dep.model,
                        prompt_tokens=p_tok,
                        completion_tokens=c_tok,
                        latency_ms=latency,
                        fallback_used=idx > 0,
                    )
                return
            except Exception as exc:
                kind = _classify_error(exc)
                latency = int((time.perf_counter() - t0) * 1000)
                await self.quota.record_request(dep.id, 0, latency, False)
                telemetry.record(
                    telemetry.CallRecord(
                        group=group,
                        purpose=purpose,
                        provider=dep.provider.name,
                        model=dep.model,
                        data_class=data_class.value,
                        latency_ms=latency,
                        status="error",
                        error=f"{kind}: {str(exc)[:500]}",
                        org_id=org_id,
                    )
                )
                if produced:
                    raise LLMUnavailable(f"stream interrupted: {kind}") from exc
                if kind == "rate_limited":
                    self.quota.cooldown(dep.id, _retry_after_seconds(exc) or 60)
                elif kind in {"auth", "not_found"}:
                    self.quota.cooldown(dep.id, 3600)
                continue
        raise LLMUnavailable(f"all deployments failed to stream for group '{group}'")

    # ── embeddings (pinned model; no cross-model fallback) ─────────────────
    async def embed(
        self, texts: list[str], *, task: str = "document", purpose: str = "embed"
    ) -> list[list[float]]:
        emb = self.catalog.embedding
        if not texts:
            return []
        if not emb.provider or not emb.provider.configured:
            raise EmbeddingUnavailable(f"embedding provider for {emb.model} is not configured")
        from app.ai.cache import embedding_cache

        out: list[list[float] | None] = [embedding_cache.get(emb.model, t) for t in texts]
        missing = [i for i, v in enumerate(out) if v is None]
        litellm = _litellm()
        min_interval = 60.0 / max(1, emb.rpm)
        for start in range(0, len(missing), emb.batch_size):
            idxs = missing[start : start + emb.batch_size]
            batch = [texts[i][:8000] for i in idxs]
            for attempt in range(5):
                async with self._embed_lock:
                    wait = self._embed_last_call + min_interval - time.monotonic()
                    if wait > 0:
                        await asyncio.sleep(wait)
                    self._embed_last_call = time.monotonic()
                t0 = time.perf_counter()
                try:
                    resp = await litellm.aembedding(
                        model=emb.model,
                        input=batch,
                        api_key=emb.provider.api_key(),
                        dimensions=emb.dims,
                        timeout=60,
                    )
                    vecs = [
                        list(map(float, d["embedding"] if isinstance(d, dict) else d.embedding))
                        for d in resp.data
                    ]
                    latency = int((time.perf_counter() - t0) * 1000)
                    tokens = sum(estimate_tokens(t) for t in batch)
                    telemetry.record(
                        telemetry.CallRecord(
                            group="embedding",
                            purpose=purpose,
                            provider=emb.provider.name,
                            model=emb.model,
                            prompt_tokens=tokens,
                            latency_ms=latency,
                        )
                    )
                    for i, v in zip(idxs, vecs, strict=True):
                        v = _l2(v[: emb.dims])
                        out[i] = v
                        embedding_cache.put(emb.model, texts[i], v)
                    break
                except Exception as exc:
                    kind = _classify_error(exc)
                    telemetry.record(
                        telemetry.CallRecord(
                            group="embedding",
                            purpose=purpose,
                            provider=emb.provider.name,
                            model=emb.model,
                            status="rate_limited" if kind == "rate_limited" else "error",
                            error=str(exc)[:500],
                        )
                    )
                    if kind in {"auth", "not_found", "bad_request"} or attempt == 4:
                        raise EmbeddingUnavailable(f"embedding failed: {kind}: {str(exc)[:200]}") from exc
                    delay = _retry_after_seconds(exc) or min(30.0, 2.0 * (2**attempt))
                    await asyncio.sleep(min(delay, 60.0))
        return [v for v in out if v is not None]

    # ── rerank chain: cohere → jina → LLM listwise → lexical ───────────────
    async def rerank(
        self, query: str, documents: list[str], *, top_n: int, purpose: str = "rerank"
    ) -> list[tuple[int, float]]:
        res, _ = await self.rerank_with_info(query, documents, top_n=top_n, purpose=purpose)
        return res

    async def rerank_with_info(
        self, query: str, documents: list[str], *, top_n: int, purpose: str = "rerank"
    ) -> tuple[list[tuple[int, float]], str]:
        if not documents:
            return [], "none"
        top_n = min(top_n, len(documents))
        litellm = None
        for step in self.catalog.rerank_chain:
            if step.provider is not None:
                dep_id = f"{step.provider.name}:{step.model}"
                if not step.provider.configured or self.quota.cooling_until(dep_id):
                    continue
                litellm = litellm or _litellm()
                t0 = time.perf_counter()
                try:
                    resp = await litellm.arerank(
                        model=f"{step.provider.prefix}/{step.model}",
                        query=query,
                        documents=[d[:4000] for d in documents],
                        top_n=top_n,
                        api_key=step.provider.api_key(),
                    )
                    results = resp.results if hasattr(resp, "results") else resp["results"]
                    pairs = [(int(r["index"]), float(r["relevance_score"])) for r in results]
                    latency = int((time.perf_counter() - t0) * 1000)
                    await self.quota.record_request(dep_id, 0, latency, True)
                    telemetry.record(
                        telemetry.CallRecord(
                            group="rerank",
                            purpose=purpose,
                            provider=step.provider.name,
                            model=step.model,
                            latency_ms=latency,
                        )
                    )
                    return sorted(pairs, key=lambda p: -p[1])[:top_n], step.provider.name
                except Exception as exc:
                    kind = _classify_error(exc)
                    await self.quota.record_request(dep_id, 0, int((time.perf_counter() - t0) * 1000), False)
                    self.quota.cooldown(dep_id, _retry_after_seconds(exc) or (3600 if kind == "auth" else 60))
                    telemetry.record(
                        telemetry.CallRecord(
                            group="rerank",
                            purpose=purpose,
                            provider=step.provider.name,
                            model=step.model,
                            status="error",
                            error=str(exc)[:300],
                        )
                    )
                    continue
            elif (
                step.llm_group
                and self.is_available(step.llm_group)
                and get_settings().enable_llm_rerank_fallback
            ):
                try:
                    return await self._llm_listwise(query, documents, top_n, step.llm_group, purpose), "llm"
                except Exception as exc:
                    log.debug("rerank.llm_failed", error=str(exc))
                    continue
        return lexical_rerank(query, documents, top_n), "lexical"

    async def _llm_listwise(
        self, query: str, documents: list[str], top_n: int, group: str, purpose: str
    ) -> list[tuple[int, float]]:
        from app.ai.prompts.loader import render

        class _Ranking(BaseModel):
            ranking: list[int]

        passages = "\n".join(f'<passage id="{i}">{d[:600]}</passage>' for i, d in enumerate(documents[:20]))
        prompt, _ = render("route_rerank", query=query, passages=passages, top_n=top_n)
        res = await self.complete(
            group=group,
            purpose=f"{purpose}.listwise",
            messages=[{"role": "user", "content": prompt}],
            response_model=_Ranking,
            max_tokens=200,
        )
        order = [i for i in res.parsed.ranking if 0 <= i < len(documents)]  # type: ignore[union-attr]
        seen: list[int] = []
        for i in order:
            if i not in seen:
                seen.append(i)
        n = max(1, len(seen))
        return [(i, round(1.0 - r / (n + 1), 4)) for r, i in enumerate(seen[:top_n])]


def _l2(v: list[float]) -> list[float]:
    norm = math.sqrt(sum(x * x for x in v)) or 1.0
    return [x / norm for x in v]


def lexical_rerank(query: str, documents: list[str], top_n: int) -> list[tuple[int, float]]:
    """Deterministic last-resort reranker: stemmed token overlap with exact-code boost."""
    from app.ai.sparse import is_code_token, tokenize

    q = set(tokenize(query)) or set(word_tokens(query))
    if not q:
        return [(i, 0.0) for i in range(min(top_n, len(documents)))]
    codes = {t for t in q if is_code_token(t)}
    scored = []
    for i, d in enumerate(documents):
        dt = set(tokenize(d))
        overlap = len(q & dt) / len(q)
        code_bonus = 0.3 * (len(codes & dt) / len(codes)) if codes else 0.0
        scored.append((i, round(min(1.0, overlap * 0.8 + code_bonus), 4)))
    scored.sort(key=lambda p: -p[1])
    return scored[:top_n]


_router: Any = None


def get_llm_router() -> LLMRouter:
    """Singleton. `LLM_FAKE=true` (or ENVIRONMENT=test) returns the deterministic FakeLLMRouter."""
    global _router
    if _router is None:
        from app.ai.infra import llm_fake_enabled

        if llm_fake_enabled():
            from app.ai.llm.fake import FakeLLMRouter

            _router = FakeLLMRouter()
        else:
            _router = LLMRouter()
    return _router


def set_llm_router(router: Any) -> None:
    """Override (tests / dependency injection)."""
    global _router
    _router = router
