"""Setup de primer arranque, login y sesiones por cookie."""
import hashlib
import secrets
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel

from . import db

router = APIRouter(prefix="/api/auth")

COOKIE_NAME = "agenda_session"
SESSION_DAYS = 30
PBKDF2_ITERATIONS = 600_000


def hash_password(password: str, salt: str | None = None) -> str:
    salt = salt or secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac(
        "sha256", password.encode(), bytes.fromhex(salt), PBKDF2_ITERATIONS
    ).hex()
    return f"{salt}${digest}"


def verify_password(password: str, stored: str) -> bool:
    salt, _ = stored.split("$", 1)
    return secrets.compare_digest(hash_password(password, salt), stored)


def _now() -> datetime:
    return datetime.now(timezone.utc)


def create_session(conn) -> str:
    token = secrets.token_hex(32)
    expires = (_now() + timedelta(days=SESSION_DAYS)).isoformat()
    conn.execute(
        "INSERT INTO sessions (token, expires_at) VALUES (?, ?)", (token, expires)
    )
    conn.commit()
    return token


def session_valid(conn, token: str | None) -> bool:
    if not token:
        return False
    row = conn.execute(
        "SELECT expires_at FROM sessions WHERE token = ?", (token,)
    ).fetchone()
    if not row:
        return False
    if datetime.fromisoformat(row["expires_at"]) < _now():
        conn.execute("DELETE FROM sessions WHERE token = ?", (token,))
        conn.commit()
        return False
    return True


def require_session(request: Request):
    conn = db.connect()
    try:
        if not session_valid(conn, request.cookies.get(COOKIE_NAME)):
            raise HTTPException(status_code=401, detail="not_authenticated")
    finally:
        conn.close()


class Credentials(BaseModel):
    username: str
    password: str


class PasswordChange(BaseModel):
    current_password: str
    new_password: str


def _set_cookie(response: Response, token: str) -> None:
    response.set_cookie(
        COOKIE_NAME,
        token,
        httponly=True,
        samesite="strict",
        max_age=SESSION_DAYS * 86400,
    )


@router.get("/status")
def status(request: Request):
    conn = db.connect()
    try:
        setup_done = db.get_user(conn) is not None
        logged_in = setup_done and session_valid(conn, request.cookies.get(COOKIE_NAME))
        return {"setup_done": setup_done, "logged_in": logged_in}
    finally:
        conn.close()


@router.post("/setup")
def setup(creds: Credentials, response: Response):
    if len(creds.password) < 8:
        raise HTTPException(status_code=400, detail="password_too_short")
    conn = db.connect()
    try:
        if db.get_user(conn):
            raise HTTPException(status_code=409, detail="already_setup")
        conn.execute(
            "INSERT INTO user (id, username, password_hash) VALUES (1, ?, ?)",
            (creds.username.strip(), hash_password(creds.password)),
        )
        token = create_session(conn)
        _set_cookie(response, token)
        return {"ok": True}
    finally:
        conn.close()


@router.post("/login")
def login(creds: Credentials, response: Response):
    conn = db.connect()
    try:
        user = db.get_user(conn)
        if (
            not user
            or user["username"] != creds.username.strip()
            or not verify_password(creds.password, user["password_hash"])
        ):
            raise HTTPException(status_code=401, detail="bad_credentials")
        token = create_session(conn)
        _set_cookie(response, token)
        return {"ok": True}
    finally:
        conn.close()


@router.post("/logout")
def logout(request: Request, response: Response):
    conn = db.connect()
    try:
        token = request.cookies.get(COOKIE_NAME)
        if token:
            conn.execute("DELETE FROM sessions WHERE token = ?", (token,))
            conn.commit()
    finally:
        conn.close()
    response.delete_cookie(COOKIE_NAME)
    return {"ok": True}


@router.post("/password", dependencies=[Depends(require_session)])
def change_password(body: PasswordChange):
    if len(body.new_password) < 8:
        raise HTTPException(status_code=400, detail="password_too_short")
    conn = db.connect()
    try:
        user = db.get_user(conn)
        if not verify_password(body.current_password, user["password_hash"]):
            raise HTTPException(status_code=401, detail="bad_credentials")
        conn.execute(
            "UPDATE user SET password_hash = ? WHERE id = 1",
            (hash_password(body.new_password),),
        )
        conn.execute("DELETE FROM sessions")
        conn.commit()
        return {"ok": True}
    finally:
        conn.close()
