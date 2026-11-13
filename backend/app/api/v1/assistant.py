"""Ask Necessa: conversations, streamed answers (SSE), feedback, prompt suggestions, analytics ask."""

from __future__ import annotations

import uuid
from collections.abc import AsyncIterator

from fastapi import APIRouter, Depends, Query, Response, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sse_starlette.sse import EventSourceResponse

from app.ai.agents.qa_graph import run_assistant_turn
from app.ai.sql.text_to_sql import answer_analytics
from app.core.deps import RequestContext, get_db, require_perm
from app.core.errors import not_found
from app.core.events import format_sse
from app.db.models.platform import Conversation, Feedback, Message
from app.schemas.assistant import (
    AnalyticsAskIn,
    AnalyticsAskOut,
    ConversationDetail,
    ConversationIn,
    ConversationOut,
    ConversationPatch,
    MessageFeedbackIn,
    MessageIn,
    MessageOut,
    Suggestion,
)
from app.schemas.base import Page
from app.services.audit import audit

router = APIRouter(tags=["assistant"])


async def _conversation(db: AsyncSession, ctx: RequestContext, conversation_id: uuid.UUID) -> Conversation:
    conv = await db.get(Conversation, conversation_id)
    if conv is None or conv.org_id != ctx.org_id or conv.user_id != ctx.user.id:
        raise not_found("Conversation")
    return conv


def _msg(m: Message) -> MessageOut:
    return MessageOut(
        id=str(m.id),
        role=m.role,
        content=m.content,
        citations=m.citations or [],
        route=m.route,
        sql=m.sql,
        usage=m.usage or {},
        feedback=m.feedback,
        created_at=m.created_at,
    )


@router.get("/assistant/conversations", response_model=Page[ConversationOut])
async def list_conversations(
    ctx: RequestContext = Depends(require_perm("assistant:use")),
    db: AsyncSession = Depends(get_db),
    limit: int = Query(30, ge=1, le=100),
    q: str | None = Query(None, max_length=200),
):
    stmt = select(Conversation).where(Conversation.org_id == ctx.org_id, Conversation.user_id == ctx.user.id)
    if q:
        stmt = stmt.where(func.lower(Conversation.title).like(f"%{q.lower()}%"))
    convs = list(
        (
            await db.execute(
                stmt.order_by(Conversation.pinned.desc(), Conversation.updated_at.desc()).limit(limit)
            )
        ).scalars()
    )
    ids = [c.id for c in convs]
    counts = (
        dict(
            (
                await db.execute(
                    select(Message.conversation_id, func.count())
                    .where(Message.conversation_id.in_(ids))
                    .group_by(Message.conversation_id)
                )
            ).all()
        )
        if ids
        else {}
    )
    last: dict[uuid.UUID, str] = {}
    for c in convs:
        m = (
            await db.execute(
                select(Message.content)
                .where(Message.conversation_id == c.id)
                .order_by(Message.created_at.desc())
                .limit(1)
            )
        ).scalar_one_or_none()
        if m:
            last[c.id] = m[:160]
    items = [
        ConversationOut(
            id=str(c.id),
            title=c.title,
            pinned=c.pinned,
            created_at=c.created_at,
            updated_at=c.updated_at,
            last_message=last.get(c.id),
            message_count=counts.get(c.id, 0),
        )
        for c in convs
    ]
    return Page[ConversationOut](items=items, next_cursor=None, total=len(items))


@router.post("/assistant/conversations", response_model=ConversationOut, status_code=201)
async def create_conversation(
    body: ConversationIn,
    ctx: RequestContext = Depends(require_perm("assistant:use")),
    db: AsyncSession = Depends(get_db),
):
    conv = Conversation(org_id=ctx.org_id, user_id=ctx.user.id, title=body.title or "New conversation")
    db.add(conv)
    await db.flush()
    await db.refresh(conv)
    return ConversationOut(
        id=str(conv.id),
        title=conv.title,
        pinned=conv.pinned,
        created_at=conv.created_at,
        updated_at=conv.updated_at,
    )


@router.get("/assistant/conversations/{conversation_id}", response_model=ConversationDetail)
async def get_conversation(
    conversation_id: uuid.UUID,
    ctx: RequestContext = Depends(require_perm("assistant:use")),
    db: AsyncSession = Depends(get_db),
):
    conv = await _conversation(db, ctx, conversation_id)
    msgs = list(
        (
            await db.execute(
                select(Message).where(Message.conversation_id == conv.id).order_by(Message.created_at)
            )
        ).scalars()
    )
    return ConversationDetail(
        id=str(conv.id),
        title=conv.title,
        pinned=conv.pinned,
        created_at=conv.created_at,
        updated_at=conv.updated_at,
        message_count=len(msgs),
        last_message=msgs[-1].content[:160] if msgs else None,
        messages=[_msg(m) for m in msgs],
    )


@router.patch("/assistant/conversations/{conversation_id}", response_model=ConversationOut)
async def patch_conversation(
    conversation_id: uuid.UUID,
    body: ConversationPatch,
    ctx: RequestContext = Depends(require_perm("assistant:use")),
    db: AsyncSession = Depends(get_db),
):
    conv = await _conversation(db, ctx, conversation_id)
    if body.title is not None:
        conv.title = body.title.strip() or conv.title
    if body.pinned is not None:
        conv.pinned = body.pinned
    await db.flush()
    return ConversationOut(
        id=str(conv.id),
        title=conv.title,
        pinned=conv.pinned,
        created_at=conv.created_at,
        updated_at=conv.updated_at,
    )


@router.delete("/assistant/conversations/{conversation_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_conversation(
    conversation_id: uuid.UUID,
    ctx: RequestContext = Depends(require_perm("assistant:use")),
    db: AsyncSession = Depends(get_db),
) -> Response:
    conv = await _conversation(db, ctx, conversation_id)
    for m in (await db.execute(select(Message).where(Message.conversation_id == conv.id))).scalars():
        await db.delete(m)
    await db.delete(conv)
    await audit(
        db,
        ctx,
        action="assistant.conversation_deleted",
        resource_type="conversation",
        resource_id=conversation_id,
    )
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/assistant/conversations/{conversation_id}/messages")
async def post_message(
    conversation_id: uuid.UUID,
    body: MessageIn,
    ctx: RequestContext = Depends(require_perm("assistant:use")),
    db: AsyncSession = Depends(get_db),
) -> EventSourceResponse:
    conv = await _conversation(db, ctx, conversation_id)
    case_id = uuid.UUID(body.case_id) if body.case_id else None
    if body.mode == "analytics" and not ctx.has("analytics:read"):
        from app.core.errors import forbidden

        raise forbidden("Analytics questions require the analytics:read permission.")
    await audit(
        db,
        ctx,
        action="assistant.message",
        resource_type="conversation",
        resource_id=conv.id,
        metadata={"mode": body.mode, "caseId": body.case_id},
    )
    await db.commit()
    org_id, user_id = ctx.org_id, ctx.user.id

    async def stream() -> AsyncIterator[dict]:
        async for event, data in run_assistant_turn(
            org_id=org_id,
            user_id=user_id,
            conversation_id=conv.id,
            content=body.content,
            as_of=body.as_of,
            case_id=case_id,
            mode=body.mode,
        ):
            yield format_sse(event, data)

    return EventSourceResponse(
        stream(), headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"}, ping=15
    )


@router.post("/assistant/messages/{message_id}/feedback", status_code=status.HTTP_204_NO_CONTENT)
async def message_feedback(
    message_id: uuid.UUID,
    body: MessageFeedbackIn,
    ctx: RequestContext = Depends(require_perm("assistant:use")),
    db: AsyncSession = Depends(get_db),
) -> Response:
    msg = await db.get(Message, message_id)
    if msg is None or msg.org_id != ctx.org_id:
        raise not_found("Message")
    msg.feedback = body.rating
    db.add(
        Feedback(
            org_id=ctx.org_id,
            user_id=ctx.user.id,
            target_type="answer",
            target_id=str(message_id),
            rating=body.rating,
            reason=body.reason,
            comment=body.comment,
        )
    )
    return Response(status_code=status.HTTP_204_NO_CONTENT)


_SUGGESTIONS = {
    "dashboard": [
        Suggestion(
            label="Knee arthroscopy criteria",
            prompt="What conservative therapy is required before knee arthroscopy for a meniscal tear?",
        ),
        Suggestion(
            label="CPAP beyond 90 days",
            prompt="When is a CPAP device (E0601) covered beyond the first 3 months?",
        ),
        Suggestion(
            label="Top gaps this month",
            prompt="Top 5 criteria that were not met or lacked evidence in our cases",
            mode="analytics",
        ),
        Suggestion(
            label="Which LCDs list 64561?",
            prompt="Which LCDs list code 64561 and where do they apply?",
            mode="codes",
        ),
    ],
    "analytics": [
        Suggestion(
            label="Ready rate by payer", prompt="What is our ready rate by payer type?", mode="analytics"
        ),
        Suggestion(label="Denials by category", prompt="Denials by category", mode="analytics"),
        Suggestion(
            label="Override rate", prompt="How often do reviewers override the AI verdict?", mode="analytics"
        ),
        Suggestion(label="Cases per week", prompt="Cases created per week", mode="analytics"),
    ],
}


@router.get("/assistant/suggestions", response_model=list[Suggestion])
async def suggestions(
    context: str = Query("dashboard", max_length=80),
    ctx: RequestContext = Depends(require_perm("assistant:use")),
    db: AsyncSession = Depends(get_db),
):
    if context.startswith("case:"):
        try:
            from app.db.models.cases import Case

            case = await db.get(Case, uuid.UUID(context.split(":", 1)[1]))
        except Exception:
            case = None
        if case is not None and case.org_id == ctx.org_id:
            codes = ", ".join(case.service_codes or []) or "this service"
            st = case.state or "this state"
            return [
                Suggestion(
                    label="Documentation checklist",
                    prompt=f"What documentation is required for {codes} in {st}?",
                ),
                Suggestion(
                    label="Covered diagnoses",
                    prompt=f"Are {', '.join(case.dx_codes or [])} covered diagnoses for {codes}?",
                    mode="codes",
                ),
                Suggestion(
                    label="Limitations", prompt=f"What are the limitations and exclusions for {codes}?"
                ),
                Suggestion(
                    label="Frequency limits", prompt=f"Are there frequency or utilization limits for {codes}?"
                ),
            ]
    if context.startswith("policy:"):
        key = context.split(":", 1)[1]
        return [
            Suggestion(label="Summarize criteria", prompt=f"Summarize the coverage criteria in {key}"),
            Suggestion(label="Documentation", prompt=f"What documentation does {key} require?"),
            Suggestion(label="What changed", prompt=f"What changed in {key} in the latest revision?"),
            Suggestion(
                label="Covered diagnoses", prompt=f"Which ICD-10 codes are covered under {key}?", mode="codes"
            ),
        ]
    base = _SUGGESTIONS.get(context, _SUGGESTIONS["dashboard"])
    if not ctx.has("analytics:read"):
        base = [s for s in base if s.mode != "analytics"]
    return base


@router.post("/analytics/ask", response_model=AnalyticsAskOut)
async def analytics_ask(
    body: AnalyticsAskIn,
    ctx: RequestContext = Depends(require_perm("analytics:read")),
    db: AsyncSession = Depends(get_db),
):
    ans = await answer_analytics(body.question, ctx.org_id, db)
    await audit(
        db,
        ctx,
        action="analytics.ask",
        resource_type="analytics",
        metadata={"views": ans.views, "method": ans.method},
    )
    return AnalyticsAskOut(
        question=ans.question,
        sql=ans.sql,
        columns=ans.columns,
        rows=ans.rows,
        summary=ans.summary,
        chart_hint=ans.chart_hint,
        warnings=ans.warnings,
        method=ans.method,
        row_count=ans.row_count,
        views=ans.views,
    )
