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
"already exists" errors, which is harmless.

## 4. Configure the server

Copy `.env.example` to `.env` and fill in:

- `DATABASE_URL` — the connection string from step 3.
- `SESSION_SECRET` — generate one:
  `python3 -c "import secrets; print(secrets.token_urlsafe(48))"`
- `GOOGLE_CLIENT_ID` — from step 6. Until it's set, sign-in stays off and the
  app works as it does today.

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

## How it fits together

- `POST /auth/google` — the frontend sends Google's ID token; the server
  verifies it, creates/updates the `users` row, accepts any pending project
  invites for that email, and returns a session token.
- Every later request sends `Authorization: Bearer <session token>`.
- `GET /auth/me` — the signed-in user and their projects.
- Project roles (viewer / annotator / admin / owner) are checked in
  `app_auth.py` with the `has_project_role()` SQL function.
- Set `REQUIRE_AUTH=true` once the frontend has a sign-in page.

## Backups

```bash
pg_dump "postgresql://annotator:change-me@localhost:5432/annotator" > annotator-$(date +%F).sql
```
