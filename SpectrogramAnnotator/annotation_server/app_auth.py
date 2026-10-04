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

Permissions that Supabase's Row Level Security used to enforce are checked
here with the has_project_role() SQL function (see db/schema.sql).

Configuration (environment variables, or annotation_server/.env):
    DATABASE_URL       postgresql://user:password@localhost:5432/annotator
    GOOGLE_CLIENT_ID   OAuth client id from Google Cloud Console
                       (…apps.googleusercontent.com)
    SESSION_SECRET     long random string used to sign session tokens
    SESSION_DAYS       session lifetime in days (default 7)
    REQUIRE_AUTH       "true" to reject unauthenticated API calls. Defaults
                       to "false" so the current (pre-login-page) frontend
                       keeps working; flip it once login is wired up.
"""

import os
import uuid
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

DATABASE_URL     = os.environ.get("DATABASE_URL", "")
GOOGLE_CLIENT_ID = os.environ.get("GOOGLE_CLIENT_ID", "")
SESSION_SECRET   = os.environ.get("SESSION_SECRET", "")
SESSION_DAYS     = float(os.environ.get("SESSION_DAYS", "7"))
REQUIRE_AUTH     = os.environ.get("REQUIRE_AUTH", "false").lower() in ("1", "true", "yes")

DB_ENABLED   = bool(DATABASE_URL)
AUTH_ENABLED = bool(DB_ENABLED and GOOGLE_CLIENT_ID and SESSION_SECRET)

_SESSION_ALG      = "HS256"
_SESSION_ISSUER   = "spectrogram-annotator"

if not AUTH_ENABLED:
    missing = [n for n, v in (("DATABASE_URL", DATABASE_URL),
                              ("GOOGLE_CLIENT_ID", GOOGLE_CLIENT_ID),
                              ("SESSION_SECRET", SESSION_SECRET)) if not v]
    print(f"[server] Sign-in disabled ({', '.join(missing)} unset) — "
          "accounts and audio_files registration are off.")
    if REQUIRE_AUTH:
        raise RuntimeError(f"REQUIRE_AUTH=true but {', '.join(missing)} not set.")
elif len(SESSION_SECRET) < 32:
    raise RuntimeError("SESSION_SECRET must be at least 32 characters.")


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
    if user is None:
        raise HTTPException(401, "Not signed in.")
    return user


# ---------------------------------------------------------------------------
# Routes: /auth/google (sign in), /auth/me
# ---------------------------------------------------------------------------

router = APIRouter(prefix="/auth", tags=["auth"])


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
    if not AUTH_ENABLED:
        raise HTTPException(503, "Sign-in is not configured on this server.")
    info  = _verify_google_token(body.credential)
    email = info["email"].lower()

    with db().connection() as conn:
        user = conn.execute(
            """
            insert into users (google_sub, email, display_name, avatar_url, last_login_at)
            values (%s, %s, %s, %s, now())
            on conflict (google_sub) do update
              set email = excluded.email,
                  display_name = coalesce(users.display_name, excluded.display_name),
                  avatar_url = excluded.avatar_url,
                  last_login_at = now()
            returning id, email, display_name, avatar_url
            """,
            (info["sub"], email, info.get("name") or email.split("@")[0], info.get("picture")),
        ).fetchone()

        # Accept pending invites for this email (safe: Google verified it).
        conn.execute(
            """
            insert into project_members (project_id, user_id, role)
            select project_id, %s, role from project_invites
            where email = %s and accepted_at is null
            on conflict do nothing
            """,
            (user["id"], email),
        )
        conn.execute(
            "update project_invites set accepted_at = now() where email = %s and accepted_at is null",
            (email,),
        )

    return {"token": _issue_session(str(user["id"]), email),
            "user": {**user, "id": str(user["id"])}}


@router.get("/me")
def me(user: AuthUser = Depends(require_user)):
    with db().connection() as conn:
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
# audio_files registration (used by /upload)
# ---------------------------------------------------------------------------

def register_audio_file(user: AuthUser, project_id: str, file_id: str, meta: dict) -> dict:
    """
    Insert (or fetch the existing) audio_files row for this project + file.
    Idempotent: re-uploading the same audio to the same project returns the
    row that's already there. 403 unless the user is at least an annotator.
    """
    try:
        uuid.UUID(project_id)
    except ValueError:
        raise HTTPException(400, "project_id must be a UUID.")
    with db().connection() as conn:
        if not has_project_role(conn, project_id, user.id, "annotator"):
            raise HTTPException(403, "You don't have permission to add files to this project.")
        row = conn.execute(
            """
            insert into audio_files
              (project_id, content_hash, file_name, duration_sec, sample_rate, n_channels, uploaded_by)
            values (%s, %s, %s, %s, %s, %s, %s)
            on conflict (project_id, content_hash) do nothing
            returning *
            """,
            (project_id, file_id, meta["file_name"] or "untitled", meta["duration"],
             meta["sample_rate"], meta["n_channels"], user.id),
        ).fetchone()
        if row is None:
            row = conn.execute(
                "select * from audio_files where project_id = %s and content_hash = %s",
                (project_id, file_id),
            ).fetchone()
    # UUIDs -> str so the row is JSON-serializable alongside the upload response.
    return {k: (str(v) if isinstance(v, uuid.UUID) else v) for k, v in row.items()}
