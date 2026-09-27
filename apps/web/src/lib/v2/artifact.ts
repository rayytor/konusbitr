import { type DocumentRow, scopedDb } from '@konusbitr/db';
import { type ExtractedImage, ExtractedImageSchema, type ParsedElement } from '@konusbitr/shared';
import type { AuthContext } from '@/lib/auth/context';
import { db } from '@/lib/db';
import { ApiError } from './errors';

/**
 * Reading the worker's parse artifact from the TypeScript side.
 *
 * The artifact crosses the runtime boundary through Postgres, as the `contents`
 * `jsonb` column of `parse_results` — not as a message on the queue — so there
 * is nothing generated in either direction and nothing to import. What there is
 * instead is this module: one place that knows the artifact's field names, so
 * that when the Python side changes one, exactly one TypeScript file is wrong
 * rather than four routes. `packages/shared/test/parse-artifact.test.ts` pins
 * the literal JSON both halves agree on.
 *
 * Every reader here is deliberately lenient. A malformed element is dropped
 * rather than raised on: the alternative is a 500 on a document that parsed
 * fine and has one odd row, and the elements are a list — one missing entry is
 * a missing paragraph, not a broken response.
 */

export type DocumentArtifact = {
  markdown: string;
  contents: ParsedElement[];
  images: ExtractedImage[];
  pageCount: number;
};

type RawElement = Record<string, unknown>;

function asBbox(value: unknown): [number, number, number, number] | null {
  if (!Array.isArray(value) || value.length !== 4) return null;
  const numbers = value.map(Number);
  return numbers.every((n) => Number.isFinite(n))
    ? (numbers as [number, number, number, number])
    : null;
}

function asStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.map((entry) => String(entry ?? ''));
}

/**
 * One stored element as the public API describes it.
 *
 * A table's `headers` and `rows` are lifted out of `tableJson` to the top
 * level. Upstream's `contents` is a flat list of elements and a caller reading
 * a table should not have to know that ours nests the grid one level deeper —
 * and `cells`, which is ours alone, stays out of the public shape because it
 * pins an internal structure into a published contract for a detail no
 * compatible client reads.
 */
function presentElement(raw: RawElement): ParsedElement | null {
  const bbox = asBbox(raw.bbox);
  const page = Number(raw.page);
  if (!bbox || !Number.isInteger(page) || page < 1) return null;

  const table = (raw.tableJson ?? null) as Record<string, unknown> | null;
  const text = typeof raw.text === 'string' ? raw.text : null;
  const markdown = typeof raw.markdown === 'string' ? raw.markdown : null;
  const sectionPath = asStringArray(raw.sectionPath);
  const level = Number(raw.level);

  return {
    type: typeof raw.type === 'string' ? raw.type : 'paragraph',
    page,
    bbox,
    text,
    // A table's markdown is its pipe table, which is the rendering a model and
    // a human both want; for every other element it is the same string as
    // `text` and is therefore not worth repeating.
    markdown: table ? markdown : null,
    headers: table ? (asStringArray(table.headers) ?? []) : null,
    rows: table
      ? ((Array.isArray(table.rows) ? table.rows : []).map(
          (row) => asStringArray(row) ?? [],
        ) as string[][])
      : null,
    level: Number.isInteger(level) && level > 0 ? level : null,
    sectionPath: sectionPath && sectionPath.length > 0 ? sectionPath.join(' > ') : null,
  };
}

function presentImages(raw: unknown): ExtractedImage[] {
  if (!Array.isArray(raw)) return [];
  const images: ExtractedImage[] = [];
  for (const entry of raw) {
    const parsed = ExtractedImageSchema.safeParse(entry);
    if (parsed.success) images.push(parsed.data);
  }
  return images;
}

/**
 * The artifact for a document this organization owns.
 *
 * Raises `document_not_ready` rather than returning an empty artifact when
 * there is no finished parse. The two are not the same thing and the difference
 * matters: an empty `contents` on a document that parsed is a document with no
 * text in it, which is a thing the pipeline refuses to produce, while a missing
 * row is a parse that has not happened yet and will.
 */
export async function loadArtifact(
  auth: AuthContext,
  document: DocumentRow,
): Promise<DocumentArtifact> {
  const row = await scopedDb(db(), auth.orgId).parseArtifactForDocument(document.id);

  if (!row) {
    throw new ApiError('document_not_ready', 'That document has no finished parse yet.', {
      docId: document.id,
      status: document.status,
    });
  }

  const contents = row.contents as Record<string, unknown> | null;
  const elements = Array.isArray(contents?.contents) ? (contents.contents as RawElement[]) : [];

  return {
    markdown: row.markdown ?? '',
    contents: elements
      .map(presentElement)
      .filter((element): element is ParsedElement => element !== null),
    images: presentImages(contents?.images),
    pageCount: row.pageCount ?? document.pageCount ?? 0,
  };
}
