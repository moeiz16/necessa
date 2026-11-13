"""Case-intelligence CLI, mounted by app/cli.py as `necessa cases …`:

    necessa cases seed demo                   # demo org + users + 14 evaluated cases (offline)
    necessa cases criteria list | sync | compile L33718 | approve <id>
    necessa cases eval run --suite verdicts [--live] [--limit 40] [--fail-on-gate]
    necessa cases case evaluate <case-id>
"""

from __future__ import annotations

import asyncio
import json
import uuid

import typer
from rich.console import Console
from rich.table import Table

console = Console()
app = typer.Typer(help="Cases, criteria, demo data and evaluations")
seed_app = typer.Typer(help="Demo data")
criteria_app = typer.Typer(help="Criteria sets (compile, review, approve)")
eval_app = typer.Typer(help="Evaluation suites")
case_app = typer.Typer(help="Case operations")
app.add_typer(seed_app, name="seed")
app.add_typer(criteria_app, name="criteria")
app.add_typer(eval_app, name="eval")
app.add_typer(case_app, name="case")


def register(root: typer.Typer) -> None:
    """Attach the sub-command groups directly to the root CLI (`necessa seed …`, `necessa eval …`)."""
    root.add_typer(seed_app, name="seed")
    root.add_typer(criteria_app, name="criteria")
    root.add_typer(eval_app, name="eval")
    root.add_typer(case_app, name="case")


async def _ensure_schema() -> None:
    from app.core.config import get_settings

    if get_settings().is_sqlite:
        import app.db.models  # noqa: F401
        from app.db.base import Base
        from app.db.session import get_engine

        async with get_engine().begin() as conn:
            await conn.run_sync(Base.metadata.create_all)


@seed_app.command("demo")
def seed_demo(
    org_id: str = typer.Option(None, help="Seed cases into an existing org instead of creating the demo org"),
):
    """Create the 'Riverbend Orthopedics & Spine' demo org with users and fully evaluated cases."""
    from app.ai.synthetic.demo_seed import seed_demo_cases, seed_demo_org

    async def _run():
        await _ensure_schema()
        if org_id:
            return await seed_demo_cases(org_id=uuid.UUID(org_id), actor_id=None)
        return await seed_demo_org()

    out = asyncio.run(_run())
    console.print_json(json.dumps(out, default=str))


@criteria_app.command("list")
def criteria_list(status: str = typer.Option(None)):
    from sqlalchemy import select

    from app.db.models.criteria import CriteriaSet
    from app.db.session import get_sessionmaker

    async def _run():
        await _ensure_schema()
        async with get_sessionmaker()() as db:
            q = select(CriteriaSet).order_by(CriteriaSet.policy_key)
            if status:
                q = q.where(CriteriaSet.status == status)
            return (await db.execute(q)).scalars().all()

    rows = asyncio.run(_run())
    t = Table("id", "policy", "status", "source", "grounding", "agreement", "title")
    for r in rows:
        t.add_row(
            str(r.id)[:8],
            r.policy_key,
            r.status,
            r.source,
            f"{r.grounding_pass_rate}",
            f"{r.agreement}",
            r.title[:60],
        )
    console.print(t)


@criteria_app.command("sync")
def criteria_sync():
    """Upsert the curated (approved) criteria sets shipped with the product."""
    from app.ai.compiler.criteria_compiler import sync_curated
    from app.db.session import session_scope

    async def _run():
        await _ensure_schema()
        async with session_scope() as db:
            return [(c.policy_key, c.status) for c in await sync_curated(db)]

    for key, st in asyncio.run(_run()):
        console.print(f"[green]✓[/green] {key} → {st}")


@criteria_app.command("compile")
def criteria_compile(source_keys: list[str]):
    """Compile criteria for ingested policies with the LLM (grounded + cross-verified)."""
    from app.ai.compiler.criteria_compiler import compile_policy
    from app.ai.llm.router import get_llm_router
    from app.db.session import session_scope

    async def _run():
        await _ensure_schema()
        out = {}
        for key in source_keys:
            async with session_scope() as db:
                try:
                    cs = await compile_policy(db, policy_key=key, router=get_llm_router())
                    out[key] = f"{cs.status} (grounding {cs.grounding_pass_rate}, agreement {cs.agreement})"
                except Exception as exc:
                    out[key] = f"error: {exc}"
        return out

    for k, v in asyncio.run(_run()).items():
        console.print(f"{k}: {v}")


@criteria_app.command("approve")
def criteria_approve(set_id: str, force: bool = typer.Option(False)):
    from app.ai.compiler.criteria_compiler import _supersede, index_criteria_set
    from app.db.base import utcnow
    from app.db.models.criteria import CriteriaSet
    from app.db.session import session_scope

    async def _run():
        async with session_scope() as db:
            cs = await db.get(CriteriaSet, uuid.UUID(set_id))
            if cs is None:
                raise typer.BadParameter("criteria set not found")
            if (cs.grounding_pass_rate or 0) < 1.0 and not force:
                raise typer.BadParameter("grounding < 100% — fix quotes or pass --force")
            await _supersede(db, cs.policy_key)
            cs.status, cs.reviewed_at = "approved", utcnow()
            await db.flush()
            await index_criteria_set(cs)
            return cs.policy_key

    console.print(f"approved {asyncio.run(_run())}")


@eval_app.command("run")
def eval_run(
    suite: str = typer.Option("verdicts", "--suite", "-s"),
    live: bool = typer.Option(False),
    limit: int = typer.Option(None),
    no_persist: bool = typer.Option(False),
    fail_on_gate: bool = typer.Option(False, help="exit 1 if a gate fails (CI)"),
):
    from app.ai.evaluation.runner import run_suite

    async def _run():
        if not no_persist:
            await _ensure_schema()
        return await run_suite(suite, live=live, limit=limit, persist=not no_persist)

    out = asyncio.run(_run())
    t = Table("gate", "op", "threshold", "value", "pass")
    for k, g in out["gates"].items():
        t.add_row(k, g["op"], str(g["threshold"]), str(g["value"]), "✅" if g["passed"] else "❌")
    console.print(f"[bold]{suite}[/bold] — {out['status']} ({out['passed']}/{out['items']} items)")
    console.print(t)
    console.print(f"report: {out.get('report', {}).get('markdown')}")
    if fail_on_gate and out["status"] != "passed":
        raise typer.Exit(code=1)


@case_app.command("evaluate")
def case_evaluate(case_id: str):
    """Run an evaluation synchronously (no job runner) and print the summary."""
    from app.ai.jobs_cases import run_case_evaluation

    class _Ctx:
        def __init__(self) -> None:
            self.params = {"caseId": case_id}
            self.created_by = None
            self.org_id = None
            self.job_id = None

        async def progress(self, pct: float, message: str = "") -> None:
            console.print(f"[{pct:4.0%}] {message}")

    console.print_json(json.dumps(asyncio.run(run_case_evaluation(_Ctx())), default=str))
