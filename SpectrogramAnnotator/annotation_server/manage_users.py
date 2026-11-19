"""
Manage email + password accounts from the server's command line.

Run from annotation_server/ (it reads the same .env as the server):

    python3 manage_users.py set-password alice@uncw.edu --name "Alice"
        Create the account if it doesn't exist, then set its password
        (asked twice, not shown). Use this to reset a forgotten password,
        or to create accounts when PASSWORD_SIGNUP=closed.

    python3 manage_users.py remove-password alice@uncw.edu
        Turn off password sign-in for that account (its projects and
        annotations stay; set-password turns it back on).

    python3 manage_users.py list
        Every account, whether it has a password, and its last sign-in.

Add --password-stdin to set-password to read the password from standard
input instead of prompting (for scripts).

A new account isn't in any project yet: sign in as it and create a project
(you become its owner), or have a project admin add the email.
Sessions already signed in stay valid until they expire (SESSION_DAYS).
"""

import argparse
import getpass
import sys

import passwords
from app_auth import DB_ENABLED, tx


def _email(raw: str) -> str:
    email = raw.strip().lower()
    local, _, domain = email.partition("@")
    if not local or "." not in domain or " " in email:
        sys.exit(f"Not a valid email address: {raw!r}")
    return email


def _read_password(from_stdin: bool) -> str:
    if from_stdin:
        pw = sys.stdin.readline().rstrip("\r\n")
    else:
        pw = getpass.getpass("New password: ")
        if getpass.getpass("Repeat it: ") != pw:
            sys.exit("The passwords don't match. Nothing changed.")
    problem = passwords.password_problem(pw)
    if problem:
        sys.exit(f"{problem} Nothing changed.")
    return pw


def set_password(email: str, name: str | None, from_stdin: bool) -> None:
    pw_hash = passwords.hash_password(_read_password(from_stdin))
    with tx() as conn:
        row = conn.execute(
            """
            insert into users (email, display_name, password_hash)
            values (%s, %s, %s)
            on conflict (email) do update
              set password_hash = excluded.password_hash,
                  display_name = coalesce(%s, users.display_name)
            returning (xmax = 0) as created
            """,
            (email, name or email.split("@")[0], pw_hash, name),
        ).fetchone()
    print(f"{'Created' if row['created'] else 'Updated'} {email}: password set.")


def remove_password(email: str) -> None:
    with tx() as conn:
        row = conn.execute(
            "update users set password_hash = null where email = %s returning id", (email,)
        ).fetchone()
    print(f"{email}: password removed." if row else f"No account for {email}.")


def list_users() -> None:
    with tx() as conn:
        rows = conn.execute(
            """
            select email, display_name, password_hash is not null as has_password,
                   google_sub is not null as google, last_login_at
            from users order by email
            """
        ).fetchall()
    if not rows:
        print("No accounts yet.")
    for r in rows:
        how = ", ".join(x for x, on in (("password", r["has_password"]), ("google", r["google"])) if on) or "no sign-in method"
        last = r["last_login_at"].strftime("%Y-%m-%d %H:%M") if r["last_login_at"] else "never"
        print(f"{r['email']:<40} {(r['display_name'] or ''):<24} {how:<18} last sign-in: {last}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Manage email + password accounts.")
    sub = parser.add_subparsers(dest="command", required=True)
    p = sub.add_parser("set-password", help="create an account or reset its password")
    p.add_argument("email")
    p.add_argument("--name", help="display name (new accounts, or to change it)")
    p.add_argument("--password-stdin", action="store_true", help="read the password from stdin")
    p = sub.add_parser("remove-password", help="turn off password sign-in for an account")
    p.add_argument("email")
    sub.add_parser("list", help="list accounts")
    args = parser.parse_args()

    if not DB_ENABLED:
        sys.exit("DATABASE_URL isn't set (annotation_server/.env).")
    if args.command == "set-password":
        set_password(_email(args.email), args.name, args.password_stdin)
    elif args.command == "remove-password":
        remove_password(_email(args.email))
    else:
        list_users()


if __name__ == "__main__":
    main()
