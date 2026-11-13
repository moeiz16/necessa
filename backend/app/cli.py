"""Necessa command line: `python -m app.cli --help`."""

from __future__ import annotations

import asyncio
import importlib

import typer
from rich.console import Console

app = typer.Typer(name="necessa", help="Necessa platform CLI", no_args_is_help=True)
db_app = typer.Typer(help="Database management", no_args_is_help=True)
user_app = typer.Typer(help="User management", no_args_is_help=True)
app.add_typer(db_app, name="db")
app.add_typer(user_app, name="user")
console = Console()

_PG_EXTENSIONS = ("pg_trgm", "pgcrypto")


async def _db_init(*, create_tables: bool) -> list[str]:
    from sqlalchemy import text

    import app.db.models  # noqa: F401
    from app.db.base import Base
    from app.db.session import get_engine

    notes: list[str] = []
    engine = get_engine()
    async with engine.begin() as conn:
        if engine.dialect.name == "postgresql":
            for ext in _PG_EXTENSIONS:
                try:
                    async with conn.begin_nested():
                        await conn.execute(text(f"CREATE EXTENSION IF NOT EXISTS {ext}"))
                    notes.append(f"extension {ext}: ok")
                except Exception as exc:  # managed providers may restrict some extensions
                    notes.append(f"extension {ext}: skipped ({type(exc).__name__})")
        if create_tables:
            await conn.run_sync(Base.metadata.create_all)
    await engine.dispose()
    return notes


def _alembic_config():  # type: ignore[no-untyped-def]
    from alembic.config import Config

    from app.core.config import BACKEND_ROOT

    cfg = Config(str(BACKEND_ROOT / "alembic.ini"))
    cfg.set_main_option("script_location", str(BACKEND_ROOT / "alembic"))
    return cfg


@db_app.command("init")
def db_init() -> None:
    """Prepare the schema: Alembic migrations on Postgres; create_all + stamp on SQLite (dev/test)."""
    from alembic import command

    from app.core.config import get_settings

    sqlite = get_settings().is_sqlite
    notes = asyncio.run(_db_init(create_tables=sqlite))
    if sqlite:
        command.stamp(_alembic_config(), "head")
        notes.append("sqlite: tables created, revision stamped at head")
    else:
        command.upgrade(_alembic_config(), "head")
        notes.append("postgres: migrations applied (RLS, search indexes, analytics views)")
    for n in notes:
        console.print(f"  • {n}")
    console.print("[green]Database schema is ready.[/green]")


@db_app.command("migrate")
def db_migrate(revision: str = typer.Argument("head", help="Target revision")) -> None:
    """Apply Alembic migrations up to REVISION."""
    from alembic import command

    command.upgrade(_alembic_config(), revision)
    console.print(f"[green]Migrated to {revision}.[/green]")


async def _create_user(email: str, password: str, full_name: str, superuser: bool) -> str:
    from app.db.session import get_engine, session_scope
    from app.services.auth import create_user

    async with session_scope() as db:
        user = await create_user(
            db, email=email, password=password, full_name=full_name, is_superuser=superuser
        )
        uid = str(user.id)
    await get_engine().dispose()
    return uid


@user_app.command("create")
def user_create(
    email: str = typer.Option(..., help="Login email"),
    password: str = typer.Option(..., prompt=True, hide_input=True, confirmation_prompt=True),
    full_name: str = typer.Option("Administrator", "--full-name"),
    superuser: bool = typer.Option(False, "--superuser", help="Grant platform-admin rights"),
) -> None:
    """Create a user account."""
    uid = asyncio.run(_create_user(email, password, full_name, superuser))
    console.print(f"[green]Created user[/green] {email} ({uid}){' as superuser' if superuser else ''}")


@app.command("serve")
def serve(host: str = "127.0.0.1", port: int = 8000, reload: bool = False) -> None:
    """Run the API with uvicorn."""
    import uvicorn

    uvicorn.run("app.main:app", host=host, port=port, reload=reload, proxy_headers=True)


def _attach(module: str, name: str) -> None:
    try:
        mod = importlib.import_module(module)
    except ModuleNotFoundError as exc:
        if exc.name == module:
            return
        raise
    sub = getattr(mod, "app", None)
    if isinstance(sub, typer.Typer):
        app.add_typer(sub, name=name)


_attach("app.ai.cli_rag", "rag")
_attach("app.ai.cli_cases", "cases")


if __name__ == "__main__":
    app()
