"""
Sign-in and database access for the annotation server (self-hosted
PostgreSQL + Google sign-in; replaces the old Supabase integration).

Flow:
  1. The frontend shows Google's "Sign in with Google" button (Google
     Identity Services), which gives the browser a Google ID token.
  2. It POSTs that token to /auth/google. The server verifies it against
     GOOGLE_CLIENT_ID, creates/updates the `users` row, accepts any pending
     project invites for that email, and returns a session token signed with
     SESSION_SECRET.
  3. Every later request sends `Authorization: Bearer <session token>`;
     `current_user` / `require_user` verify it locally (no Google call).

For local testing there is also a developer login (POST /auth/dev: type an
email, no password), enabled only with DEV_LOGIN=true. Never turn it on for
a server other people can reach: anyone could sign in as anyone.

Permissions that Supabase's Row Level Security used to enforce are checked
here and in projects_api.py with the has_project_role() SQL function (see
db/schema.sql).

Configuration (environment variables, or annotation_server/.env):
    DATABASE_URL       postgresql://user:password@localhost:5432/annotator
    GOOGLE_CLIENT_ID   OAuth client id from Google Cloud Console
                       (…apps.googleusercontent.com)
    SESSION_SECRET     long random string used to sign session tokens
    SESSION_DAYS       session lifetime in days (default 7)
    DEV_LOGIN          "true" to allow passwordless sign-in by email
                       (local testing only)
    REQUIRE_AUTH       "true" to reject unauthenticated API calls (the audio
                       endpoints too). With it off, signed-out requests still
                       work, for standalone /audio use.

Sign-in is enabled when DATABASE_URL and SESSION_SECRET are set plus at least
one sign-in method (GOOGLE_CLIENT_ID or DEV_LOGIN).
"""

import os
import uuid
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path

import jwt
from fastapi import APIRouter, Depends, Header, HTTPException
from pydantic import BaseModel

try:
    from dotenv import load_dotenv
    load_dotenv(Path(__file__).resolve().parent / ".env")
except ImportError:
    pass


def _flag(name: str) -> bool:
    return os.environ.get(name, "false").strip().lower() in ("1", "true", "yes")


DATABASE_URL     = os.environ.get("DATABASE_URL", "")
GOOGLE_CLIENT_ID = os.environ.get("GOOGLE_CLIENT_ID", "")
SESSION_SECRET   = os.environ.get("SESSION_SECRET", "")
SESSION_DAYS     = float(os.environ.get("SESSION_DAYS", "7"))
REQUIRE_AUTH     = _flag("REQUIRE_AUTH")
DEV_LOGIN        = _flag("DEV_LOGIN")

DB_ENABLED   = bool(DATABASE_URL)
AUTH_ENABLED = bool(DB_ENABLED and SESSION_SECRET and (GOOGLE_CLIENT_ID or DEV_LOGIN))

_SESSION_ALG      = "HS256"
_SESSION_ISSUER   = "spectrogram-annotator"

if not AUTH_ENABLED:
    missing = [n for n, v in (("DATABASE_URL", DATABASE_URL),
                              ("SESSION_SECRET", SESSION_SECRET),
                              ("GOOGLE_CLIENT_ID or DEV_LOGIN", GOOGLE_CLIENT_ID or DEV_LOGIN)) if not v]
    print(f"[server] Sign-in disabled ({', '.join(missing)} unset): accounts and "
          "projects are off; the standalone audio annotator still works.")
    if REQUIRE_AUTH:
        raise RuntimeError(f"REQUIRE_AUTH=true but {', '.join(missing)} not set.")
elif len(SESSION_SECRET) < 32:
    raise RuntimeError("SESSION_SECRET must be at least 32 characters.")

if AUTH_ENABLED and DEV_LOGIN:
    _bar = "!" * 78
    print(f"\n[server] {_bar}\n"
          "[server] !!  DEV_LOGIN=true: ANYONE who can reach this server can sign in as\n"
          "[server] !!  ANY email address, with no password. Local testing only.\n"
          "[server] !!  Set DEV_LOGIN=false (or remove it) on any shared server.\n"
          f"[server] {_bar}\n")


# ---------------------------------------------------------------------------
# Database
# ---------------------------------------------------------------------------

_pool = None


def db():
    """Connection pool (opened on first use). Use as `with db().connection() as conn:`."""
    global _pool
    if not DB_ENABLED:
        raise HTTPException(503, "Database not configured (DATABASE_URL unset).")
    if _pool is None:
        from psycopg.rows import dict_row
        from psycopg_pool import ConnectionPool
        _pool = ConnectionPool(DATABASE_URL, min_size=1, max_size=10,
                               kwargs={"row_factory": dict_row}, open=True)
    return _pool


# Postgres error codes (SQLSTATE) -> HTTP status, for errors a user can cause.
_SQLSTATE_HTTP = {
    "23505": (409, "That already exists."),                 # unique_violation
    "23503": (409, "Still in use by other records."),       # foreign_key_violation
    "23514": (400, "Invalid value."),                       # check_violation
    "23502": (400, "A required value is missing."),         # not_null_violation
    "22P02": (400, "Invalid value."),                       # invalid_text_representation
}


@contextmanager
def tx():
    """
    One transaction: commits on success, rolls back on any exception.
    Constraint violations become 4xx HTTPExceptions instead of 500s, keeping
    the database's own message when it was written for people (raised by our
    triggers) rather than naming a constraint.
    """
    try:
        with db().connection() as conn:
            yield conn
    except HTTPException:
        raise
    except Exception as exc:
        mapped = _SQLSTATE_HTTP.get(getattr(exc, "sqlstate", None) or "")
        if mapped is None:
            raise
        status, fallback = mapped
        primary = getattr(getattr(exc, "diag", None), "message_primary", None)
        detail = primary if primary and "violates" not in primary and "syntax" not in primary else fallback
        raise HTTPException(status, detail) from exc


def has_project_role(conn, project_id: str, user_id: str, min_role: str = "viewer") -> bool:
    row = conn.execute(
        "select has_project_role(%s, %s, %s::project_role) as ok",
        (project_id, user_id, min_role),
    ).fetchone()
    return bool(row and row["ok"])


# ---------------------------------------------------------------------------
# Sessions
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class AuthUser:
    id: str
    email: str | None


def _issue_session(user_id: str, email: str) -> str:
    now = datetime.now(timezone.utc)
    return jwt.encode(
        {"sub": user_id, "email": email, "iss": _SESSION_ISSUER,
         "iat": now, "exp": now + timedelta(days=SESSION_DAYS)},
        SESSION_SECRET, algorithm=_SESSION_ALG,
    )


def _verify_session(token: str) -> AuthUser:
    try:
        claims = jwt.decode(token, SESSION_SECRET, algorithms=[_SESSION_ALG],
                            issuer=_SESSION_ISSUER)
    except jwt.ExpiredSignatureError:
        raise HTTPException(401, "Session expired. Please sign in again.")
    except jwt.PyJWTError as exc:
        raise HTTPException(401, f"Invalid session token: {exc}")
    return AuthUser(id=claims["sub"], email=claims.get("email"))


def current_user(authorization: str | None = Header(default=None)) -> AuthUser | None:
    """
    FastAPI dependency. Returns the signed-in user, or None when no token was
    sent and REQUIRE_AUTH is off. A token that IS sent but is invalid always
    401s, regardless of REQUIRE_AUTH.
    """
    if not authorization:
        if REQUIRE_AUTH:
            raise HTTPException(401, "Not signed in.")
        return None
    if not AUTH_ENABLED:
        return None
    scheme, _, token = authorization.partition(" ")
    if scheme.lower() != "bearer" or not token:
        raise HTTPException(401, "Authorization header must be 'Bearer <token>'.")
    return _verify_session(token)


def require_user(user: AuthUser | None = Depends(current_user)) -> AuthUser:
    """FastAPI dependency for endpoints that always need a signed-in user."""
    if not AUTH_ENABLED:
        raise HTTPException(503, "Sign-in is not configured on this server.")
    if user is None:
        raise HTTPException(401, "Not signed in.")
    return user


# ---------------------------------------------------------------------------
# Routes: /auth/config, /auth/google, /auth/dev (sign in), /auth/me
# ---------------------------------------------------------------------------

router = APIRouter(prefix="/auth", tags=["auth"])


@router.get("/config")
def auth_config():
    """Public: tells the frontend whether to require sign-in and which options to show."""
    return {
        "auth_enabled":     AUTH_ENABLED,
        "google_client_id": GOOGLE_CLIENT_ID if AUTH_ENABLED else "",
        "dev_login":        AUTH_ENABLED and DEV_LOGIN,
    }


def _accept_invites(conn, user_id, email: str) -> None:
    """Turn pending invites for this (verified) email into memberships."""
    conn.execute(
        """
        insert into project_members (project_id, user_id, role)
        select project_id, %s, role from project_invites
        where email = %s and accepted_at is null
        on conflict do nothing
        """,
        (user_id, email),
    )
    conn.execute(
        "update project_invites set accepted_at = now() where email = %s and accepted_at is null",
        (email,),
    )


def _session_response(user: dict) -> dict:
    return {"token": _issue_session(str(user["id"]), user["email"]),
            "user": {**user, "id": str(user["id"])}}


class GoogleSignIn(BaseModel):
    credential: str  # the ID token from Google Identity Services


def _verify_google_token(credential: str) -> dict:
    from google.auth.transport import requests as google_requests
    from google.oauth2 import id_token
    try:
        info = id_token.verify_oauth2_token(credential, google_requests.Request(), GOOGLE_CLIENT_ID)
    except ValueError as exc:
        raise HTTPException(401, f"Google sign-in failed: {exc}")
    if not info.get("email") or not info.get("email_verified"):
        raise HTTPException(401, "Google account has no verified email.")
    return info


@router.post("/google")
def sign_in_with_google(body: GoogleSignIn):
    if not (AUTH_ENABLED and GOOGLE_CLIENT_ID):
        raise HTTPException(503, "Google sign-in is not configured on this server.")
    info  = _verify_google_token(body.credential)
    email = info["email"].strip().lower()
    name  = info.get("name") or email.split("@")[0]

    with tx() as conn:
        # The known Google account, else a row with this email that isn't
        # linked to a Google account yet (e.g. created by the developer
        # login): link it rather than create a duplicate.
        existing = conn.execute(
            """
            select id from users where google_sub = %s
            union all
            select id from users where email = %s and google_sub is null
            limit 1
            """,
            (info["sub"], email),
        ).fetchone()
        if existing:
            user = conn.execute(
                """
                update users set google_sub = %s, email = %s,
                       display_name = coalesce(display_name, %s),
                       avatar_url = %s, last_login_at = now()
                where id = %s
                returning id, email, display_name, avatar_url
                """,
                (info["sub"], email, name, info.get("picture"), existing["id"]),
            ).fetchone()
        else:
            user = conn.execute(
                """
                insert into users (google_sub, email, display_name, avatar_url, last_login_at)
                values (%s, %s, %s, %s, now())
                returning id, email, display_name, avatar_url
                """,
                (info["sub"], email, name, info.get("picture")),
            ).fetchone()
        # Safe: Google verified the email.
        _accept_invites(conn, user["id"], email)

    return _session_response(user)


class DevSignIn(BaseModel):
    email: str
    display_name: str | None = None


@router.post("/dev")
def sign_in_dev(body: DevSignIn):
    """Passwordless sign-in by email. Only with DEV_LOGIN=true (local testing)."""
    if not (AUTH_ENABLED and DEV_LOGIN):
        raise HTTPException(404, "Developer login is disabled.")
    email = body.email.strip().lower()
    local, _, domain = email.partition("@")
    if not local or "." not in domain or " " in email or len(email) > 254:
        raise HTTPException(400, "Enter a valid email address.")
    name = (body.display_name or "").strip() or local

    with tx() as conn:
        user = conn.execute(
            """
            insert into users (email, display_name, last_login_at)
            values (%s, %s, now())
            on conflict (email) do update set last_login_at = now()
            returning id, email, display_name, avatar_url
            """,
            (email, name),
        ).fetchone()
        _accept_invites(conn, user["id"], email)

    return _session_response(user)


@router.get("/me")
def me(user: AuthUser = Depends(require_user)):
    with tx() as conn:
        row = conn.execute(
            "select id, email, display_name, avatar_url from users where id = %s",
            (user.id,),
        ).fetchone()
        if row is None:
            raise HTTPException(401, "Account no longer exists.")
        projects = conn.execute(
            """
            select p.id, p.name, m.role from project_members m
            join projects p on p.id = m.project_id
            where m.user_id = %s order by p.name
            """,
            (user.id,),
        ).fetchall()
    return {"user": {**row, "id": str(row["id"])},
            "projects": [{**p, "id": str(p["id"])} for p in projects]}


# ---------------------------------------------------------------------------
# media_files registration (used by /upload and /files)
# ---------------------------------------------------------------------------

def register_media_file(user: AuthUser, project_id: str, file_id: str, meta: dict) -> dict:
    """
    Insert (or fetch the existing) media_files row (media_type 'audio') for
    this project + file. Idempotent: re-uploading the same audio to the same
    project returns the row that's already there. 403 unless the user is at
    least an annotator.
    """
    try:
        uuid.UUID(project_id)
    except ValueError:
        raise HTTPException(400, "project_id must be a UUID.")
    with tx() as conn:
        if not has_project_role(conn, project_id, user.id, "annotator"):
            raise HTTPException(403, "You don't have permission to add files to this project.")
        row = conn.execute(
            """
            insert into media_files
              (project_id, media_type, content_hash, file_name, duration_sec, sample_rate, n_channels, uploaded_by)
            values (%s, 'audio', %s, %s, %s, %s, %s, %s)
            on conflict (project_id, content_hash) do nothing
            returning *
            """,
            (project_id, file_id, meta["file_name"] or "untitled", meta["duration"],
             meta["sample_rate"], meta["n_channels"], user.id),
        ).fetchone()
        if row is None:
            row = conn.execute(
                "select * from media_files where project_id = %s and content_hash = %s",
                (project_id, file_id),
            ).fetchone()
    # UUIDs -> str so the row is JSON-serializable alongside the upload response.
    return {k: (str(v) if isinstance(v, uuid.UUID) else v) for k, v in row.items()}
