"""SEC-004: blunt authenticated SSRF / internal port-scanning via the DB and
deploy connection endpoints.

The DB/deploy endpoints must connect to user-supplied (often internal) databases —
that is the product — so a blanket egress block is wrong. Instead we apply two
mitigations that don't break legitimate connections:

  - GENERIC_CONNECTION_ERROR: every FAILED connection attempt returns the same
    opaque message (no host/port/driver text, no SQL error number). A caller can't
    use the error to tell an open host:port from a closed/filtered one.
  - a per-identity RATE LIMIT on connection attempts, to blunt scanning.

This is a mitigation, not a hard control: a determined caller can still infer
coarse reachability from response timing within the rate budget. Network-level
egress control remains the backstop. State is process-global (single-process dev
server), mirroring the login throttle in auth_service.
"""
import threading
import time
from typing import Tuple

# Returned to the client for ANY failed connection attempt (db test/metadata/profile,
# deploy connectivity). Deliberately carries no host/port/driver/error-number detail.
GENERIC_CONNECTION_ERROR = (
    "Could not connect to the database. Check the server, database and credentials, "
    "and that the server is reachable from the application host."
)

_LOCK = threading.Lock()
_ATTEMPTS = {}          # identity -> [attempt epoch seconds within the window]
_MAX_ATTEMPTS = 30      # connection attempts allowed per identity per window
_WINDOW = 60            # seconds


def _prune(identity: str, now: float):
    hits = [t for t in _ATTEMPTS.get(identity, []) if now - t < _WINDOW]
    _ATTEMPTS[identity] = hits
    return hits


def check_rate(identity) -> Tuple[bool, int]:
    """Record one connection attempt for `identity`; return (allowed, retry_after_s).

    When the identity has already made _MAX_ATTEMPTS within _WINDOW, the attempt is
    NOT recorded and (False, seconds-until-a-slot-frees) is returned.
    """
    identity = str(identity if identity is not None else "anon")
    now = time.time()
    with _LOCK:
        hits = _prune(identity, now)
        if len(hits) >= _MAX_ATTEMPTS:
            retry = max(1, int(_WINDOW - (now - hits[0])))
            return False, retry
        hits.append(now)
        _ATTEMPTS[identity] = hits
        return True, 0
