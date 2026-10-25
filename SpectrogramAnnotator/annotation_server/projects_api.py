"""
Projects API: projects, members/invites, media files, labels, annotations.

Every route needs a signed-in user (require_user) and checks the caller's
project role server-side with has_project_role() — the frontend hides
buttons for convenience, but these checks are what enforce permissions.

Roles (ascending): viewer < annotator < admin < owner
  viewer     read everything in the project
  annotator  + upload files, create labels, create annotations, edit/delete
               their OWN annotations and labels they created
  admin      + edit/delete any label, file or annotation, rename the
               project, manage viewer/annotator members and invites
  owner      + manage admins/owners, delete the project
"""

import json
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel, Field

from app_auth import AuthUser, require_user, tx

router = APIRouter(prefix="/projects", tags=["projects"])

ROLES = ("viewer", "annotator", "admin", "owner")
_RANK = {r: i for i, r in enumerate(ROLES)}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _role(conn, project_id: UUID, user: AuthUser) -> str | None:
    row = conn.execute(
        "select role::text as role from project_members where project_id = %s and user_id = %s",
        (project_id, user.id),
    ).fetchone()
    return row["role"] if row else None


def _need(conn, project_id: UUID, user: AuthUser, min_role: str = "viewer") -> str:
    """The caller's role in the project; 404 if not a member, 403 if below min_role."""
    role = _role(conn, project_id, user)
    if role is None:
        # Same answer whether the project exists or not: don't leak ids.
        raise HTTPException(404, "Project not found.")
    if _RANK[role] < _RANK[min_role]:
        raise HTTPException(403, f"This needs the {min_role} role or higher (you are {role}).")
    return role


def _at_least(role: str, min_role: str) -> bool:
    return _RANK[role] >= _RANK[min_role]


def _update_sql(table: str, changes: dict, where: str, params: tuple, returning: str = "*"):
    """`update <table> set a = %s, … where …` for whitelisted (model) field names."""
    cols, values = [], []
    for col, val in changes.items():
        if col == "extra":
            cols.append("extra = %s::jsonb")
            values.append(json.dumps(val))
        else:
            cols.append(f"{col} = %s")
            values.append(val)
    return f"update {table} set {', '.join(cols)} where {where} returning {returning}", (*values, *params)


# ---------------------------------------------------------------------------
# Projects
# ---------------------------------------------------------------------------

_PROJECT_SELECT = """
    select p.id, p.name, p.description, p.created_at, p.updated_at, m.role::text as role,
           (select count(*) from media_files f where f.project_id = p.id) as media_count,
           (select count(*) from project_members pm where pm.project_id = p.id) as member_count
    from projects p
    join project_members m on m.project_id = p.id and m.user_id = %s
"""


class ProjectIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    description: str | None = Field(default=None, max_length=5000)


class ProjectPatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    description: str | None = Field(default=None, max_length=5000)


@router.get("")
def list_projects(user: AuthUser = Depends(require_user)):
    with tx() as conn:
        return conn.execute(_PROJECT_SELECT + " order by p.updated_at desc", (user.id,)).fetchall()


@router.post("", status_code=201)
def create_project(body: ProjectIn, user: AuthUser = Depends(require_user)):
    name = body.name.strip()
    if not name:
        raise HTTPException(400, "Project name can't be blank.")
    with tx() as conn:
        # The on_project_created trigger makes the creator its owner.
        row = conn.execute(
            "insert into projects (name, description, created_by) values (%s, %s, %s) returning id",
            (name, body.description, user.id),
        ).fetchone()
        return conn.execute(_PROJECT_SELECT + " where p.id = %s", (user.id, row["id"])).fetchone()


@router.get("/{project_id}")
def get_project(project_id: UUID, user: AuthUser = Depends(require_user)):
    with tx() as conn:
        _need(conn, project_id, user)
        return conn.execute(_PROJECT_SELECT + " where p.id = %s", (user.id, project_id)).fetchone()


@router.patch("/{project_id}")
def update_project(project_id: UUID, body: ProjectPatch, user: AuthUser = Depends(require_user)):
    changes = body.model_dump(exclude_unset=True)
    if "name" in changes:
        if changes["name"] is None or not changes["name"].strip():
            raise HTTPException(400, "Project name can't be blank.")
        changes["name"] = changes["name"].strip()
    with tx() as conn:
        _need(conn, project_id, user, "admin")
        if changes:
            sql, params = _update_sql("projects", changes, "id = %s", (project_id,), "id")
            conn.execute(sql, params)
        return conn.execute(_PROJECT_SELECT + " where p.id = %s", (user.id, project_id)).fetchone()


@router.delete("/{project_id}", status_code=204)
def delete_project(project_id: UUID, user: AuthUser = Depends(require_user)):
    with tx() as conn:
        _need(conn, project_id, user, "owner")
        conn.execute("delete from projects where id = %s", (project_id,))
    return Response(status_code=204)


# ---------------------------------------------------------------------------
# Members and invites
# ---------------------------------------------------------------------------

class MemberIn(BaseModel):
    email: str = Field(min_length=3, max_length=254)
    role: str = "annotator"


class MemberPatch(BaseModel):
    role: str


def _check_role_value(role: str) -> None:
    if role not in ROLES:
        raise HTTPException(400, f"role must be one of {', '.join(ROLES)}.")


def _check_can_grant(my_role: str, role: str) -> None:
    """Admins manage viewers/annotators; only owners grant admin or owner."""
    if _RANK[role] >= _RANK["admin"] and my_role != "owner":
        raise HTTPException(403, "Only an owner can make someone an admin or owner.")


def _check_can_manage(my_role: str, their_role: str) -> None:
    if _RANK[their_role] >= _RANK["admin"] and my_role != "owner":
        raise HTTPException(403, "Only an owner can change or remove admins and owners.")


@router.get("/{project_id}/members")
def list_members(project_id: UUID, user: AuthUser = Depends(require_user)):
    with tx() as conn:
        _need(conn, project_id, user)
        members = conn.execute(
            """
            select u.id as user_id, u.email, u.display_name, u.avatar_url,
                   m.role::text as role, m.created_at
            from project_members m join users u on u.id = m.user_id
            where m.project_id = %s
            order by m.role desc, lower(coalesce(u.display_name, u.email))
            """,
            (project_id,),
        ).fetchall()
        invites = conn.execute(
            """
            select id, email, role::text as role, created_at from project_invites
            where project_id = %s and accepted_at is null order by email
            """,
            (project_id,),
        ).fetchall()
    return {"members": members, "invites": invites}


@router.post("/{project_id}/members", status_code=201)
def add_member(project_id: UUID, body: MemberIn, user: AuthUser = Depends(require_user)):
    """
    Add by email. An existing user is added right away; anyone else gets a
    pending invite, accepted automatically the first time they sign in.
    """
    email = body.email.strip().lower()
    if "@" not in email or " " in email:
        raise HTTPException(400, "Enter a valid email address.")
    _check_role_value(body.role)
    with tx() as conn:
        my_role = _need(conn, project_id, user, "admin")
        _check_can_grant(my_role, body.role)
        target = conn.execute("select id from users where email = %s", (email,)).fetchone()
        if target:
            if _role(conn, project_id, AuthUser(id=str(target["id"]), email=email)):
                raise HTTPException(409, f"{email} is already a member.")
            conn.execute(
                "insert into project_members (project_id, user_id, role) values (%s, %s, %s)",
                (project_id, target["id"], body.role),
            )
            return {"status": "added", "email": email, "role": body.role}
        conn.execute(
            """
            insert into project_invites (project_id, email, role, invited_by)
            values (%s, %s, %s, %s)
            on conflict (project_id, email) do update
              set role = excluded.role, invited_by = excluded.invited_by,
                  accepted_at = null, created_at = now()
            """,
            (project_id, email, body.role, user.id),
        )
        return {"status": "invited", "email": email, "role": body.role}


@router.patch("/{project_id}/members/{user_id}")
def change_member_role(project_id: UUID, user_id: UUID, body: MemberPatch,
                       user: AuthUser = Depends(require_user)):
    _check_role_value(body.role)
    with tx() as conn:
        my_role = _need(conn, project_id, user, "admin")
        their_role = _role(conn, project_id, AuthUser(id=str(user_id), email=None))
        if their_role is None:
            raise HTTPException(404, "Not a member of this project.")
        _check_can_manage(my_role, their_role)
        _check_can_grant(my_role, body.role)
        # ensure_project_keeps_owner (trigger) refuses demoting the last owner.
        conn.execute(
            "update project_members set role = %s where project_id = %s and user_id = %s",
            (body.role, project_id, user_id),
        )
    return {"user_id": user_id, "role": body.role}


@router.delete("/{project_id}/members/{user_id}", status_code=204)
def remove_member(project_id: UUID, user_id: UUID, user: AuthUser = Depends(require_user)):
    with tx() as conn:
        my_role = _need(conn, project_id, user)
        their_role = _role(conn, project_id, AuthUser(id=str(user_id), email=None))
        if their_role is None:
            raise HTTPException(404, "Not a member of this project.")
        if str(user_id) != user.id:  # anyone may leave; removing others needs admin
            if not _at_least(my_role, "admin"):
                raise HTTPException(403, "Only admins can remove members.")
            _check_can_manage(my_role, their_role)
        conn.execute(
            "delete from project_members where project_id = %s and user_id = %s",
            (project_id, user_id),
        )
    return Response(status_code=204)


@router.delete("/{project_id}/invites/{invite_id}", status_code=204)
def cancel_invite(project_id: UUID, invite_id: UUID, user: AuthUser = Depends(require_user)):
    with tx() as conn:
        _need(conn, project_id, user, "admin")
        conn.execute(
            "delete from project_invites where project_id = %s and id = %s",
            (project_id, invite_id),
        )
    return Response(status_code=204)


# ---------------------------------------------------------------------------
# Media files
# ---------------------------------------------------------------------------

_MEDIA_SELECT = """
    select f.id, f.project_id, f.media_type::text as media_type, f.content_hash, f.file_name,
           f.duration_sec, f.sample_rate, f.n_channels, f.width_px, f.height_px,
           f.uploaded_by, coalesce(u.display_name, u.email) as uploader_name,
           f.created_at, f.updated_at,
           (select count(*) from annotations a where a.media_file_id = f.id) as annotation_count
    from media_files f left join users u on u.id = f.uploaded_by
"""


@router.get("/{project_id}/media")
def list_media(project_id: UUID, user: AuthUser = Depends(require_user)):
    with tx() as conn:
        _need(conn, project_id, user)
        return conn.execute(
            _MEDIA_SELECT + " where f.project_id = %s order by f.created_at desc", (project_id,)
        ).fetchall()


@router.get("/{project_id}/media/{media_id}")
def get_media(project_id: UUID, media_id: UUID, user: AuthUser = Depends(require_user)):
    with tx() as conn:
        _need(conn, project_id, user)
        row = conn.execute(
            _MEDIA_SELECT + " where f.project_id = %s and f.id = %s", (project_id, media_id)
        ).fetchone()
    if row is None:
        raise HTTPException(404, "File not found in this project.")
    return row


@router.delete("/{project_id}/media/{media_id}", status_code=204)
def delete_media(project_id: UUID, media_id: UUID, user: AuthUser = Depends(require_user)):
    """Removes the file and its annotations from the project. The cached audio
    stays on disk: the same recording may belong to other projects."""
    with tx() as conn:
        my_role = _need(conn, project_id, user, "annotator")
        row = conn.execute(
            "select uploaded_by from media_files where project_id = %s and id = %s",
            (project_id, media_id),
        ).fetchone()
        if row is None:
            raise HTTPException(404, "File not found in this project.")
        if not _at_least(my_role, "admin") and str(row["uploaded_by"]) != user.id:
            raise HTTPException(403, "Only admins can delete files someone else uploaded.")
        conn.execute("delete from media_files where id = %s", (media_id,))
    return Response(status_code=204)


# ---------------------------------------------------------------------------
# Labels — one shared vocabulary per project
# ---------------------------------------------------------------------------

_LABEL_SELECT = """
    select l.id, l.name, l.color, l.display_height, l.sort_order, l.created_by, l.created_at,
           (select count(*) from annotations a where a.label_id = l.id) as annotation_count
    from labels l
"""

_COLOR = r"^#[0-9a-fA-F]{6}$"


class LabelIn(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    color: str = Field(default="#1a6b8a", pattern=_COLOR)
    display_height: int = Field(default=32, ge=8, le=200)
    sort_order: int = 0


class LabelPatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=100)
    color: str | None = Field(default=None, pattern=_COLOR)
    display_height: int | None = Field(default=None, ge=8, le=200)
    sort_order: int | None = None


def _label_for_edit(conn, project_id: UUID, label_id: UUID, user: AuthUser) -> dict:
    my_role = _need(conn, project_id, user, "annotator")
    row = conn.execute(
        "select id, created_by from labels where project_id = %s and id = %s", (project_id, label_id)
    ).fetchone()
    if row is None:
        raise HTTPException(404, "Label not found.")
    if not _at_least(my_role, "admin") and str(row["created_by"]) != user.id:
        raise HTTPException(403, "Only admins can change labels someone else created.")
    return row


@router.get("/{project_id}/labels")
def list_labels(project_id: UUID, user: AuthUser = Depends(require_user)):
    with tx() as conn:
        _need(conn, project_id, user)
        return conn.execute(
            _LABEL_SELECT + " where l.project_id = %s order by l.sort_order, l.created_at", (project_id,)
        ).fetchall()


@router.post("/{project_id}/labels", status_code=201)
def create_label(project_id: UUID, body: LabelIn, user: AuthUser = Depends(require_user)):
    name = body.name.strip()
    if not name:
        raise HTTPException(400, "Label name can't be blank.")
    with tx() as conn:
        _need(conn, project_id, user, "annotator")
        if conn.execute(
            "select 1 from labels where project_id = %s and lower(trim(name)) = lower(%s)",
            (project_id, name),
        ).fetchone():
            raise HTTPException(409, f'A label named "{name}" already exists.')
        row = conn.execute(
            """
            insert into labels (project_id, name, color, display_height, sort_order, created_by)
            values (%s, %s, %s, %s, %s, %s) returning id
            """,
            (project_id, name, body.color, body.display_height, body.sort_order, user.id),
        ).fetchone()
        return conn.execute(_LABEL_SELECT + " where l.id = %s", (row["id"],)).fetchone()


@router.patch("/{project_id}/labels/{label_id}")
def update_label(project_id: UUID, label_id: UUID, body: LabelPatch,
                 user: AuthUser = Depends(require_user)):
    changes = {k: v for k, v in body.model_dump(exclude_unset=True).items() if v is not None}
    if "name" in changes:
        changes["name"] = changes["name"].strip()
        if not changes["name"]:
            raise HTTPException(400, "Label name can't be blank.")
    with tx() as conn:
        _label_for_edit(conn, project_id, label_id, user)
        if "name" in changes and conn.execute(
            "select 1 from labels where project_id = %s and id <> %s and lower(trim(name)) = lower(%s)",
            (project_id, label_id, changes["name"]),
        ).fetchone():
            raise HTTPException(409, f'A label named "{changes["name"]}" already exists.')
        if changes:
            sql, params = _update_sql("labels", changes, "id = %s", (label_id,), "id")
            conn.execute(sql, params)
        return conn.execute(_LABEL_SELECT + " where l.id = %s", (label_id,)).fetchone()


@router.delete("/{project_id}/labels/{label_id}", status_code=204)
def delete_label(project_id: UUID, label_id: UUID, user: AuthUser = Depends(require_user)):
    with tx() as conn:
        _label_for_edit(conn, project_id, label_id, user)
        used = conn.execute(
            "select count(*) as n from annotations where label_id = %s", (label_id,)
        ).fetchone()["n"]
        if used:
            raise HTTPException(
                409, f"This label is used by {used} annotation{'s' if used != 1 else ''} "
                     "in this project. Delete or relabel those first.")
        conn.execute("delete from labels where id = %s", (label_id,))
    return Response(status_code=204)


# ---------------------------------------------------------------------------
# Annotations
# ---------------------------------------------------------------------------

_ANN_COLUMNS = """
    a.id, a.media_file_id, a.label_id, a.created_by,
    coalesce(u.display_name, u.email) as creator_name,
    a.name, a.start_sec, a.end_sec, a.freq_min_hz, a.freq_max_hz, a.notes, a.extra,
    a.created_at, a.updated_at
"""
_ANN_SELECT = f"select {_ANN_COLUMNS} from annotations a left join users u on u.id = a.created_by"


class AnnotationIn(BaseModel):
    label_id: UUID
    name: str | None = Field(default=None, max_length=500)
    start_sec: float | None = Field(default=None, ge=0)
    end_sec: float | None = Field(default=None, ge=0)
    freq_min_hz: float | None = Field(default=None, ge=0)
    freq_max_hz: float | None = Field(default=None, ge=0)
    notes: str | None = Field(default=None, max_length=10000)
    extra: dict = Field(default_factory=dict)


class AnnotationPatch(BaseModel):
    label_id: UUID | None = None
    name: str | None = Field(default=None, max_length=500)
    start_sec: float | None = Field(default=None, ge=0)
    end_sec: float | None = Field(default=None, ge=0)
    freq_min_hz: float | None = Field(default=None, ge=0)
    freq_max_hz: float | None = Field(default=None, ge=0)
    notes: str | None = Field(default=None, max_length=10000)
    extra: dict | None = None


def _check_label_in_project(conn, project_id: UUID, label_id: UUID) -> None:
    if not conn.execute(
        "select 1 from labels where project_id = %s and id = %s", (project_id, label_id)
    ).fetchone():
        raise HTTPException(400, "That label doesn't belong to this project.")


@router.get("/{project_id}/media/{media_id}/annotations")
def list_annotations(project_id: UUID, media_id: UUID, user: AuthUser = Depends(require_user)):
    with tx() as conn:
        _need(conn, project_id, user)
        return conn.execute(
            _ANN_SELECT + " where a.project_id = %s and a.media_file_id = %s"
                          " order by a.start_sec nulls last, a.created_at",
            (project_id, media_id),
        ).fetchall()


@router.post("/{project_id}/media/{media_id}/annotations", status_code=201)
def create_annotation(project_id: UUID, media_id: UUID, body: AnnotationIn,
                      user: AuthUser = Depends(require_user)):
    if (body.start_sec is None) != (body.end_sec is None):
        raise HTTPException(400, "Give both start_sec and end_sec, or neither.")
    if body.start_sec is not None and body.end_sec <= body.start_sec:
        raise HTTPException(400, "end_sec must be after start_sec.")
    with tx() as conn:
        _need(conn, project_id, user, "annotator")
        if not conn.execute(
            "select 1 from media_files where project_id = %s and id = %s", (project_id, media_id)
        ).fetchone():
            raise HTTPException(404, "File not found in this project.")
        _check_label_in_project(conn, project_id, body.label_id)
        row = conn.execute(
            """
            insert into annotations (project_id, media_file_id, label_id, created_by, name,
                                     start_sec, end_sec, freq_min_hz, freq_max_hz, notes, extra)
            values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s::jsonb) returning id
            """,
            (project_id, media_id, body.label_id, user.id, body.name, body.start_sec, body.end_sec,
             body.freq_min_hz, body.freq_max_hz, body.notes, json.dumps(body.extra)),
        ).fetchone()
        return conn.execute(_ANN_SELECT + " where a.id = %s", (row["id"],)).fetchone()


def _annotation_for_edit(conn, project_id: UUID, ann_id: UUID, user: AuthUser) -> dict:
    my_role = _need(conn, project_id, user, "annotator")
    row = conn.execute(
        "select id, created_by, start_sec, end_sec from annotations where project_id = %s and id = %s",
        (project_id, ann_id),
    ).fetchone()
    if row is None:
        raise HTTPException(404, "Annotation not found.")
    if not _at_least(my_role, "admin") and str(row["created_by"]) != user.id:
        raise HTTPException(403, "You can only change your own annotations.")
    return row


@router.patch("/{project_id}/annotations/{ann_id}")
def update_annotation(project_id: UUID, ann_id: UUID, body: AnnotationPatch,
                      user: AuthUser = Depends(require_user)):
    changes = body.model_dump(exclude_unset=True)
    if "label_id" in changes and changes["label_id"] is None:
        raise HTTPException(400, "label_id can't be null.")
    if "extra" in changes and changes["extra"] is None:
        changes["extra"] = {}
    with tx() as conn:
        row = _annotation_for_edit(conn, project_id, ann_id, user)
        start = changes.get("start_sec", row["start_sec"])
        end = changes.get("end_sec", row["end_sec"])
        if (start is None) != (end is None) or (start is not None and end <= start):
            raise HTTPException(400, "end_sec must be after start_sec.")
        if "label_id" in changes:
            _check_label_in_project(conn, project_id, changes["label_id"])
        if changes:
            sql, params = _update_sql("annotations", changes, "id = %s", (ann_id,), "id")
            conn.execute(sql, params)
        return conn.execute(_ANN_SELECT + " where a.id = %s", (ann_id,)).fetchone()


@router.delete("/{project_id}/annotations/{ann_id}", status_code=204)
def delete_annotation(project_id: UUID, ann_id: UUID, user: AuthUser = Depends(require_user)):
    with tx() as conn:
        _annotation_for_edit(conn, project_id, ann_id, user)
        conn.execute("delete from annotations where id = %s", (ann_id,))
    return Response(status_code=204)
