import base64
import hashlib
import hmac
import json
import os
import time
from dataclasses import dataclass

from fastapi import APIRouter, Cookie, Depends, HTTPException, Response
from pydantic import BaseModel, Field


COOKIE_NAME = "seo_ops_session"
SESSION_TTL_SECONDS = 12 * 60 * 60


@dataclass(frozen=True)
class AuthSettings:
    username: str
    password: str
    secret: str
    cookie_secure: bool


class LoginBody(BaseModel):
    username: str = Field(min_length=1, max_length=100)
    password: str = Field(min_length=1, max_length=500)


def auth_settings() -> AuthSettings:
    username = os.environ.get("SEO_OPS_AUTH_USERNAME", "").strip()
    password = os.environ.get("SEO_OPS_AUTH_PASSWORD", "")
    secret = os.environ.get("SEO_OPS_AUTH_SECRET", "")
    if not username or not password or len(secret) < 32:
        raise HTTPException(status_code=503, detail="operator authentication not configured")
    cookie_secure = os.environ.get("SEO_OPS_COOKIE_SECURE", "false").lower() in {
        "1",
        "true",
        "yes",
    }
    return AuthSettings(username, password, secret, cookie_secure)


def _encode(payload: dict) -> str:
    raw = json.dumps(payload, separators=(",", ":"), sort_keys=True).encode()
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def _decode(value: str) -> dict:
    padding = "=" * (-len(value) % 4)
    return json.loads(base64.urlsafe_b64decode(value + padding))


def make_session(username: str, secret: str, now: int | None = None) -> str:
    payload = _encode({"exp": (now or int(time.time())) + SESSION_TTL_SECONDS, "sub": username})
    signature = hmac.new(secret.encode(), payload.encode(), hashlib.sha256).hexdigest()
    return f"{payload}.{signature}"


def verify_session(token: str, settings: AuthSettings, now: int | None = None) -> str | None:
    try:
        payload, signature = token.rsplit(".", 1)
        expected = hmac.new(settings.secret.encode(), payload.encode(), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(signature, expected):
            return None
        claims = _decode(payload)
        if claims.get("sub") != settings.username:
            return None
        if not isinstance(claims.get("exp"), int) or claims["exp"] < (now or int(time.time())):
            return None
    except (ValueError, TypeError, json.JSONDecodeError):
        return None
    return settings.username


def require_operator(
    seo_ops_session: str | None = Cookie(default=None, alias=COOKIE_NAME),
) -> str:
    settings = auth_settings()
    username = verify_session(seo_ops_session or "", settings)
    if username is None:
        raise HTTPException(status_code=401, detail="operator authentication required")
    return username


router = APIRouter(prefix="/api/auth", tags=["auth"])


@router.post("/login")
def login(body: LoginBody, response: Response):
    settings = auth_settings()
    if not (
        hmac.compare_digest(body.username, settings.username)
        and hmac.compare_digest(body.password, settings.password)
    ):
        raise HTTPException(status_code=401, detail="invalid operator credentials")
    response.set_cookie(
        COOKIE_NAME,
        make_session(settings.username, settings.secret),
        httponly=True,
        secure=settings.cookie_secure,
        samesite="strict",
        max_age=SESSION_TTL_SECONDS,
        path="/",
    )
    return {"username": settings.username, "role": "operator"}


@router.get("/me")
def me(username: str = Depends(require_operator)):
    return {"username": username, "role": "operator"}


@router.post("/logout", status_code=204)
def logout(response: Response):
    response.delete_cookie(COOKIE_NAME, path="/")
