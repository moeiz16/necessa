"""Application errors rendered as RFC 7807 problem details."""

from __future__ import annotations

from typing import Any

import structlog
from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from app.core.logging import request_id_ctx

log = structlog.get_logger(__name__)

PROBLEM_JSON = "application/problem+json"

_DEFAULT_TITLES = {
    400: "Bad request",
    401: "Unauthorized",
    403: "Forbidden",
    404: "Not found",
    405: "Method not allowed",
    409: "Conflict",
    413: "Payload too large",
    415: "Unsupported media type",
    422: "Validation failed",
    429: "Too many requests",
    500: "Internal server error",
    503: "Service unavailable",
}


class AppError(Exception):
    """Raise anywhere in the app; rendered as `application/problem+json`."""

    def __init__(
        self,
        status: int,
        code: str,
        title: str | None = None,
        detail: str | None = None,
        *,
        errors: list[dict] | None = None,
        headers: dict[str, str] | None = None,
    ) -> None:
        super().__init__(detail or title or code)
        self.status = status
        self.code = code
        self.title = title or _DEFAULT_TITLES.get(status, "Error")
        self.detail = detail
        self.errors = errors
        self.headers = headers


def not_found(resource: str = "Resource") -> AppError:
    return AppError(404, "not_found", f"{resource} not found")


def forbidden(detail: str = "You do not have permission to perform this action.") -> AppError:
    return AppError(403, "forbidden", "Forbidden", detail)


def unauthorized(detail: str = "Authentication required.", code: str = "unauthorized") -> AppError:
    return AppError(401, code, "Unauthorized", detail, headers={"WWW-Authenticate": "Bearer"})


def conflict(code: str, detail: str) -> AppError:
    return AppError(409, code, "Conflict", detail)


def bad_request(code: str, detail: str, errors: list[dict] | None = None) -> AppError:
    return AppError(400, code, "Bad request", detail, errors=errors)


def problem(
    status: int,
    title: str,
    *,
    code: str | None = None,
    detail: str | None = None,
    errors: list[dict] | None = None,
    headers: dict[str, str] | None = None,
) -> JSONResponse:
    body: dict[str, Any] = {
        "type": f"https://necessa.dev/problems/{code}" if code else "about:blank",
        "title": title,
        "status": status,
    }
    if detail:
        body["detail"] = detail
    if code:
        body["code"] = code
    if errors:
        body["errors"] = errors
    rid = request_id_ctx.get()
    if rid:
        body["requestId"] = rid
    return JSONResponse(body, status_code=status, media_type=PROBLEM_JSON, headers=headers)


def _validation_errors(exc: RequestValidationError) -> list[dict]:
    out = []
    for err in exc.errors():
        loc = [str(p) for p in err.get("loc", ()) if p not in ("body", "query", "path")]
        out.append({"field": ".".join(loc) or None, "message": err.get("msg"), "type": err.get("type")})
    return out


def install_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(AppError)
    async def _app_error(_req: Request, exc: AppError) -> JSONResponse:
        return problem(
            exc.status, exc.title, code=exc.code, detail=exc.detail, errors=exc.errors, headers=exc.headers
        )

    @app.exception_handler(RequestValidationError)
    async def _validation(_req: Request, exc: RequestValidationError) -> JSONResponse:
        return problem(
            422,
            "Validation failed",
            code="validation_error",
            detail="One or more fields are invalid.",
            errors=_validation_errors(exc),
        )

    @app.exception_handler(StarletteHTTPException)
    async def _http(_req: Request, exc: StarletteHTTPException) -> JSONResponse:
        title = _DEFAULT_TITLES.get(exc.status_code, "Error")
        detail = exc.detail if isinstance(exc.detail, str) and exc.detail != title else None
        return problem(
            exc.status_code,
            title,
            code=title.lower().replace(" ", "_"),
            detail=detail,
            headers=getattr(exc, "headers", None),
        )

    @app.exception_handler(Exception)
    async def _unhandled(_req: Request, exc: Exception) -> JSONResponse:
        log.exception("unhandled_error", error_type=type(exc).__name__)
        return problem(
            500,
            "Internal server error",
            code="internal_error",
            detail="An unexpected error occurred. The incident has been logged.",
        )
