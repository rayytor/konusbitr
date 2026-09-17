"""Where a long ingest puts the bitmaps it is not currently looking at.

A 300 DPI Letter page decoded to RGB is about 25MB. A 900-page scan is
therefore 22GB if it is ever held whole, and the worker's ceiling is two — so
the rule for this phase is that **a page bitmap has a lifetime measured in one
page**, and anything that needs to outlive that goes to disk.

This module is the disk half. It is deliberately not a cache: nothing here is
read twice, nothing is shared between jobs, and nothing survives the job. What
it provides is a directory that is created per job, is guaranteed to be removed
however the job ends — success, failure, cancellation, or the process being
killed and restarted — and whose files can be unlinked the moment the byte
stream that wanted them has been consumed.

The last of those is the one that is easy to get wrong. A scratch directory
that is only cleaned up in the happy path is a disk that fills silently over a
week of ordinary operation and then fails at everything at once, which is a far
worse failure than the memory it was protecting.
"""

from __future__ import annotations

import gc
import shutil
import tempfile
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

from konusbitr_worker.log import get_logger

__all__ = ["SCRATCH_ROOT", "ScratchSpace", "collect", "scratch_space", "sweep_orphans"]

logger = get_logger("konusbitr.worker.scratch")

#: Where per-job scratch directories are made.
#:
#: Under the system temp directory rather than a configured path, because the
#: contract with the operator is that this is *ephemeral* — a container with no
#: volume mounted must still be able to ingest a 900-page scan, and a path
#: somebody could point at durable storage invites the belief that something
#: here is worth keeping.
SCRATCH_ROOT = Path(tempfile.gettempdir()) / "konusbitr_scratch"


class ScratchSpace:
    """One job's scratch directory, and the page files inside it."""

    __slots__ = ("_root",)

    def __init__(self, root: Path) -> None:
        self._root = root

    @property
    def root(self) -> Path:
        return self._root

    def page_path(self, page_no: int, *, suffix: str = "webp") -> Path:
        """Where page `page_no`'s spilled bitmap goes.

        Named by page rather than by a counter so that a file left behind by a
        crash says which page it belonged to, and so that a re-delivered job
        overwrites its predecessor's spill instead of doubling it.
        """
        return self._root / f"page_{page_no:05d}.{suffix}"

    def release(self, path: Path) -> None:
        """Unlink a spilled file once whatever wanted it has finished with it.

        Missing is fine and is not worth a log line: the common way for a file
        to be absent here is that the batch that wrote it already released it,
        which is exactly the behaviour this method exists to encourage.
        """
        try:
            path.unlink(missing_ok=True)
        except OSError:  # pragma: no cover - a full or read-only disk
            logger.warning("could not unlink a scratch file", extra={"path": str(path)})

    def bytes_held(self) -> int:
        """How much this job currently has on disk. For the logs and the tests."""
        return sum(entry.stat().st_size for entry in self._root.glob("*") if entry.is_file())


@contextmanager
def scratch_space(job_id: str) -> Iterator[ScratchSpace]:
    """A scratch directory for one job, removed however the job ends.

    The directory name carries the job id so that a `du` on a struggling
    worker names the culprit rather than showing eight anonymous directories.
    The job id comes from `newId`, so it is already safe as a path segment —
    but it is sanitised anyway, because "a payload is a message, not an
    authority" applies to paths with more force than it applies to anything
    else in this codebase.
    """
    SCRATCH_ROOT.mkdir(parents=True, exist_ok=True)
    root = SCRATCH_ROOT / _safe_segment(job_id)
    root.mkdir(parents=True, exist_ok=True)
    try:
        yield ScratchSpace(root)
    finally:
        shutil.rmtree(root, ignore_errors=True)


def sweep_orphans() -> int:
    """Remove scratch directories left behind by a process that was killed.

    Called at startup, which is the only moment it is safe: the running
    process's own directories are indistinguishable from a dead one's, so a
    sweep at any other time would delete a colleague's working set. At startup
    this worker holds none, and anything under the root belongs to a run that
    is over.

    Returns how many were removed, which is a number worth having in the log of
    a worker that has been crash-looping.
    """
    if not SCRATCH_ROOT.exists():
        return 0

    removed = 0
    for entry in SCRATCH_ROOT.iterdir():
        if not entry.is_dir():
            continue
        shutil.rmtree(entry, ignore_errors=True)
        removed += 1

    if removed:
        logger.info("swept orphaned scratch directories", extra={"count": removed})
    return removed


def collect() -> None:
    """Run a collection cycle between batches.

    Explicit, and normally a smell. It is here because the thing being freed is
    not Python objects — it is the buffers behind numpy arrays and PIL images,
    which are large, are freed by the collector rather than by refcounting when
    they end up in a cycle, and are the entire difference between a worker that
    stays under two gigabytes on a 900-page scan and one the kernel kills at
    page 400. A cycle costs a few milliseconds once per sixteen pages.
    """
    gc.collect()


def _safe_segment(value: str) -> str:
    """The value reduced to characters that cannot mean anything to a path."""
    cleaned = "".join(
        character if character.isalnum() or character in "-_" else "_" for character in value
    )
    return cleaned[:64] or "job"
