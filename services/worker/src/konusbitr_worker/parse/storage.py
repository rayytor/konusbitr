"""The worker's object-store client.

`packages/storage` is the TypeScript half of this and the two do not share a
line of code, on purpose — the seam between the runtimes is a Redis stream and
nothing else. What they do share is the **key layout**, and that is not
duplicated here either: the worker is told an object key in the job payload and
derives thumbnail keys from the document id it was given. It never constructs a
key from user input, and it never guesses where an object lives.

boto3 is synchronous, so every call runs in a thread. Wrapping rather than
reaching for an async S3 client keeps the dependency surface to the one SDK
that every S3-compatible provider tests against.
"""

from __future__ import annotations

import asyncio
import hashlib
from pathlib import Path
from typing import Any, Self

from konusbitr_worker.contracts import JobErrorCode
from konusbitr_worker.errors import JobFailure
from konusbitr_worker.settings import Settings

__all__ = ["ObjectStore", "sha256_of"]

#: Read size for hashing and downloading. Large enough that a 500MB object is
#: not a million syscalls, small enough that memory stays flat.
_CHUNK_BYTES = 1024 * 1024


def sha256_of(path: Path) -> str:
    """Digest a file without holding it in memory."""
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(_CHUNK_BYTES):
            digest.update(chunk)
    return digest.hexdigest()


class ObjectStore:
    """Get an object down, put a derived artifact back up. Nothing else."""

    def __init__(self, client: Any, bucket: str) -> None:
        self._client = client
        self._bucket = bucket

    @classmethod
    def from_settings(cls, settings: Settings) -> Self:
        import boto3
        from botocore.config import Config

        client = boto3.client(
            "s3",
            endpoint_url=settings.s3_endpoint,
            region_name=settings.s3_region,
            aws_access_key_id=settings.s3_access_key_id,
            aws_secret_access_key=settings.s3_secret_access_key,
            config=Config(
                # MinIO and most non-AWS endpoints cannot do virtual-host
                # addressing; the same flag the TypeScript client reads.
                s3={"addressing_style": "path" if settings.s3_force_path_style else "auto"},
                retries={"max_attempts": 3, "mode": "standard"},
                signature_version="s3v4",
            ),
        )
        return cls(client, settings.s3_bucket)

    async def download(self, key: str, destination: Path) -> None:
        """Stream one object to a local path.

        A missing object is terminal: the bytes the job was about to parse are
        not there, and they will not appear on a retry. Anything else — a
        refused connection, a 500, a timeout — is the store being unavailable,
        which is exactly the failure a retry is for.
        """
        try:
            await asyncio.to_thread(self._download, key, destination)
        except JobFailure:
            raise
        except Exception as error:
            if _is_not_found(error):
                raise JobFailure(
                    JobErrorCode.object_missing,
                    "The uploaded file is no longer in storage.",
                ) from error
            raise JobFailure(
                JobErrorCode.storage_unavailable,
                "The file store could not be reached.",
            ) from error

    def _download(self, key: str, destination: Path) -> None:
        destination.parent.mkdir(parents=True, exist_ok=True)
        with destination.open("wb") as handle:
            self._client.download_fileobj(self._bucket, key, handle)

    async def put_bytes(self, key: str, body: bytes, *, content_type: str) -> None:
        """Upload a small derived artifact — a thumbnail, not a document."""
        try:
            await asyncio.to_thread(
                self._client.put_object,
                Bucket=self._bucket,
                Key=key,
                Body=body,
                ContentType=content_type,
            )
        except Exception as error:
            raise JobFailure(
                JobErrorCode.storage_unavailable,
                "The file store refused a write.",
            ) from error

    async def ping(self) -> None:
        """Prove the credentials work, not merely that the endpoint answers.

        `/ready` asks the endpoint for a response of any kind, which catches a
        store that is down. This asks it a question only a correctly configured
        client can get an answer to, which catches the far more common failure:
        a bucket name or an access key that is wrong everywhere except in the
        variable nobody re-read.
        """
        await asyncio.to_thread(self._client.head_bucket, Bucket=self._bucket)


def _is_not_found(error: Exception) -> bool:
    """Whether botocore is telling us the key (or bucket) is absent."""
    response = getattr(error, "response", None)
    if not isinstance(response, dict):
        return False
    code = str(response.get("Error", {}).get("Code", ""))
    status = response.get("ResponseMetadata", {}).get("HTTPStatusCode")
    return code in {"404", "NoSuchKey", "NoSuchBucket", "NotFound"} or status == 404
