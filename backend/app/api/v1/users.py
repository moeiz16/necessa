"""Current-user profile endpoints."""

from __future__ import annotations

from fastapi import APIRouter, Depends, Response, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import RequestContext, get_db, get_user_ctx
from app.schemas.platform import ChangePasswordIn, UserOut, UserUpdateIn
from app.services import auth as auth_svc
from app.services.audit import audit

router = APIRouter(prefix="/users", tags=["users"])

_ALLOWED_PREFS = {
    "theme",
    "density",
    "notifications",
    "sidebarCollapsed",
    "defaultCaseView",
    "lastOrgId",
    "dateFormat",
    "onboardingTips",
}


@router.patch("/me", response_model=UserOut)
async def update_me(
    body: UserUpdateIn, ctx: RequestContext = Depends(get_user_ctx), db: AsyncSession = Depends(get_db)
):
    user = ctx.user
    if body.full_name is not None:
        user.full_name = body.full_name.strip()
    if body.title is not None:
        user.title = body.title.strip() or None
    if body.avatar_color is not None:
        user.avatar_color = body.avatar_color
    if body.preferences is not None:
        clean = {k: v for k, v in body.preferences.items() if k in _ALLOWED_PREFS}
        user.preferences = {**(user.preferences or {}), **clean}
    await audit(
        db,
        ctx,
        action="user.profile_updated",
        resource_type="user",
        resource_id=user.id,
        metadata={"fields": sorted(body.model_dump(exclude_none=True))},
    )
    return UserOut.model_validate(user)


@router.post("/me/password", status_code=status.HTTP_204_NO_CONTENT)
async def change_password(
    body: ChangePasswordIn, ctx: RequestContext = Depends(get_user_ctx), db: AsyncSession = Depends(get_db)
) -> Response:
    await auth_svc.change_password(db, ctx.user, body.current_password, body.new_password, ctx.session_id)
    await audit(db, ctx, action="user.password_changed", resource_type="user", resource_id=ctx.user.id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
