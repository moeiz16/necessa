"""In-app notifications (+ live SSE stream for the current user)."""

from __future__ import annotations

import uuid
from collections.abc import AsyncIterator

from fastapi import APIRouter, Depends, Query, Response, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sse_starlette.sse import EventSourceResponse

from app.core.deps import RequestContext, get_ctx, get_db
from app.core.events import HEARTBEAT_SECONDS, format_sse, subscribe
from app.db.models.platform import Notification
from app.schemas.base import APIModel
from app.schemas.platform import NotificationOut
from app.services.notifications import mark_read

router = APIRouter(prefix="/notifications", tags=["notifications"])


class NotificationList(APIModel):
    items: list[NotificationOut]
    unread: int


@router.get("", response_model=NotificationList)
async def list_notifications(
    ctx: RequestContext = Depends(get_ctx),
    db: AsyncSession = Depends(get_db),
    unread_only: bool = Query(False, alias="unreadOnly"),
    limit: int = Query(30, ge=1, le=100),
):
    base = [Notification.org_id == ctx.org_id, Notification.user_id == ctx.user.id]
    q = select(Notification).where(*base)
    if unread_only:
        q = q.where(Notification.read_at.is_(None))
    rows = (await db.execute(q.order_by(Notification.created_at.desc()).limit(limit))).scalars().all()
    unread = (
        await db.execute(
            select(func.count()).select_from(Notification).where(*base, Notification.read_at.is_(None))
        )
    ).scalar_one()
    return NotificationList(items=[NotificationOut.model_validate(n) for n in rows], unread=unread)


@router.post("/read-all", status_code=status.HTTP_204_NO_CONTENT)
async def read_all(ctx: RequestContext = Depends(get_ctx), db: AsyncSession = Depends(get_db)) -> Response:
    await mark_read(db, ctx.org_id, ctx.user.id, None)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/{notification_id}/read", status_code=status.HTTP_204_NO_CONTENT)
async def read_one(
    notification_id: uuid.UUID, ctx: RequestContext = Depends(get_ctx), db: AsyncSession = Depends(get_db)
) -> Response:
    await mark_read(db, ctx.org_id, ctx.user.id, notification_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/stream")
async def stream(ctx: RequestContext = Depends(get_ctx)) -> EventSourceResponse:
    """SSE of the org channel, filtered to this user's notifications."""
    user_id = str(ctx.user.id)
    channel = f"org:{ctx.org_id}"

    async def events() -> AsyncIterator[dict]:
        import asyncio

        it = subscribe(channel).__aiter__()
        try:
            while True:
                try:
                    event, data = await asyncio.wait_for(it.__anext__(), timeout=HEARTBEAT_SECONDS)
                except TimeoutError:
                    yield format_sse("heartbeat", {})
                    continue
                if event == "notification" and data.get("userId") != user_id:
                    continue
                yield format_sse(event, data)
        finally:
            await it.aclose()  # type: ignore[attr-defined]

    return EventSourceResponse(
        events(), headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"}, ping=None
    )
