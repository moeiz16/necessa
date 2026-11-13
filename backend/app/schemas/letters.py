from __future__ import annotations

from typing import Literal

from pydantic import Field

from app.schemas.base import APIModel

LetterKind = Literal["lmn", "pa_cover", "appeal", "peer_to_peer_prep"]


class LetterCreateIn(APIModel):
    kind: LetterKind = "lmn"
    denial_id: str | None = None


class LetterCreateOut(APIModel):
    letter_id: str
    job_id: str


class LetterPatch(APIModel):
    content_md: str | None = Field(default=None, max_length=60_000)
    status: Literal["draft", "in_review", "approved", "exported"] | None = None
