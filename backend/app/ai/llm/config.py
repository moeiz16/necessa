"""Loads app/ai/llm/models.yaml and resolves which deployments are actually usable."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path

import yaml

from app.core.config import get_settings

# provider env var -> Settings attribute
_ENV_TO_SETTING = {
    "GROQ_API_KEY": "groq_api_key",
    "GEMINI_API_KEY": "gemini_api_key",
    "OPENROUTER_API_KEY": "openrouter_api_key",
    "COHERE_API_KEY": "cohere_api_key",
    "JINA_API_KEY": "jina_api_key",
    "MISTRAL_API_KEY": "mistral_api_key",
    "CEREBRAS_API_KEY": "cerebras_api_key",
    "GITHUB_MODELS_TOKEN": "github_models_token",
}


@dataclass(frozen=True)
class Provider:
    name: str
    env: str
    prefix: str
    rpm: int = 30
    rpd: int = 1000
    tpm: int | None = None
    json_mode: bool = False
    note: str = ""

    def api_key(self) -> str:
        attr = _ENV_TO_SETTING.get(self.env)
        val = ""
        if attr:
            secret = getattr(get_settings(), attr, None)
            val = secret.get_secret_value() if secret is not None else ""
        return val or os.environ.get(self.env, "")

    @property
    def configured(self) -> bool:
        return bool(self.api_key())


@dataclass(frozen=True)
class Deployment:
    provider: Provider
    model: str

    @property
    def id(self) -> str:
        return f"{self.provider.name}:{self.model}"

    @property
    def litellm_model(self) -> str:
        return f"{self.provider.prefix}/{self.model}"


@dataclass
class Group:
    name: str
    purpose: str
    temperature: float
    max_tokens: int
    data_classes: list[str]
    deployments: list[Deployment]

    def available(self) -> list[Deployment]:
        return [d for d in self.deployments if d.provider.configured]


@dataclass
class EmbeddingConfig:
    model: str
    dims: int
    provider: Provider | None
    rpm: int = 100
    batch_size: int = 64
    alternatives: list[dict] = field(default_factory=list)


@dataclass
class RerankStep:
    provider: Provider | None = None
    model: str | None = None
    llm_group: str | None = None


@dataclass
class CatalogConfig:
    version: int
    defaults: dict
    providers: dict[str, Provider]
    groups: dict[str, Group]
    phi_allowed_groups: set[str]
    embedding: EmbeddingConfig
    rerank_chain: list[RerankStep]
    rerank_thresholds: dict[str, dict[str, float]]


def _load(path: Path) -> CatalogConfig:
    raw = yaml.safe_load(path.read_text(encoding="utf-8"))
    providers = {
        name: Provider(
            name=name,
            env=p["env"],
            prefix=p.get("prefix", name),
            rpm=int(p.get("rpm", 30)),
            rpd=int(p.get("rpd", 1000)),
            tpm=p.get("tpm"),
            json_mode=bool(p.get("json_mode", False)),
            note=p.get("note", ""),
        )
        for name, p in (raw.get("providers") or {}).items()
    }
    groups: dict[str, Group] = {}
    for name, g in (raw.get("groups") or {}).items():
        deps = [
            Deployment(provider=providers[d["provider"]], model=str(d["model"]))
            for d in g.get("deployments", [])
            if d.get("provider") in providers
        ]
        groups[name] = Group(
            name=name,
            purpose=g.get("purpose", ""),
            temperature=float(g.get("temperature", 0.0)),
            max_tokens=int(g.get("max_tokens", 800)),
            data_classes=list(g.get("data_classes", ["PUBLIC"])),
            deployments=deps,
        )
    s = get_settings()
    emb_raw = raw.get("embedding") or {}
    model = s.embedding_model or emb_raw.get("model", "gemini/gemini-embedding-001")
    prov_name = emb_raw.get("provider") or model.split("/", 1)[0]
    if model != emb_raw.get("model"):
        prov_name = model.split("/", 1)[0]
        if prov_name == "jina_ai":
            prov_name = "jina"
    embedding = EmbeddingConfig(
        model=model,
        dims=int(s.embedding_dims or emb_raw.get("dims", 768)),
        provider=providers.get(prov_name),
        rpm=int(emb_raw.get("rpm", 100)),
        batch_size=int(s.embedding_batch_size or emb_raw.get("batch_size", 64)),
        alternatives=list(emb_raw.get("alternatives", [])),
    )
    chain: list[RerankStep] = []
    rr = raw.get("rerank") or {}
    for step in rr.get("chain", []):
        if "llm_group" in step:
            chain.append(RerankStep(llm_group=step["llm_group"]))
        elif step.get("provider") in providers:
            chain.append(RerankStep(provider=providers[step["provider"]], model=step["model"]))
    return CatalogConfig(
        version=int(raw.get("version", 1)),
        defaults=dict(raw.get("defaults") or {}),
        providers=providers,
        groups=groups,
        phi_allowed_groups=set(raw.get("phi_allowed_groups") or []),
        embedding=embedding,
        rerank_chain=chain,
        rerank_thresholds={k: dict(v) for k, v in (rr.get("thresholds") or {}).items()},
    )


@lru_cache
def get_catalog() -> CatalogConfig:
    return _load(Path(get_settings().llm_config_path))


def reload_catalog() -> CatalogConfig:
    get_catalog.cache_clear()
    return get_catalog()
