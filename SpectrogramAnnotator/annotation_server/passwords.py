"""
Password hashing and sign-in throttling for the email + password login.

Hashes use scrypt from Python's standard library (no extra dependency),
stored as one self-describing string:
    scrypt$<log2 N>$<r>$<p>$<salt, base64>$<hash, base64>
so the cost can be raised later without breaking existing passwords
(needs_rehash() tells the caller to re-hash on the next good sign-in).
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import secrets
import threading
import time
from collections import defaultdict, deque

# ~32 MB and roughly 50–100 ms per hash on a typical server.
_LOG_N, _R, _P = 15, 8, 1
_DKLEN = 32
_MAXMEM = 64 * 1024 * 1024

MIN_LENGTH = 8
MAX_LENGTH = 256


def _b64(b: bytes) -> str:
    return base64.b64encode(b).decode("ascii")


def _scrypt(password: str, salt: bytes, log_n: int, r: int, p: int) -> bytes:
    return hashlib.scrypt(password.encode("utf-8"), salt=salt, n=2 ** log_n, r=r, p=p,
                          maxmem=_MAXMEM, dklen=_DKLEN)


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    return f"scrypt${_LOG_N}${_R}${_P}${_b64(salt)}${_b64(_scrypt(password, salt, _LOG_N, _R, _P))}"


def verify_password(password: str, stored: str | None) -> bool:
    """True if `password` matches `stored`. With stored=None it still does the
    work of one hash, so an unknown email takes as long as a wrong password."""
    if not stored:
        _scrypt(password, b"\0" * 16, _LOG_N, _R, _P)
        return False
    try:
        scheme, log_n, r, p, salt, expected = stored.split("$")
        if scheme != "scrypt":
            return False
        got = _scrypt(password, base64.b64decode(salt), int(log_n), int(r), int(p))
        return hmac.compare_digest(got, base64.b64decode(expected))
    except (ValueError, TypeError):
        return False


def needs_rehash(stored: str) -> bool:
    return not stored.startswith(f"scrypt${_LOG_N}${_R}${_P}$")


def password_problem(password: str) -> str | None:
    """Why a new password isn't acceptable, or None."""
    if len(password) < MIN_LENGTH:
        return f"Use at least {MIN_LENGTH} characters."
    if len(password) > MAX_LENGTH:
        return f"Use at most {MAX_LENGTH} characters."
    if not password.strip():
        return "The password can't be only spaces."
    return None


class Throttle:
    """
    In-memory limit on failed sign-ins: at most `limit` failures per key
    (an email, or a client address) within `window` seconds. Resets when
    the server restarts, which is fine for slowing down guessing.
    """

    def __init__(self, limit: int, window: float):
        self.limit, self.window = limit, window
        self._fails: dict[str, deque] = defaultdict(deque)
        self._lock = threading.Lock()

    def _prune(self, key: str, now: float) -> deque:
        q = self._fails[key]
        while q and now - q[0] > self.window:
            q.popleft()
        return q

    def retry_after(self, key: str) -> int:
        """Seconds until `key` may try again (0 = allowed now)."""
        now = time.monotonic()
        with self._lock:
            q = self._prune(key, now)
            if len(q) < self.limit:
                return 0
            return int(self.window - (now - q[0])) + 1

    def fail(self, key: str) -> None:
        with self._lock:
            self._prune(key, time.monotonic()).append(time.monotonic())

    def clear(self, key: str) -> None:
        with self._lock:
            self._fails.pop(key, None)
