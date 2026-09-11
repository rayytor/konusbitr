"""Konusbitr document pipeline worker.

This is the Python half of a deliberately two-runtime system. TypeScript owns
the product surface; this service owns parsing, OCR, chunking and embedding,
because every serious PDF layout library is Python.

The entire contract between the two runtimes is a Redis queue plus JSON
payloads. There is no shared ORM, no RPC framework, and no import that crosses
the language boundary in either direction. The payload schemas are generated
from the Zod definitions in ``packages/shared``; they are never hand-written
here.

FastAPI and arq arrive in Phase 06.
"""

__all__ = ["__version__"]

__version__ = "0.0.0"
