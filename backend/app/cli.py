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


async def _db_init() -> list[str]:
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
        await conn.run_sync(Base.metadata.create_all)
    await engine.dispose()
    return notes


@db_app.command("init")
def db_init() -> None:
    """Create all tables (and Postgres extensions where permitted)."""
    notes = asyncio.run(_db_init())
    for n in notes:
        console.print(f"  • {n}")
    console.print("[green]Database schema is ready.[/green]")


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
