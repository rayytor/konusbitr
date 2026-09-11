#!/bin/sh
# Create the Konusbitr bucket and an unprivileged access key, then exit.
#
# Runs as a one-shot Compose service that the web and worker containers wait on,
# so a first boot can never race an upload against a missing bucket. It is
# idempotent: re-running it on an existing volume is a no-op, which matters
# because Compose runs it on every `up`.

set -eu

: "${MINIO_ENDPOINT:?MINIO_ENDPOINT is required}"
: "${MINIO_ROOT_USER:?MINIO_ROOT_USER is required}"
: "${MINIO_ROOT_PASSWORD:?MINIO_ROOT_PASSWORD is required}"
: "${S3_BUCKET:?S3_BUCKET is required}"
: "${S3_ACCESS_KEY_ID:?S3_ACCESS_KEY_ID is required}"
: "${S3_SECRET_ACCESS_KEY:?S3_SECRET_ACCESS_KEY is required}"

# MinIO rejects secrets shorter than this, and the failure it gives is obscure.
if [ "${#S3_SECRET_ACCESS_KEY}" -lt 8 ]; then
  echo "minio-init: S3_SECRET_ACCESS_KEY must be at least 8 characters" >&2
  exit 1
fi

echo "minio-init: connecting to ${MINIO_ENDPOINT}"
mc alias set konusbitr "${MINIO_ENDPOINT}" "${MINIO_ROOT_USER}" "${MINIO_ROOT_PASSWORD}" > /dev/null

echo "minio-init: ensuring bucket '${S3_BUCKET}'"
mc mb --ignore-existing "konusbitr/${S3_BUCKET}"

# Uploaded documents are private. They are read back through presigned URLs
# (Phase 05), never by making the bucket public.
mc anonymous set none "konusbitr/${S3_BUCKET}" > /dev/null

# An unprivileged key for the application, so nothing but this script ever
# authenticates as the MinIO superuser. `mc admin user add` is not idempotent,
# hence the existence check.
if mc admin user info konusbitr "${S3_ACCESS_KEY_ID}" > /dev/null 2>&1; then
  echo "minio-init: access key '${S3_ACCESS_KEY_ID}' already exists"
else
  echo "minio-init: creating access key '${S3_ACCESS_KEY_ID}'"
  mc admin user add konusbitr "${S3_ACCESS_KEY_ID}" "${S3_SECRET_ACCESS_KEY}"
fi

# `attach` is the current spelling, `set` the pre-2023 one, and `attach` also
# errors when the policy is already attached — so try both and only warn if
# neither worked, rather than failing a boot that is otherwise fine.
mc admin policy attach konusbitr readwrite --user "${S3_ACCESS_KEY_ID}" > /dev/null 2>&1 ||
  mc admin policy set konusbitr readwrite "user=${S3_ACCESS_KEY_ID}" > /dev/null 2>&1 ||
  echo "minio-init: readwrite policy already attached to '${S3_ACCESS_KEY_ID}', or could not be attached"

echo "minio-init: done"
