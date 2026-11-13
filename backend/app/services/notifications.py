"""In-app notifications, pushed live over the `org:{org_id}` SSE channel."""

from __future__ import annotations

import uuid
from collections.abc import Iterable

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.events import publish
from app.db.base import utcnow
from app.db.models.platform import Membership, Notification


async def notify(
    db: AsyncSession,
    *,
    org_id: uuid.UUID,
    type: str,
    title: str,
    body: str | None = None,
    link: str | None = None,
    user_ids: Iterable[uuid.UUID] | None = None,
    roles: Iterable[str] | None = None,
) -> list[Notification]:
    """Notify specific users, everyone with given roles, or (default) all active members."""
    if user_ids is None:
        q = select(Membership.user_id).where(Membership.org_id == org_id, Membership.status == "active")
        if roles:
            q = q.where(Membership.role.in_(list(roles)))
        user_ids = (await db.execute(q)).scalars().all()
    created: list[Notification] = []
    for uid in dict.fromkeys(user_ids):
        n = Notification(org_id=org_id, user_id=uid, type=type, title=title, body=body, link=link)
        db.add(n)
        created.append(n)
    await db.flush()
    for n in created:
        await publish(
            f"org:{org_id}",
            "notification",
            {
                "id": str(n.id),
                "userId": str(n.user_id),
                "type": n.type,
                "title": n.title,
                "body": n.body,
                "link": n.link,
                "createdAt": n.created_at.isoformat(),
            },
        )
    return created


async def mark_read(
    db: AsyncSession, org_id: uuid.UUID, user_id: uuid.UUID, notification_id: uuid.UUID | None
) -> int:
    stmt = update(Notification).where(
        Notification.org_id == org_id, Notification.user_id == user_id, Notification.read_at.is_(None)
    )
    if notification_id:
        stmt = stmt.where(Notification.id == notification_id)
    res = await db.execute(stmt.values(read_at=utcnow()))
    return res.rowcount or 0
