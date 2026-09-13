import type { Database } from '@konusbitr/db';
import { parseEnv } from '@konusbitr/shared';
import { describe, expect, it, vi } from 'vitest';
import { retrieve } from '../src/retrieve.js';

const baseEnv = {
  APP_URL: 'http://localhost:3000',
  DATABASE_URL: 'postgresql://konusbitr:konusbitr@localhost:5432/konusbitr',
  REDIS_URL: 'redis://localhost:6379',
  S3_ENDPOINT: 'http://localhost:9000',
  S3_BUCKET: 'konusbitr',
  S3_ACCESS_KEY_ID: 'konusbitr',
  S3_SECRET_ACCESS_KEY: 'konusbitr-dev-secret',
};

describe('retrieve() pipeline', () => {
  it('retrieves chunks with page and bbox metadata preserved through every stage', async () => {
    const env = parseEnv(baseEnv);

    // Mock database returning chunks
    const fakeDb = {
      select: () => ({
        from: () => ({
          where: () => ({
            orderBy: () => ({
              limit: async (): Promise<Record<string, unknown>[]> => [
                {
                  id: 'chk_invoice_1',
                  documentId: 'doc_inv_1',
                  ordinal: 1,
                  text: 'Invoice INV-2024-9988 total amount $4,200',
                  sectionPath: 'Invoices > 2024',
                  pages: [{ page: 3, bbox: [50, 100, 300, 400] }],
                  meta: { kind: 'prose' },
                  score: 0.88,
                },
              ],
            }),
          }),
        }),
      }),
      execute: vi.fn(),
    } as unknown as Database;

    const results = await retrieve({
      orgId: 'org_test',
      scope: { kind: 'document', documentId: 'doc_inv_1' },
      query: 'INV-2024-9988',
      db: fakeDb,
      env,
      rerankEnabled: false,
    });

    expect(results).toHaveLength(1);
    const chunk = results[0];
    expect(chunk).toBeDefined();
    if (!chunk) throw new Error('Expected chunk');
    expect(chunk.id).toBe('chk_invoice_1');
    expect(chunk.text).toContain('INV-2024-9988');
    expect(chunk.page).toBe(3);
    expect(chunk.bbox).toEqual([50, 100, 300, 400]);
    expect(chunk.pages).toHaveLength(1);
    expect(chunk.pages[0]?.page).toBe(3);
    expect(chunk.pages[0]?.bbox).toEqual([50, 100, 300, 400]);
    expect(chunk.sectionPath).toBe('Invoices > 2024');
  });

  it('demonstrates the sparse leg doing real work for rare exact tokens', async () => {
    // When a rare token like an invoice number appears, dense search might not match
    // or embedding model might not be configured, but sparse search finds it
    const env = parseEnv(baseEnv); // No embedding model configured

    const fakeDb = {
      select: () => ({
        from: () => ({
          where: () => ({
            orderBy: () => ({
              limit: async (): Promise<Record<string, unknown>[]> => [
                {
                  id: 'chk_part_number',
                  documentId: 'doc_parts',
                  ordinal: 5,
                  text: 'Part number PN-XJ-90210 replacement specification',
                  sectionPath: 'Hardware > Specs',
                  pages: [{ page: 2, bbox: [72, 100, 500, 200] }],
                  meta: { kind: 'prose' },
                  score: 0.95,
                },
              ],
            }),
          }),
        }),
      }),
      execute: vi.fn(),
    } as unknown as Database;

    const results = await retrieve({
      orgId: 'org_test',
      scope: { kind: 'corpus' },
      query: 'PN-XJ-90210',
      db: fakeDb,
      env,
      rerankEnabled: false,
    });

    expect(results).toHaveLength(1);
    expect(results[0]?.text).toContain('PN-XJ-90210');
  });

  it('enforces corpus diversity cap of max 3 chunks per document', async () => {
    const env = parseEnv(baseEnv);

    // Provide 5 chunks from doc_verbose and 2 chunks from doc_second
    const mockChunks = [
      {
        id: 'chk_v1',
        documentId: 'doc_verbose',
        ordinal: 0,
        text: 'Verbose doc 1',
        sectionPath: null,
        pages: [{ page: 1, bbox: [0, 0, 10, 10] }],
        score: 0.99,
      },
      {
        id: 'chk_v2',
        documentId: 'doc_verbose',
        ordinal: 1,
        text: 'Verbose doc 2',
        sectionPath: null,
        pages: [{ page: 2, bbox: [0, 0, 10, 10] }],
        score: 0.98,
      },
      {
        id: 'chk_v3',
        documentId: 'doc_verbose',
        ordinal: 2,
        text: 'Verbose doc 3',
        sectionPath: null,
        pages: [{ page: 3, bbox: [0, 0, 10, 10] }],
        score: 0.97,
      },
      {
        id: 'chk_v4',
        documentId: 'doc_verbose',
        ordinal: 3,
        text: 'Verbose doc 4',
        sectionPath: null,
        pages: [{ page: 4, bbox: [0, 0, 10, 10] }],
        score: 0.96,
      },
      {
        id: 'chk_v5',
        documentId: 'doc_verbose',
        ordinal: 4,
        text: 'Verbose doc 5',
        sectionPath: null,
        pages: [{ page: 5, bbox: [0, 0, 10, 10] }],
        score: 0.95,
      },
      {
        id: 'chk_s1',
        documentId: 'doc_second',
        ordinal: 0,
        text: 'Second doc 1',
        sectionPath: null,
        pages: [{ page: 1, bbox: [0, 0, 10, 10] }],
        score: 0.9,
      },
    ];

    const fakeDb = {
      select: () => ({
        from: () => ({
          where: () => ({
            orderBy: () => ({
              limit: async (): Promise<Record<string, unknown>[]> => mockChunks,
            }),
          }),
        }),
      }),
      execute: vi.fn(),
    } as unknown as Database;

    const results = await retrieve({
      orgId: 'org_test',
      scope: { kind: 'corpus' },
      query: 'general overview',
      db: fakeDb,
      env,
      rerankEnabled: false,
    });

    const verboseChunks = results.filter((c) => c.documentId === 'doc_verbose');
    expect(verboseChunks.length).toBeLessThanOrEqual(3);
    expect(results.some((c) => c.documentId === 'doc_second')).toBe(true);
  });

  it('works properly with RERANK_ENABLED=false', async () => {
    const env = parseEnv({ ...baseEnv, RERANK_ENABLED: 'false' });

    const fakeDb = {
      select: () => ({
        from: () => ({
          where: () => ({
            orderBy: () => ({
              limit: async (): Promise<Record<string, unknown>[]> => [
                {
                  id: 'chk_1',
                  documentId: 'doc_1',
                  ordinal: 0,
                  text: 'Some chunk text',
                  sectionPath: null,
                  pages: [{ page: 1, bbox: [0, 0, 50, 50] }],
                  score: 0.8,
                },
              ],
            }),
          }),
        }),
      }),
      execute: vi.fn(),
    } as unknown as Database;

    const results = await retrieve({
      orgId: 'org_test',
      scope: { kind: 'document', documentId: 'doc_1' },
      query: 'some query',
      db: fakeDb,
      env,
    });

    expect(results).toHaveLength(1);
    expect(results[0]?.id).toBe('chk_1');
  });
});
