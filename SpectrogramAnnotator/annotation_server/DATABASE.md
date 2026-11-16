# Database & sign-in setup (PostgreSQL + pgAdmin + Google)

Everything runs on the lab's Linux server; nothing is paid or hosted elsewhere.
Google is only used to confirm who someone is when they sign in.

## 1. Install PostgreSQL (13 or newer)

Ubuntu / Debian:

```bash
sudo apt update && sudo apt install -y postgresql
```

RHEL / Rocky / Alma:

```bash
sudo dnf install -y postgresql-server && sudo postgresql-setup --initdb && sudo systemctl enable --now postgresql
```

Check the version with `psql --version`.

## 2. Create the database and its user

Pick a real password in place of `change-me`:

```bash
sudo -u postgres psql -c "create user annotator with password 'change-me';" -c "create database annotator owner annotator;"
```

## 3. Create the tables

From the `annotation_server` folder:

```bash
psql "postgresql://annotator:change-me@localhost:5432/annotator" -f db/schema.sql
```

This is for a fresh, empty database. Running it twice fails with
"already exists" errors, which is harmless. To start over from scratch
(deletes everything): `dropdb annotator && createdb -O annotator annotator`
as the postgres user, then apply it again.

## 4. Configure the server

Copy `.env.example` to `.env` and fill in:

- `DATABASE_URL` — the connection string from step 3.
- `SESSION_SECRET` — generate one:
  `python3 -c "import secrets; print(secrets.token_urlsafe(48))"`
- `GOOGLE_CLIENT_ID` — from step 6. Until it's set (and `DEV_LOGIN` is off),
  sign-in stays off: no login page, no projects, and the standalone audio
  annotator at `/audio` works as before.
- `REQUIRE_AUTH=true` once sign-in is on, so every API call needs a session.
- `DEV_LOGIN` — leave it `false` on the server (see "Local development").

Then `python3 -m pip install -r requirements.txt` and restart uvicorn. The
startup log says which settings are still missing.

## 5. pgAdmin (graphical interface)

Easiest: install **pgAdmin 4 desktop** on your own computer
(https://www.pgadmin.org/download/) and connect through SSH, so PostgreSQL
never has to be exposed to the network:

1. Register → Server…
2. **Connection** tab: Host `localhost`, Port `5432`, Database `annotator`,
   Username `annotator`, Password from step 2.
3. **SSH Tunnel** tab: Use SSH tunneling = on, Tunnel host = the server's
   address, Username = your Linux login, then your password or SSH key.

Tables are under Servers → (name) → Databases → annotator → Schemas →
public → Tables. Right-click a table → View/Edit Data to browse rows.

## 6. Google sign-in (once the server has a hostname)

Google only allows sign-in from `https://` addresses or `http://localhost`,
so this needs the server's hostname plus HTTPS.

1. https://console.cloud.google.com → create a project (free).
2. APIs & Services → OAuth consent screen → User type **External** (or
   **Internal** if UNCW's Google Workspace admins allow it, which limits
   sign-in to UNCW accounts). Fill in the app name and your email.
3. APIs & Services → Credentials → Create credentials → OAuth client ID →
   **Web application**.
4. Authorized JavaScript origins: add `https://<your-hostname>` and, for
   local testing, `http://localhost:5173`. No redirect URIs are needed.
5. Copy the client ID (`….apps.googleusercontent.com`) into
   `GOOGLE_CLIENT_ID` in `.env` and restart the server.

## Local development (Windows)

1. Install PostgreSQL 16+ with the EDB installer
   (https://www.postgresql.org/download/windows/), which includes pgAdmin.
   Keep port 5432 and note the `postgres` superuser password.
2. Create the user and database (PowerShell; adjust the version folder):

   ```powershell
   & "C:\Program Files\PostgreSQL\16\bin\psql.exe" -U postgres -c "create user annotator with password 'change-me';" -c "create database annotator owner annotator;"
   & "C:\Program Files\PostgreSQL\16\bin\psql.exe" "postgresql://annotator:change-me@localhost:5432/annotator" -f db/schema.sql
   ```

3. In `.env`, set `DATABASE_URL`, `SESSION_SECRET`, `REQUIRE_AUTH=true`
   and `DEV_LOGIN=true`. The developer login lets you sign in by typing any
   email (no password), so you can test several users and roles without
   Google. The server prints a large warning while it's on. **Never set
   `DEV_LOGIN=true` on the lab server.**
4. `py -m pip install -r requirements.txt`, then from `annotation_server`:
   `py -m uvicorn server:app --port 8000`, and `npm start` for the frontend.

## How it fits together

- `GET /auth/config` (public) — whether sign-in is on, the Google client id,
  and whether the developer login is enabled. The frontend reads this first.
- `POST /auth/google` — the frontend sends Google's ID token; the server
  verifies it, creates/updates the `users` row (linking an existing row with
  the same email), accepts any pending project invites for that email, and
  returns a session token. `POST /auth/dev` does the same from just an email
  when `DEV_LOGIN=true`.
- Every later request sends `Authorization: Bearer <session token>`.
- `GET /auth/me` — the signed-in user and their projects.
- `/projects/...` (`projects_api.py`) — projects, members and invites, media
  files, labels and annotations. Roles are checked on the server for every
  call:

  | Role      | Can                                                            |
  |-----------|----------------------------------------------------------------|
  | viewer    | see everything in the project                                  |
  | annotator | + upload files, create labels and annotations, edit/delete their own annotations and labels |
  | admin     | + edit/delete anyone's labels, files and annotations, rename the project, add/remove viewers and annotators |
  | owner     | + add/remove admins and owners, delete the project             |

  Adding a member by email adds an existing user right away; anyone else
  gets an invite that is accepted the first time they sign in. A label that
  annotations still use can't be deleted (409).
- `POST /upload?project_id=…` and `GET /files/{file_id}?project_id=…` also
  register the audio in that project (`media_files`, returned as
  `media_file_id`).
- `media_files.media_type` is `audio`, `image` or `video`; only audio has an
  annotator so far. `annotations.extra` (jsonb) is reserved for image/video
  geometry.

## Backups

```bash
pg_dump "postgresql://annotator:change-me@localhost:5432/annotator" > annotator-$(date +%F).sql
```
