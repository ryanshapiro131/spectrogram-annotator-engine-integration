-- Email + password sign-in: a scrypt hash per user (see passwords.py).
-- For databases created from schema.sql before this change; a fresh
-- schema.sql already includes this column. Safe to run more than once.
--   psql "$DATABASE_URL" -f db/migrations/002_password_login.sql

alter table users add column if not exists password_hash text;
