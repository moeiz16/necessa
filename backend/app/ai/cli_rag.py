"""`necessa rag …` — ingestion, index ops, retrieval debugging, model status.

necessa rag ingest download            # CMS MCD CSV exports → data/raw (needs ACCEPT_CMS_LICENSE=true)
necessa rag ingest run --scope focus   # parse → persist → chunk → index (blue/green)
necessa rag ingest fixtures            # synthetic payer policies (offline demo)
necessa rag index list | activate <id> | rollback | prune
necessa rag search "knee arthroscopy conservative therapy" --state TX --trace
necessa rag models status | test --group qa-public
"""

from __future__ import annotations

import asyncio
import json
import uuid
from datetime import date

import typer
from rich.console import Console
from rich.table import Table

app = typer.Typer(help="Knowledge base & hybrid retrieval (workstream B)", no_args_is_help=True)
ingest_app = typer.Typer(help="Ingestion", no_args_is_help=True)
index_app = typer.Typer(help="Index versions (blue/green)", no_args_is_help=True)
models_app = typer.Typer(help="LLM providers", no_args_is_help=True)
app.add_typer(ingest_app, name="ingest")
app.add_typer(index_app, name="index")
app.add_typer(models_app, name="models")
console = Console()


async def _ensure_schema() -> None:
    """Dev convenience on SQLite: create missing tables (Postgres uses Alembic migrations)."""
    from app.core.config import get_settings

    if not get_settings().is_sqlite:
        return
    import app.db.models  # noqa: F401
    from app.db.base import Base
    from app.db.session import get_engine

    async with get_engine().begin() as conn:
        await conn.run_sync(Base.metadata.create_all)


def _run(coro):
    return asyncio.run(coro)


async def _progress(p: float, m: str) -> None:
    console.print(f"[dim]{p * 100:5.1f}%[/dim] {m}")


@ingest_app.command("download")
def ingest_download() -> None:
    """Download CMS MCD weekly exports (CSV only)."""
    from app.ai.ingestion.download import LicenseNotAccepted, download_mcd

    try:
        out = _run(download_mcd())
    except LicenseNotAccepted as exc:
        console.print(f"[yellow]{exc}[/yellow]")
        raise typer.Exit(2) from exc
    console.print_json(json.dumps(out, default=str))


@ingest_app.command("run")
def ingest_run(
    scope: str = typer.Option("focus", help="focus | full"),
    keys: list[str] = typer.Option(None, "--key", help="Only these policy keys (e.g. L33718, A52369)"),
    limit: int = typer.Option(None, help="Cap LCD count (smoke runs)"),
    no_index: bool = typer.Option(False, "--no-index", help="Persist only; skip index build"),
) -> None:
    """Parse MCD exports, persist incrementally, build + activate a new index version."""
    from app.ai.ingestion.pipeline import run_ingestion
    from app.db.session import session_scope

    async def go() -> dict:
        await _ensure_schema()
        async with session_scope() as s:
            return await run_ingestion(
                s,
                source="mcd",
                scope=scope,
                policy_keys=keys or None,
                limit=limit,
                progress=_progress,
                build_index=not no_index,
            )

    console.print_json(json.dumps(_run(go()), default=str))


@ingest_app.command("fixtures")
def ingest_fixtures() -> None:
    """Load the synthetic payer policies shipped in the repo (no license needed)."""
    from app.ai.ingestion.pipeline import run_ingestion
    from app.db.session import session_scope

    async def go() -> dict:
        await _ensure_schema()
        async with session_scope() as s:
            return await run_ingestion(s, source="fixtures", progress=_progress)

    console.print_json(json.dumps(_run(go()), default=str))


@ingest_app.command("codesets")
def ingest_codesets() -> None:
    """Load the optional CDC ICD-10-CM order file from data/raw/icd10cm/."""
    from app.ai.ingestion.pipeline import run_ingestion
    from app.db.session import session_scope

    async def go() -> dict:
        await _ensure_schema()
        async with session_scope() as s:
            return await run_ingestion(s, source="codesets", progress=_progress)

    console.print_json(json.dumps(_run(go()), default=str))


@index_app.command("list")
def index_list() -> None:
    from sqlalchemy import select

    from app.db.models.knowledge import IndexVersion
    from app.db.session import session_scope

    async def go():
        await _ensure_schema()
        async with session_scope() as s:
            return list(
                (await s.execute(select(IndexVersion).order_by(IndexVersion.created_at.desc()))).scalars()
            )

    t = Table("id", "alias", "physical", "status", "points", "embed", "created")
    for iv in _run(go()):
        t.add_row(
            str(iv.id)[:8],
            iv.alias,
            iv.physical_name,
            iv.status,
            str(iv.points),
            iv.embed_model or "-",
            iv.created_at.strftime("%Y-%m-%d %H:%M"),
        )
    console.print(t)


@index_app.command("activate")
def index_activate(index_id: str) -> None:
    from sqlalchemy import select

    from app.ai.ingestion.indexer import activate_index
    from app.db.models.knowledge import IndexVersion
    from app.db.session import session_scope

    async def go():
        async with session_scope() as s:
            rows = list((await s.execute(select(IndexVersion))).scalars())
            iv = next((r for r in rows if str(r.id).startswith(index_id)), None)
            if iv is None:
                raise typer.BadParameter("unknown index id")
            return (await activate_index(s, iv)).physical_name

    console.print(f"[green]active:[/green] {_run(go())}")


@index_app.command("rollback")
def index_rollback(alias: str = "policy_chunks") -> None:
    from app.ai.ingestion.indexer import rollback_index
    from app.db.session import session_scope

    async def go():
        async with session_scope() as s:
            iv = await rollback_index(s, alias)
            return iv.physical_name if iv else None

    console.print(f"[green]active:[/green] {_run(go())}")


@index_app.command("prune")
def index_prune(keep: int = 2) -> None:
    """Drop retired physical collections beyond the newest `keep` (free-tier storage hygiene)."""
    from app.ai.ingestion.indexer import prune_old_indexes
    from app.db.session import session_scope

    async def go():
        async with session_scope() as s:
            return await prune_old_indexes(s, keep=keep)

    console.print(_run(go()))


@app.command("search")
def search(
    query: str,
    state: str = typer.Option(None),
    as_of: str = typer.Option(None, "--as-of"),
    strategy: str = typer.Option(None, help="force S1..S11"),
    top_k: int = 6,
    trace: bool = typer.Option(True, help="print the route trace"),
) -> None:
    """Run the hybrid retriever and pretty-print the route trace and ranked chunks."""
    from app.ai.retrieval.retriever import get_retriever
    from app.ai.retrieval.types import PolicyFilters, RetrievalQuery

    async def go():
        await _ensure_schema()
        f = PolicyFilters(
            states=[state] if state else None, as_of=date.fromisoformat(as_of) if as_of else None
        )
        return await get_retriever().search(
            RetrievalQuery(text=query, org_id=uuid.UUID(int=0), filters=f, top_k=top_k, strategy=strategy)
        )

    res = _run(go())
    if trace:
        r = res.route
        console.rule("[bold]route")
        console.print(f"intent=[cyan]{r.intent}[/cyan] ({r.confidence}) strategy=[cyan]{r.strategy}[/cyan]")
        console.print(
            f"retrievers={r.retrievers} fusion={r.fusion} rerank={r.rerank} "
            f"corrective={r.corrective_iterations}"
        )
        console.print(f"transforms={r.transforms} filters={r.filters_applied} degraded={r.degraded}")
        console.print(f"abstained={r.abstained} reason={r.reason}")
        console.print(f"timings={res.timings}")
    t = Table("#", "score", "key", "section", "dense", "sparse", "fts", "rerank", "text")
    for i, c in enumerate(res.chunks, 1):
        s = c.scores
        t.add_row(
            str(i),
            f"{c.score:.3f}",
            c.source.get("source_key") or "",
            c.source.get("section_key") or "",
            f"{s.get('dense', 0):.3f}",
            f"{s.get('sparse', 0):.2f}",
            f"{s.get('fts', 0):.2f}",
            f"{s.get('rerank', 0):.3f}",
            c.text[:90].replace("\n", " "),
        )
    console.print(t)


@models_app.command("status")
def models_status() -> None:
    from app.ai.llm.router import get_llm_router

    st = _run(get_llm_router().status())
    t = Table("group", "provider", "model", "configured", "healthy", "used today")
    for g in st["groups"]:
        for d in g["deployments"]:
            t.add_row(
                g["name"],
                d["provider"],
                d["model"],
                "✔" if d["configured"] else "-",
                "✔" if d.get("healthy") else "-",
                str(d.get("usedToday", 0)),
            )
    console.print(t)
    console.print(f"embedding: {st['embedding']}  fake={st.get('fake')}")


@models_app.command("test")
def models_test(group: str = "qa-public") -> None:
    from app.ai.llm.router import get_llm_router

    async def go():
        return await get_llm_router().complete(
            group=group,
            purpose="cli.model_test",
            cache=False,
            max_tokens=30,
            messages=[{"role": "user", "content": "Reply with: ready"}],
        )

    res = _run(go())
    console.print(f"[green]{res.provider}/{res.model}[/green] {res.latency_ms}ms → {res.text!r}")


if __name__ == "__main__":  # pragma: no cover
    app()
