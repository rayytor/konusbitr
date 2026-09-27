import {
  AskRequestSchema,
  AskResponseSchema,
  ChatWithAllPdfsRequestSchema,
  ChatWithPdfRequestSchema,
  ChatWithPdfResponseSchema,
  ExtractRequestSchema,
  ExtractResponseSchema,
  normalizeAliases,
  ParseRequestSchema,
  ParseResponseSchema,
  SplitRequestSchema,
  SplitResponseSchema,
} from '@konusbitr/shared';
import { describe, expect, it } from 'vitest';
import type { ZodType } from 'zod';

/**
 * The compatibility suite: the documented shapes, asserted field for field.
 *
 * `docs/api-compatibility.md` tells somebody migrating from PDF.ai exactly which
 * field names and types they can rely on. This is what stops that document
 * being a promise: every field in it appears below, and a rename that would
 * break an existing integration turns this red before it reaches a release.
 *
 * Asserted against the *schemas*, not against a live server, because the schemas
 * are what validate a request and what generate the OpenAPI document — so a
 * shape that passes here is the shape a caller actually meets.
 */

/** The object keys a schema accepts or produces. */
function keysOf(schema: ZodType): string[] {
  const shape = (schema as unknown as { shape?: Record<string, unknown> }).shape;
  if (!shape) throw new Error('not an object schema');
  return Object.keys(shape).sort();
}

describe('input selection', () => {
  const documentTaking: [string, ZodType][] = [
    ['parse', ParseRequestSchema],
    ['extract', ExtractRequestSchema],
    ['split', SplitRequestSchema],
    ['ask', AskRequestSchema],
  ];

  it.each(documentTaking)('%s accepts url and docId', (_name, schema) => {
    const keys = keysOf(schema);
    expect(keys).toContain('url');
    expect(keys).toContain('docId');
  });

  it.each(documentTaking)('%s takes parse settings under upstream`s names', (_name, schema) => {
    const keys = keysOf(schema);
    expect(keys).toContain('quality');
    expect(keys).toContain('lang_list');
    expect(keys).toContain('llm');
    // The camelCase spelling is an alias applied before validation, never a
    // second accepted field — two names in the schema would put both in the
    // generated document and in both SDKs.
    expect(keys).not.toContain('langList');
  });

  it.each(documentTaking)('%s accepts webhook_url for the async twin', (_name, schema) => {
    expect(keysOf(schema)).toContain('webhook_url');
  });
});

describe('request aliases', () => {
  it('rewrites our camelCase spellings onto the documented names', () => {
    expect(normalizeAliases({ langList: ['tr'], systemPrompt: 'x', webhookUrl: 'u' })).toEqual({
      lang_list: ['tr'],
      system_prompt: 'x',
      webhook_url: 'u',
    });
  });

  it('lets the documented name win when a caller sends both', () => {
    expect(normalizeAliases({ lang_list: ['en'], langList: ['tr'] })).toEqual({
      lang_list: ['en'],
      langList: ['tr'],
    });
  });

  it('leaves anything that is not an object alone', () => {
    expect(normalizeAliases(null)).toBeNull();
    expect(normalizeAliases([1, 2])).toEqual([1, 2]);
    expect(normalizeAliases('x')).toBe('x');
  });
});

describe('POST /v2/parse', () => {
  it('accepts exactly the documented request fields', () => {
    expect(keysOf(ParseRequestSchema)).toEqual(
      ['docId', 'filename', 'lang_list', 'llm', 'quality', 'url', 'webhook_url'].sort(),
    );
  });

  it('returns exactly the documented response fields', () => {
    expect(keysOf(ParseResponseSchema)).toEqual(
      ['cached', 'contents', 'docId', 'images', 'markdown', 'pageCount'].sort(),
    );
  });

  it('validates a minimal upstream-shaped request', () => {
    expect(ParseRequestSchema.safeParse({ docId: 'doc_1' }).success).toBe(true);
    expect(ParseRequestSchema.safeParse({ url: 'https://example.com/a.pdf' }).success).toBe(true);
  });

  it('types every element of contents with a page and a box', () => {
    const response = ParseResponseSchema.safeParse({
      docId: 'doc_1',
      markdown: '# Title',
      pageCount: 1,
      cached: false,
      images: [],
      contents: [
        {
          type: 'heading',
          page: 1,
          bbox: [10, 20, 300, 40],
          text: 'Title',
          markdown: null,
          headers: null,
          rows: null,
          level: 1,
          sectionPath: null,
        },
      ],
    });
    expect(response.success).toBe(true);
  });
});

describe('POST /v2/extract', () => {
  it('accepts exactly the documented request fields', () => {
    expect(keysOf(ExtractRequestSchema)).toEqual(
      [
        'docId',
        'lang_list',
        'llm',
        'quality',
        'schema',
        'system_prompt',
        'url',
        'webhook_url',
      ].sort(),
    );
  });

  it('returns exactly the documented response fields', () => {
    expect(keysOf(ExtractResponseSchema)).toEqual(
      ['citations', 'docId', 'result', 'unverified'].sort(),
    );
  });

  it('requires a schema, because that is the whole request', () => {
    expect(ExtractRequestSchema.safeParse({ docId: 'doc_1' }).success).toBe(false);
    expect(
      ExtractRequestSchema.safeParse({ docId: 'doc_1', schema: { type: 'object' } }).success,
    ).toBe(true);
  });

  it('gives every citation a schemaPath so a caller can find the value it supports', () => {
    const parsed = ExtractResponseSchema.safeParse({
      docId: 'doc_1',
      result: { total: '£1,284,567' },
      unverified: [],
      citations: [
        {
          quote: '£1,284,567',
          page: 4,
          bbox: [0, 0, 1, 1],
          chunkId: 'chk_1',
          schemaPath: 'result.total',
        },
      ],
    });
    expect(parsed.success).toBe(true);
  });
});

describe('POST /v2/split', () => {
  it('accepts exactly the documented request fields', () => {
    expect(keysOf(SplitRequestSchema)).toEqual(
      [
        'docId',
        'lang_list',
        'level',
        'llm',
        'mode',
        'quality',
        'ranges',
        'url',
        'webhook_url',
      ].sort(),
    );
  });

  it('returns exactly the documented response fields', () => {
    expect(keysOf(SplitResponseSchema)).toEqual(['docId', 'documents'].sort());
  });

  it('accepts upstream`s string ranges and our object form', () => {
    expect(SplitRequestSchema.safeParse({ docId: 'd', ranges: ['1-4', '7'] }).success).toBe(true);
    expect(
      SplitRequestSchema.safeParse({ docId: 'd', ranges: [{ start: 1, end: 4, name: 'a.pdf' }] })
        .success,
    ).toBe(true);
  });

  it('refuses a range that is not a page number or a pair of them', () => {
    expect(SplitRequestSchema.safeParse({ docId: 'd', ranges: ['one to four'] }).success).toBe(
      false,
    );
    expect(SplitRequestSchema.safeParse({ docId: 'd', ranges: ['1-'] }).success).toBe(false);
  });

  it('describes each output with a docId, a name and its parent pages', () => {
    const parsed = SplitResponseSchema.safeParse({
      docId: 'doc_parent',
      documents: [{ docId: 'doc_child', name: 'methods.pdf', pages: [3, 4, 5] }],
    });
    expect(parsed.success).toBe(true);
  });
});

describe('POST /v2/ask', () => {
  it('accepts exactly the documented request fields', () => {
    expect(keysOf(AskRequestSchema)).toEqual(
      [
        'corpus',
        'docId',
        'lang_list',
        'language',
        'llm',
        'quality',
        'question',
        'url',
        'webhook_url',
      ].sort(),
    );
  });

  it('returns exactly the documented response fields', () => {
    expect(keysOf(AskResponseSchema)).toEqual(['answer', 'citations', 'docId'].sort());
  });

  it('requires a question', () => {
    expect(AskRequestSchema.safeParse({ docId: 'd' }).success).toBe(false);
    expect(AskRequestSchema.safeParse({ docId: 'd', question: 'What is the total?' }).success).toBe(
      true,
    );
  });
});

describe('the legacy /v1 surface', () => {
  it('returns content and references, in upstream`s names', () => {
    expect(keysOf(ChatWithPdfResponseSchema)).toEqual(['content', 'references'].sort());
  });

  it('accepts question or upstream`s older prompt', () => {
    expect(ChatWithPdfRequestSchema.safeParse({ docId: 'd', question: 'q' }).success).toBe(true);
    expect(ChatWithPdfRequestSchema.safeParse({ docId: 'd', prompt: 'q' }).success).toBe(true);
  });

  it('takes docIds on the corpus variant', () => {
    expect(keysOf(ChatWithAllPdfsRequestSchema)).toContain('docIds');
  });

  it('keeps page on every reference, and adds without replacing', () => {
    const parsed = ChatWithPdfResponseSchema.safeParse({
      content: 'The total is £1,284,567.',
      references: [{ page: 4, quote: '£1,284,567', docId: 'doc_1', bbox: [10, 20, 300, 40] }],
    });
    expect(parsed.success).toBe(true);

    // The additive fields are additive: a client reading only `page` must see
    // the upstream shape it expects underneath ours.
    const reference = parsed.success ? parsed.data.references[0] : undefined;
    expect(reference?.page).toBe(4);
    expect(typeof reference?.page).toBe('number');
  });
});

describe('the documented shapes, against the document itself', () => {
  it('names every response field that docs/api-compatibility.md tabulates', async () => {
    const { readFile } = await import('node:fs/promises');
    const { fileURLToPath } = await import('node:url');
    const document = await readFile(
      fileURLToPath(new URL('../../../../docs/api-compatibility.md', import.meta.url)),
      'utf8',
    );

    // Not a parse of the tables — a check that every field the schemas promise
    // is at least mentioned in the file a migrating developer reads. A field
    // added to a response and not documented is a field nobody knows about.
    const promised = [
      ...keysOf(ParseResponseSchema),
      ...keysOf(ExtractResponseSchema),
      ...keysOf(SplitResponseSchema),
      ...keysOf(AskResponseSchema),
      ...keysOf(ChatWithPdfResponseSchema),
    ];

    for (const field of new Set(promised)) {
      expect(document, `docs/api-compatibility.md never mentions \`${field}\``).toContain(
        `\`${field}\``,
      );
    }
  });
});
