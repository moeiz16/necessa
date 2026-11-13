"""Assistant ("Ask Necessa") and analytics-ask schemas."""

from __future__ import annotations

from datetime import date, datetime
from typing import Literal

from pydantic import Field

from app.schemas.base import APIModel


class ConversationIn(APIModel):
    title: str | None = Field(None, max_length=200)


class ConversationPatch(APIModel):
    title: str | None = Field(None, max_length=200)
    pinned: bool | None = None


class MessageOut(APIModel):
    id: str
    conversation_id: str | None = None
    role: Literal["user", "assistant"]
    content: str
    citations: list[dict] = Field(default_factory=list)
    route: dict | None = None
    retrieval: dict | None = None
    guardrails: list[dict] = Field(default_factory=list)
    sql: dict | None = None
    usage: dict = Field(default_factory=dict)
    feedback: int | None = None
    created_at: datetime


class ConversationOut(APIModel):
    id: str
    title: str
    pinned: bool = False
    created_at: datetime
    updated_at: datetime
    last_message: str | None = None
    message_count: int = 0


class ConversationDetail(ConversationOut):
    messages: list[MessageOut] = Field(default_factory=list)


class MessageIn(APIModel):
    content: str = Field(min_length=1, max_length=4000)
    as_of: date | None = None
    case_id: str | None = None
    mode: Literal["auto", "policy", "analytics", "codes"] = "auto"


class MessageFeedbackIn(APIModel):
    rating: Literal[1, -1]
    reason: str | None = Field(None, max_length=120)
    comment: str | None = Field(None, max_length=2000)


class Suggestion(APIModel):
    label: str
    prompt: str
    mode: str = "auto"


class AnalyticsAskIn(APIModel):
    question: str = Field(min_length=3, max_length=1000)


class AnalyticsAskOut(APIModel):
    question: str
    sql: str
    columns: list[str]
    rows: list[list]
    summary: str
    chart_hint: dict
    warnings: list[str]
    method: str
    row_count: int = 0
    views: list[str] = Field(default_factory=list)
