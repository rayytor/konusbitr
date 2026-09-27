import { scopedDb } from '@konusbitr/db';
import { ApiDocumentSchema, DeleteDocumentResponseSchema } from '@konusbitr/shared';
import { db } from '@/lib/db';
import { sweepDocumentObjects } from '@/lib/ingest/documents';
import type { RouteContext } from '../context';
import { ApiError } from '../errors';
import type { RouteImplementation } from '../mount';
import type { RouteDefinition } from '../registry';

/**
 * `GET` and `DELETE /v2/documents/:docId`.
 *
 * The two calls that make a `docId` usable as a handle: one to find out whether
 * the document is ready and how many pages it turned out to have, one to make
 * it go away. Neither costs credits — a caller should never have to weigh
 * checking a status against a bill.
 */

const getDefinition: RouteDefinition = {
  method: 'get',
  path: '/documents/:docId',
  operationId: 'getDocument',
  summary: 'Fetch a document by id',
  description: [
    "A document's status and page count. `status` is `queued`, `parsing`,",
    '`partially_ready`, `ready`, `failed` or `cancelled`; a failed document',
    'carries a stable `errorCode` alongside the human-readable `error`.',
    '',
    'This is what to poll while a parse is running. It costs nothing.',
  ].join('\n'),
  scopes: ['documents:read'],
  body: 'none',
  response: ApiDocumentSchema,
  params: [{ name: 'docId', description: 'The document id returned by any endpoint.' }],
  errors: ['not_found'],
};

const deleteDefinition: RouteDefinition = {
  method: 'delete',
  path: '/documents/:docId',
  operationId: 'deleteDocument',
  summary: 'Delete a document and everything derived from it',
  description: [
    'Removes the document row, its pages, its chunks and its stored bytes.',
    '',
    'The parse itself survives in the shared parse cache, keyed on the file and',
    'its settings rather than on this document — so re-uploading the same bytes',
    'later is still free. Deleting a document removes your copy of it, not the',
    'work that was done on it.',
  ].join('\n'),
  scopes: ['documents:write'],
  body: 'none',
  response: DeleteDocumentResponseSchema,
  params: [{ name: 'docId', description: 'The document id to delete.' }],
  errors: ['not_found'],
};

async function read(ctx: RouteContext) {
  const row = await scopedDb(db(), ctx.auth.orgId).documentById(ctx.params.docId ?? '');
  if (!row) throw ApiError.notFound(`No document ${ctx.params.docId} in this organization.`);

  return {
    docId: row.id,
    filename: row.filename,
    status: row.status,
    pageCount: row.pageCount,
    byteSize: row.byteSize,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    error: row.error,
    errorCode: row.errorCode,
  };
}

async function remove(ctx: RouteContext) {
  const docId = ctx.params.docId ?? '';
  const row = await scopedDb(db(), ctx.auth.orgId).deleteDocument(docId);
  if (!row) throw ApiError.notFound(`No document ${docId} in this organization.`);

  // After the commit, never before: a blob orphaned by a failed transaction is
  // reclaimable, and a row pointing at bytes that are already gone is not.
  await sweepDocumentObjects(ctx.auth.orgId, docId);

  return { docId, deleted: true as const };
}

export const getDocumentRoute: RouteImplementation = { definition: getDefinition, run: read };
export const deleteDocumentRoute: RouteImplementation = {
  definition: deleteDefinition,
  run: remove,
};
