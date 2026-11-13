"""Base API schema: camelCase on the wire, snake_case in Python. SHARED FILE."""

from __future__ import annotations

from typing import Generic, TypeVar

from pydantic import BaseModel, ConfigDict
from pydantic.alias_generators import to_camel

T = TypeVar("T")


class APIModel(BaseModel):
    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,
        from_attributes=True,
        ser_json_timedelta="float",
    )


class Page(APIModel, Generic[T]):  # noqa: UP046 - keep pydantic generic syntax
    items: list[T]
    next_cursor: str | None = None
    total: int | None = None


class Problem(APIModel):
    """RFC 7807 problem details."""

    type: str = "about:blank"
    title: str
    status: int
    detail: str | None = None
    code: str | None = None
    errors: list[dict] | None = None
    request_id: str | None = None
