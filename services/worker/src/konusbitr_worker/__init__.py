"""Konusbitr document pipeline worker.

This is the Python half of a deliberately two-runtime system. TypeScript owns
the product surface; this service owns parsing, OCR, chunking and embedding,
because every serious PDF layout library is Python.

The entire contract between the two runtimes is a Redis stream plus JSON
payloads. There is no shared ORM, no RPC framework, and no import that crosses
the language boundary in either direction. The payload schemas live in
:mod:`konusbitr_worker.contracts`, generated from the Zod definitions in
``packages/shared``; they are never hand-written here.

The pieces: :mod:`~konusbitr_worker.queue` speaks to the stream,
:mod:`~konusbitr_worker.runtime` runs the loop, :mod:`~konusbitr_worker.pipeline`
does the work — a stub until Phase 07 — and :mod:`~konusbitr_worker.app` exposes
``/health`` and ``/ready`` over FastAPI. ``docs/adr/0001-queue.md`` explains why
the transport is hand-rolled rather than BullMQ or arq.
"""

__all__ = ["__version__"]

__version__ = "0.0.0"
