import type { Database } from '@konusbitr/db';
import type { ChunkMeta, ChunkPage, Env } from '@konusbitr/shared';

/** Scope of the retrieval operation. */
export type Scope =
  | { kind: 'document'; documentId: string }
  | { kind: 'corpus'; folderId?: string | null };

/** A conversation message in history. */
export type Message = {
  role: 'user' | 'assistant' | 'system';
  content: string;
};

/** Input arguments for `retrieve()`. */
export type RetrieveOptions = {
  orgId: string;
  scope: Scope;
  query: string;
  history?: Message[];
  topK?: number;
  rerankEnabled?: boolean;
  hydeEnabled?: boolean;
  multiQueryEnabled?: boolean;
  efSearch?: number;
  env?: Env;
  db?: Database;
  conversationId?: string;
  turn?: number;
  /**
   * Override how the query is turned into a vector.
   *
   * This is not a way around the model router — production callers leave it
   * unset and the embedding role resolves through `@konusbitr/ai` as usual. It
   * exists so the eval harness and the integration tests can exercise the real
   * SQL against a real database without a provider key, which is the only way a
   * broken dense query gets caught before it reaches a user.
   */
  embed?: (text: string) => Promise<number[]>;
  /**
   * Which legs to run. Both, unless told otherwise.
   *
   * Ablation is the only caller: the eval harness measures dense-only against
   * hybrid, and it has to be the same code path doing both or the comparison is
   * between a pipeline and a description of one.
   */
  legs?: readonly ('dense' | 'sparse')[];
  /**
   * Called when one retrieval leg fails while the other still returns results.
   *
   * Retrieval degrades rather than erroring in that case, so without this the
   * degradation is invisible. When every leg fails, `retrieve()` throws instead.
   */
  onLegError?: (leg: string, error: unknown) => void;
};

/**
 * A chunk retrieved and scored by the retrieval pipeline.
 *
 * Preserves full page and bounding box geometry through every stage
 * for accurate citation highlights in Phase 10+.
 */
export type RetrievedChunk = {
  id: string;
  documentId: string;
  ordinal: number;
  text: string;
  score: number;
  sectionPath: string | null;
  pages: ChunkPage[];
  meta?: ChunkMeta | null;
  /** Primary page number (first page touched). */
  page: number;
  /** Primary bounding box [x0, y0, x1, y1] on the primary page. */
  bbox: [number, number, number, number];
};
