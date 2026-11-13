"""Central configuration (12-factor). Every setting is overridable via env / .env.

Settings are grouped by concern; add new ones to the relevant section and never rename existing
ones (they are part of the deployment contract).
"""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic import Field, SecretStr, computed_field
from pydantic_settings import BaseSettings, SettingsConfigDict

REPO_ROOT = Path(__file__).resolve().parents[3]
BACKEND_ROOT = Path(__file__).resolve().parents[2]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=(str(REPO_ROOT / ".env"), str(BACKEND_ROOT / ".env")),
        env_file_encoding="utf-8",
        extra="ignore",
        case_sensitive=False,
    )

    # ── App ────────────────────────────────────────────────────────────────
    app_name: str = "Necessa"
    environment: Literal["dev", "test", "staging", "prod"] = "dev"
    debug: bool = False
    api_prefix: str = "/api/v1"
    public_app_url: str = "http://localhost:3000"
    cors_origins: list[str] = Field(default_factory=lambda: ["http://localhost:3000"])
    log_level: str = "INFO"
    log_json: bool = False

    # ── Security ───────────────────────────────────────────────────────────
    secret_key: SecretStr = SecretStr("dev-insecure-change-me-0123456789abcdef")
    # 32-byte urlsafe-base64 Fernet key for PHI-at-rest field encryption. Generate:
    #   python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
    phi_encryption_key: SecretStr = SecretStr("")
    access_token_ttl_minutes: int = 15
    refresh_token_ttl_days: int = 14
    password_min_length: int = 12
    cookie_secure: bool = False
    cookie_domain: str | None = None
    # Proxies whose X-Forwarded-For header is trusted (CIDRs allowed). Defaults cover the local
    # Next.js server; add your load balancer's range in production.
    trusted_proxies: list[str] = Field(default_factory=lambda: ["127.0.0.1", "::1"])
    rate_limit_per_minute: int = 120
    auth_rate_limit_per_minute: int = 10

    # ── Databases / infra (all free managed tiers in prod; tests use SQLite) ──
    # Postgres (Neon free tier recommended):  postgresql+asyncpg://user:pass@host/db?ssl=require
    database_url: str = "sqlite+aiosqlite:///./necessa-dev.db"
    database_echo: bool = False
    # Qdrant Cloud free tier (1 GB RAM / 4 GB disk). Empty => in-memory Qdrant (tests only).
    qdrant_url: str = ""
    qdrant_api_key: SecretStr = SecretStr("")
    qdrant_collection_prefix: str = "necessa"
    # Upstash Redis free tier (rediss://...). Empty => in-process fallback (single instance).
    redis_url: str = ""

    # ── LLM providers (free tiers; any missing key just disables that deployment) ──
    groq_api_key: SecretStr = SecretStr("")
    gemini_api_key: SecretStr = SecretStr("")
    openrouter_api_key: SecretStr = SecretStr("")
    cohere_api_key: SecretStr = SecretStr("")
    jina_api_key: SecretStr = SecretStr("")
    mistral_api_key: SecretStr = SecretStr("")
    cerebras_api_key: SecretStr = SecretStr("")
    github_models_token: SecretStr = SecretStr("")
    # Deterministic offline fakes for every LLM / embedding / rerank call (tests, keyless demos).
    llm_fake: bool = False
    llm_config_path: Path = BACKEND_ROOT / "app" / "ai" / "llm" / "models.yaml"
    llm_default_timeout_s: float = 45.0
    llm_daily_token_budget: int = 2_000_000
    case_token_budget: int = 60_000
    qa_token_budget: int = 12_000

    # Embeddings: the index is pinned to ONE model (no silent fallback across vector spaces).
    embedding_model: str = "gemini/gemini-embedding-001"
    embedding_dims: int = 768
    embedding_batch_size: int = 64

    # ── Observability ───────────────────────────────────────────────────────
    langfuse_public_key: str = ""
    langfuse_secret_key: SecretStr = SecretStr("")
    langfuse_host: str = "https://cloud.langfuse.com"

    # ── Data ────────────────────────────────────────────────────────────────
    data_dir: Path = REPO_ROOT / "data"
    mcd_base_url: str = "https://downloads.cms.gov/medicare-coverage-database/downloads/exports"
    # Default ingest scope keeps free-tier quotas and storage small (see docs/ARCHITECTURE.md §Ingestion).
    ingest_scope: Literal["focus", "full"] = "focus"
    accept_cms_license: bool = False  # must be true to download MCD (AMA/ADA/AHA terms)

    # ── Feature flags ───────────────────────────────────────────────────────
    enable_semantic_cache: bool = True
    enable_llm_rerank_fallback: bool = True
    demo_mode: bool = False  # seeds demo org + synthetic data on startup

    @computed_field  # type: ignore[prop-decorator]
    @property
    def is_sqlite(self) -> bool:
        return self.database_url.startswith("sqlite")

    @computed_field  # type: ignore[prop-decorator]
    @property
    def is_prod(self) -> bool:
        return self.environment == "prod"


@lru_cache
def get_settings() -> Settings:
    return Settings()
