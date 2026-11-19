-- Image annotator (first draft): per-file "verified" flag, as in labelImg.
-- For databases created from schema.sql before this change; a fresh
-- schema.sql already includes these columns. Safe to run more than once.
--   psql "$DATABASE_URL" -f db/migrations/001_image_annotator.sql

alter table media_files add column if not exists verified_at timestamptz;
alter table media_files add column if not exists verified_by uuid references users (id) on delete set null;
