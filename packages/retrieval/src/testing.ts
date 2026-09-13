import { EMBEDDING_DIMENSIONS } from '@konusbitr/shared';

/**
 * Test and evaluation helpers for `@konusbitr/retrieval`.
 *
 * Exported from `@konusbitr/retrieval/testing` rather than the package root so
 * nothing in the product can reach them by accident, the same way
 * `@konusbitr/db/testing` is kept apart.
 */

/** FNV-1a, 32-bit. Small, fast, and stable across runs and platforms. */
function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}%$+.-]+/u)
    .map((token) => token.replace(/^[.-]+|[.-]+$/g, ''))
    .filter((token) => token.length > 0);
}

/**
 * A deterministic, offline embedding function: the hashing trick.
 *
 * Every token is hashed to one of `EMBEDDING_DIMENSIONS` buckets with a signed
 * weight, the buckets are accumulated, and the result is L2-normalized so
 * cosine distance behaves. It needs no network, no key and no model download,
 * and it returns the same vector for the same text forever.
 *
 * **What it is for, and what it is not.** It exists so the dense leg can be
 * exercised as real SQL against real pgvector — a query that throws, or an
 * index that is never consulted, is then a failing test rather than silent
 * keyword-only retrieval. It is emphatically *not* a stand-in for a trained
 * embedding model: it captures lexical overlap and nothing else, so any quality
 * number measured with it describes the retrieval machinery, not the quality a
 * deployment with a real `EMBEDDING_MODEL` would see. `evals/RESULTS.md` says
 * so where the numbers are recorded.
 */
export function hashingEmbed(text: string, dimensions: number = EMBEDDING_DIMENSIONS): number[] {
  const vector = new Array<number>(dimensions).fill(0);
  const tokens = tokenize(text);

  for (const token of tokens) {
    const hash = fnv1a(token);
    const index = hash % dimensions;
    const sign = (hash >>> 16) & 1 ? 1 : -1;
    // Down-weight very common short tokens so a shared "the" counts for less
    // than a shared "INV-4471". A crude stand-in for IDF, but a monotone one.
    const weight = token.length <= 2 ? 0.25 : 1;
    vector[index] = (vector[index] ?? 0) + sign * weight;
  }

  let norm = 0;
  for (const value of vector) {
    norm += value * value;
  }
  norm = Math.sqrt(norm);
  if (norm === 0) {
    // An empty or entirely-punctuation string still has to produce a unit
    // vector: pgvector's cosine distance is undefined for a zero vector.
    vector[0] = 1;
    return vector;
  }

  return vector.map((value) => value / norm);
}

/** The `embed` override `retrieve()` takes, backed by {@link hashingEmbed}. */
export function hashingEmbedder(): (text: string) => Promise<number[]> {
  return async (text: string) => hashingEmbed(text);
}
