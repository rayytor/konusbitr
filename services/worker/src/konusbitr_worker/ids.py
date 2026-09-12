"""Prefixed, collision-resistant ids, in the same shape the TypeScript side uses.

Every table in Konusbitr is keyed on ``prefix_<cuid2>`` — readable in a log,
safe in a URL, unique without coordination. The TypeScript half gets them from
``@paralleldrive/cuid2``; this is the Python half of the same convention.

Only the *shape* is a contract, never the value: no id generated here is ever
compared with one generated there, because each row is written by exactly one
runtime. What matters is that a `prs_…` from the worker is indistinguishable
from a `prs_…` from the web app to everything downstream — a log grep, a URL, a
support conversation.

The construction follows cuid2: a leading letter (so an id is always a valid
identifier), then a hash over the current time, a per-process counter, a random
salt and a host fingerprint, rendered in base36. The counter is what keeps two
ids minted in the same millisecond apart.
"""

from __future__ import annotations

import hashlib
import itertools
import os
import secrets
import socket
import string
import time

__all__ = ["ID_PREFIXES", "new_id"]

#: The prefixes the worker mints. The full set lives in `packages/db/src/id.ts`.
ID_PREFIXES = {
    "document": "doc",
    "parse_result": "prs",
    "page": "pag",
    "chunk": "chk",
    "job": "job",
}

_LENGTH = 24
_ALPHABET = string.digits + string.ascii_lowercase
_counter = itertools.count(secrets.randbelow(2**32))

#: Distinguishes two processes that start in the same millisecond on different
#: hosts — a real possibility when a deployment scales the worker out.
_FINGERPRINT = f"{socket.gethostname()}{os.getpid()}"


def _base36(value: int) -> str:
    if value == 0:
        return "0"
    digits: list[str] = []
    while value:
        value, remainder = divmod(value, 36)
        digits.append(_ALPHABET[remainder])
    return "".join(reversed(digits))


def new_id(prefix: str) -> str:
    """Generate ``prefix_<cuid2>``."""
    first = secrets.choice(string.ascii_lowercase)
    material = "".join(
        (
            _base36(time.time_ns() // 1_000_000),
            _base36(next(_counter)),
            secrets.token_hex(16),
            _FINGERPRINT,
        )
    )
    digest = hashlib.sha3_512(material.encode("utf-8")).digest()
    body = _base36(int.from_bytes(digest, "big"))[: _LENGTH - 1]
    return f"{prefix}_{first}{body}"
