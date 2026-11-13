"""LLMRouter policy enforcement and fallback behavior (litellm is monkeypatched — no network)."""

from __future__ import annotations

import types

import pytest
from pydantic import BaseModel

from app.ai.llm.config import get_catalog
from app.ai.llm.router import LLMRouter, lexical_rerank
from app.ai.llm.types import DataClass, LLMUnavailable, PolicyViolation


class Out(BaseModel):
    verdict: str
    confidence: float


def _resp(text: str):
    return types.SimpleNamespace(
        choices=[types.SimpleNamespace(message=types.SimpleNamespace(content=text))],
        usage=types.SimpleNamespace(prompt_tokens=11, completion_tokens=7),
    )


@pytest.fixture
def keys(monkeypatch):
    monkeypatch.setenv("GROQ_API_KEY", "test-groq")
    monkeypatch.setenv("GEMINI_API_KEY", "test-gemini")
    from app.ai.llm import budget

    budget._tracker = None
    from app.ai import cache

    cache.disable_db_cache()
    yield
    budget._tracker = None


@pytest.mark.asyncio
async def test_phi_requires_deidentification(keys):
    r = LLMRouter(get_catalog())
    with pytest.raises(PolicyViolation):
        await r.complete(
            group="judge",
            purpose="t",
            data_class=DataClass.PHI,
            messages=[{"role": "user", "content": "chart text"}],
        )


@pytest.mark.asyncio
async def test_phi_blocked_for_non_allowed_group(keys):
    r = LLMRouter(get_catalog())
    with pytest.raises(PolicyViolation):
        await r.complete(
            group="compiler-longctx",
            purpose="t",
            data_class=DataClass.PHI,
            deidentified=True,
            messages=[{"role": "user", "content": "chart text"}],
        )


@pytest.mark.asyncio
async def test_residual_identifier_scan_blocks_public_calls(keys):
    r = LLMRouter(get_catalog())
    with pytest.raises(PolicyViolation):
        await r.complete(
            group="qa-public",
            purpose="t",
            messages=[{"role": "user", "content": "Patient SSN 123-45-6789 needs CPAP"}],
        )


@pytest.mark.asyncio
async def test_no_configured_keys_means_unavailable(monkeypatch):
    for k in (
        "GROQ_API_KEY",
        "GEMINI_API_KEY",
        "OPENROUTER_API_KEY",
        "CEREBRAS_API_KEY",
        "MISTRAL_API_KEY",
        "GITHUB_MODELS_TOKEN",
    ):
        monkeypatch.delenv(k, raising=False)
    r = LLMRouter(get_catalog())
    with pytest.raises(LLMUnavailable):
        await r.complete(
            group="qa-public", purpose="t", cache=False, messages=[{"role": "user", "content": "hi"}]
        )


@pytest.mark.asyncio
async def test_rate_limit_falls_back_and_structured_output_is_repaired(keys, monkeypatch):
    import litellm

    calls: list[str] = []

    class RateLimited(Exception):
        def __init__(self) -> None:
            super().__init__("429 rate limit exceeded")
            self.response = types.SimpleNamespace(headers={"retry-after": "12"})

    async def fake_acompletion(**kw):
        calls.append(kw["model"])
        if kw["model"].startswith("groq/"):
            raise RateLimited()
        if len([c for c in calls if c.startswith("gemini/")]) == 1:
            return _resp("not json at all")
        return _resp('```json\n{"verdict": "MET", "confidence": 0.9}\n```')

    monkeypatch.setattr(litellm, "acompletion", fake_acompletion)
    r = LLMRouter(get_catalog())
    res = await r.complete(
        group="judge",
        purpose="t",
        response_model=Out,
        cache=False,
        messages=[{"role": "user", "content": "judge this"}],
    )
    assert res.parsed == Out(verdict="MET", confidence=0.9)
    assert res.provider == "gemini"
    # groq deployment is now cooling down (Retry-After honored)
    assert any(r.quota.cooling_until(d.id) for d in r.group("judge").deployments if d.provider.name == "groq")


def test_lexical_rerank_prefers_code_matches():
    docs = [
        "Coverage of power wheelchairs K0823 requires a face-to-face exam",
        "CPAP E0601 adherence 4 hours",
    ]
    ranked = lexical_rerank("E0601 adherence requirement", docs, 2)
    assert ranked[0][0] == 1
