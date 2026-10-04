-- =============================================================================
-- Spectrogram Annotator — schema (self-hosted PostgreSQL)
--
-- Ported from the original Supabase migration. Differences:
--   * `users` replaces Supabase's auth.users + public.profiles. Rows are
--     created by the annotation server on first Google sign-in (keyed on the
--     Google account's stable `sub` id).
--   * No Row Level Security. The frontend never talks to the database; every
--     read/write goes through FastAPI (annotation_server/app_auth.py), which
--     checks project roles with has_project_role() below.
--   * created_by / uploaded_by / invited_by have no auth.uid() default — the
--     server always sets them explicitly.
--
-- Model:
--   users             one row per person who has signed in with Google
--   projects          a team workspace
--   project_members   who is in a project + their role
--   project_invites   pending invites for emails that haven't signed in yet;
--                     accepted automatically on first sign-in with that email
--   audio_files       recordings registered to a project. The audio itself stays
--                     on the annotation server's disk; content_hash is the
--                     server's `file_id` (sha1 prefix) that links the two.
--   labels            ONE shared label vocabulary per project (name + color)
--   annotations       time (and optional frequency) regions, always attributed
--                     to the annotator who made them (created_by)
--
-- Roles (ascending privilege — enum order matters, see has_project_role):
--   viewer     read everything in the project
--   annotator  + upload files, create labels, create/edit/delete OWN annotations
--   admin      + edit/delete any label or file, delete anyone's annotations,
--                manage viewer/annotator members, rename the project
--   owner      + manage admins/owners, delete the project
--
-- Requires PostgreSQL 13+ (built-in gen_random_uuid()).
-- Apply with:  psql "$DATABASE_URL" -f db/schema.sql
-- =============================================================================


-- -----------------------------------------------------------------------------
-- Types
-- -----------------------------------------------------------------------------

create type project_role as enum ('viewer', 'annotator', 'admin', 'owner');


-- -----------------------------------------------------------------------------
-- Tables
-- -----------------------------------------------------------------------------

create table users (
  id            uuid primary key default gen_random_uuid(),
  google_sub    text not null unique,   -- Google's stable account id
  email         text not null,
  display_name  text,
  avatar_url    text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  last_login_at timestamptz
);
create index users_email_idx on users (lower(email));

create table projects (
  id           uuid primary key default gen_random_uuid(),
  name         text not null check (char_length(trim(name)) between 1 and 200),
  description  text,
  created_by   uuid references users (id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create table project_members (
  project_id  uuid not null references projects (id) on delete cascade,
  user_id     uuid not null references users (id) on delete cascade,
  role        project_role not null default 'annotator',
  created_at  timestamptz not null default now(),
  primary key (project_id, user_id)
);
create index project_members_user_id_idx on project_members (user_id);

create table project_invites (
  id           uuid primary key default gen_random_uuid(),
  project_id   uuid not null references projects (id) on delete cascade,
  email        text not null check (email = lower(trim(email))),
  role         project_role not null default 'annotator',
  invited_by   uuid references users (id) on delete set null,
  created_at   timestamptz not null default now(),
  accepted_at  timestamptz,
  unique (project_id, email)
);
create index project_invites_email_idx on project_invites (email) where accepted_at is null;

create table audio_files (
  id            uuid primary key default gen_random_uuid(),
  project_id    uuid not null references projects (id) on delete cascade,
  content_hash  text not null,   -- annotation server's file_id
  file_name     text not null,
  duration_sec  double precision not null check (duration_sec >= 0),
  sample_rate   integer not null check (sample_rate > 0),
  n_channels    smallint not null check (n_channels > 0),
  uploaded_by   uuid references users (id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (project_id, content_hash),
  -- target for annotations' composite FK (keeps annotation.project_id honest)
  unique (id, project_id)
);

create table labels (
  id              uuid primary key default gen_random_uuid(),
  project_id      uuid not null references projects (id) on delete cascade,
  name            text not null check (char_length(trim(name)) between 1 and 100),
  color           text not null default '#1a6b8a' check (color ~ '^#[0-9a-fA-F]{6}$'),
  display_height  integer not null default 32 check (display_height between 8 and 200),
  sort_order      integer not null default 0,
  created_by      uuid references users (id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (id, project_id)
);
-- The app resolves typed label names case-insensitively, so enforce that here.
create unique index labels_project_name_uniq on labels (project_id, lower(trim(name)));

create table annotations (
  id             uuid primary key default gen_random_uuid(),
  project_id     uuid not null,
  audio_file_id  uuid not null,
  label_id       uuid not null,
  -- Nullable so removing a user doesn't erase research data.
  created_by     uuid references users (id) on delete set null,
  start_sec      double precision not null check (start_sec >= 0),
  end_sec        double precision not null,
  -- Optional frequency bounds for box annotations (null = full band).
  freq_min_hz    real check (freq_min_hz >= 0),
  freq_max_hz    real check (freq_max_hz >= 0),
  notes          text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  check (end_sec > start_sec),
  check (freq_min_hz is null or freq_max_hz is null or freq_max_hz > freq_min_hz),
  -- Composite FKs guarantee the file and label belong to the same project as
  -- the annotation.
  foreign key (audio_file_id, project_id)
    references audio_files (id, project_id) on delete cascade,
  -- RESTRICT: deleting a shared label must not silently wipe every
  -- annotator's work. Reassign or delete its annotations first.
  foreign key (label_id, project_id)
    references labels (id, project_id) on delete restrict
);
create index annotations_file_time_idx on annotations (audio_file_id, start_sec);
create index annotations_label_idx     on annotations (label_id);
create index annotations_creator_idx   on annotations (created_by);
create index annotations_project_idx   on annotations (project_id);


-- -----------------------------------------------------------------------------
-- updated_at maintenance
-- -----------------------------------------------------------------------------

create function set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger set_updated_at before update on users
  for each row execute function set_updated_at();
create trigger set_updated_at before update on projects
  for each row execute function set_updated_at();
create trigger set_updated_at before update on audio_files
  for each row execute function set_updated_at();
create trigger set_updated_at before update on labels
  for each row execute function set_updated_at();
create trigger set_updated_at before update on annotations
  for each row execute function set_updated_at();


-- -----------------------------------------------------------------------------
-- Permission helper — used by the server in place of RLS policies.
-- -----------------------------------------------------------------------------

create function has_project_role(
  p_project_id uuid,
  p_user_id    uuid,
  p_min_role   project_role default 'viewer'
)
returns boolean
language sql
stable
as $$
  select exists (
    select 1
    from project_members m
    where m.project_id = p_project_id
      and m.user_id    = p_user_id
      and m.role      >= p_min_role
  );
$$;


-- -----------------------------------------------------------------------------
-- Integrity triggers
-- -----------------------------------------------------------------------------

-- Project creator becomes its owner.
create function handle_new_project()
returns trigger
language plpgsql
as $$
begin
  if new.created_by is not null then
    insert into project_members (project_id, user_id, role)
    values (new.id, new.created_by, 'owner')
    on conflict (project_id, user_id) do update set role = 'owner';
  end if;
  return new;
end;
$$;

create trigger on_project_created
  after insert on projects
  for each row execute function handle_new_project();

-- Never leave a project without an owner (demotion, removal, or leaving).
-- Skipped when the project itself is being deleted (cascade).
create function ensure_project_keeps_owner()
returns trigger
language plpgsql
as $$
begin
  if old.role <> 'owner' then
    return coalesce(new, old);
  end if;
  if tg_op = 'UPDATE' and new.role = 'owner' then
    return new;
  end if;
  if not exists (select 1 from projects where id = old.project_id) then
    return coalesce(new, old);
  end if;
  if not exists (
    select 1 from project_members
    where project_id = old.project_id
      and role = 'owner'
      and user_id <> old.user_id
  ) then
    raise exception 'A project must keep at least one owner. Transfer ownership first.'
      using errcode = 'check_violation';
  end if;
  return coalesce(new, old);
end;
$$;

create trigger ensure_project_keeps_owner
  before update or delete on project_members
  for each row execute function ensure_project_keeps_owner();
