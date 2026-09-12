/**
 * The object-key layout, and the rule that keeps it safe.
 *
 * ```
 * orgs/{orgId}/documents/{docId}/original.{ext}
 * orgs/{orgId}/documents/{docId}/pages/{n}.webp        # thumbnails, Phase 07
 * orgs/{orgId}/documents/{docId}/images/{n}.png        # extracted images, Phase 12
 * ```
 *
 * **A key is never built from user input.** Every segment below comes from an
 * id this system generated (`newId('org')`, `newId('doc')`) or from a small
 * closed set of extensions, and the builders assert that before they will
 * produce a key. An uploaded filename of `../../etc/passwd` therefore cannot
 * become a path: it is stored in `documents.filename` as a label and never
 * reaches the storage layer at all.
 */

/** Ids are `prefix_cuid2` — lowercase alphanumerics either side of one underscore. */
const ID_PATTERN = /^[a-z]{2,8}_[a-z0-9]{8,32}$/;

/** Extensions a key may end in. Additive as Phase 15 grows the MIME allowlist. */
const EXTENSION_PATTERN = /^[a-z0-9]{1,8}$/;

export class StorageKeyError extends Error {
  override readonly name = 'StorageKeyError';
}

function assertId(kind: string, value: string): string {
  if (!ID_PATTERN.test(value)) {
    throw new StorageKeyError(
      `${kind} "${value}" is not a generated id; storage keys are never built from user input`,
    );
  }
  return value;
}

function assertExtension(value: string): string {
  const normalized = value.toLowerCase().replace(/^\./, '');
  if (!EXTENSION_PATTERN.test(normalized)) {
    throw new StorageKeyError(`"${value}" is not a usable file extension`);
  }
  return normalized;
}

function assertIndex(kind: string, value: number): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new StorageKeyError(`${kind} must be a positive integer, got ${value}`);
  }
  return value;
}

/** Everything belonging to one document, so a delete can sweep the whole tree. */
export function documentPrefix(orgId: string, documentId: string): string {
  return `orgs/${assertId('orgId', orgId)}/documents/${assertId('documentId', documentId)}/`;
}

/** The uploaded bytes themselves. */
export function originalKey(orgId: string, documentId: string, extension: string): string {
  return `${documentPrefix(orgId, documentId)}original.${assertExtension(extension)}`;
}

/** A page thumbnail, written by the worker in Phase 07. */
export function pageThumbnailKey(orgId: string, documentId: string, pageNo: number): string {
  return `${documentPrefix(orgId, documentId)}pages/${assertIndex('pageNo', pageNo)}.webp`;
}

/** An image extracted from the document, written in Phase 12. */
export function documentImageKey(orgId: string, documentId: string, index: number): string {
  return `${documentPrefix(orgId, documentId)}images/${assertIndex('index', index)}.png`;
}
