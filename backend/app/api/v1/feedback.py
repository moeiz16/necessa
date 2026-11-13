"""Generic user feedback (answers, verdicts, letters, retrieval) — feeds the eval set."""

from __future__ import annotations

from fastapi import APIRouter, Depends, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import RequestContext, get_ctx, get_db
from app.db.models.platform import Feedback
from app.schemas.platform import FeedbackIn, FeedbackOut
from app.services.audit import audit

router = APIRouter(prefix="/feedback", tags=["feedback"])


@router.post("", response_model=FeedbackOut, status_code=status.HTTP_201_CREATED)
async def submit_feedback(
    body: FeedbackIn, ctx: RequestContext = Depends(get_ctx), db: AsyncSession = Depends(get_db)
):
    fb = Feedback(
        org_id=ctx.org_id,
        user_id=ctx.user.id,
        target_type=body.target_type,
        target_id=body.target_id,
        rating=body.rating,
        reason=body.reason,
        comment=body.comment,
    )
    db.add(fb)
    await db.flush()
    await audit(
        db,
        ctx,
        action="feedback.submitted",
        resource_type=body.target_type,
        resource_id=body.target_id,
        metadata={"rating": body.rating, "reason": body.reason},
    )
    return FeedbackOut.model_validate(fb)
