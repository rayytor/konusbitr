import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { API_ERROR_STATUS, type ApiErrorCode } from '@konusbitr/shared';
import { describe, expect, it } from 'vitest';
import { ALL_ROUTES, specFor } from '@/lib/v2/app';

/**
 * The specification, and the reason it cannot drift.
 *
 * The phase's criterion is that CI fails when the document disagrees with the
 * code. This is how: the document is *generated* from the same route
 * declarations the handlers are mounted from, and the committed copy is
 * regenerated here and compared. A route whose schema changed and whose spec
 * was not re-emitted turns this red, and `pnpm openapi:emit` is the fix.
 */

const COMMITTED = fileURLToPath(new URL('../../../../docs/openapi.json', import.meta.url));

/** The placeholder origin `scripts/emit-openapi.ts` writes with. */
const PLACEHOLDER_SERVER = 'https://konusbitr.example.com';

const document = specFor(PLACEHOLDER_SERVER) as {
  openapi: string;
  info: Record<string, unknown>;
  paths: Record<string, Record<string, Record<string, unknown>>>;
  components: { schemas: Record<string, unknown>; securitySchemes: Record<string, unknown> };
};

describe('the generated OpenAPI document', () => {
  it('declares OpenAPI 3.1', () => {
    expect(document.openapi).toBe('3.1.0');
  });

  it('matches the committed docs/openapi.json byte for byte', async () => {
    const committed = await readFile(COMMITTED, 'utf8');
    expect(`${JSON.stringify(document, null, 2)}\n`).toBe(committed);
  });

  it('describes every mounted route and nothing else', () => {
    const described = new Set<string>();
    for (const [path, operations] of Object.entries(document.paths)) {
      for (const method of Object.keys(operations)) described.add(`${method} ${path}`);
    }

    const mounted = new Set(
      ALL_ROUTES.map(
        ({ definition }) =>
          `${definition.method} ${definition.path.replace(/:([A-Za-z0-9_]+)/g, '{$1}')}`,
      ),
    );

    expect([...described].sort()).toEqual([...mounted].sort());
  });

  it('covers all four v2 endpoints and both legacy ones', () => {
    expect(Object.keys(document.paths).sort()).toEqual(
      [
        '/ask',
        '/chat-with-all-pdfs',
        '/chat-with-pdf',
        '/documents/{docId}',
        '/extract',
        '/jobs/{jobId}',
        '/parse',
        '/split',
      ].sort(),
    );
  });

  it('gives every operation an id, a summary and a description', () => {
    for (const operations of Object.values(document.paths)) {
      for (const operation of Object.values(operations)) {
        expect(operation.operationId).toBeTypeOf('string');
        expect(String(operation.summary).length).toBeGreaterThan(10);
        expect(String(operation.description).length).toBeGreaterThan(40);
      }
    }
  });

  it('resolves every $ref against components/schemas', () => {
    const refs: string[] = [];
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) return void node.forEach(walk);
      if (typeof node !== 'object' || node === null) return;
      for (const [key, value] of Object.entries(node)) {
        if (key === '$ref' && typeof value === 'string') refs.push(value);
        else walk(value);
      }
    };
    walk(document.paths);

    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) {
      expect(ref.startsWith('#/components/schemas/')).toBe(true);
      const name = ref.slice('#/components/schemas/'.length);
      expect(document.components.schemas, `${ref} is dangling`).toHaveProperty(name);
    }
  });

  it('documents every declared error code at its declared status', () => {
    for (const { definition } of ALL_ROUTES) {
      const path = definition.path.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
      const operation = document.paths[path]?.[definition.method] as {
        responses: Record<string, { description: string }>;
      };

      for (const code of definition.errors as readonly ApiErrorCode[]) {
        const status = String(API_ERROR_STATUS[code]);
        expect(
          operation.responses[status],
          `${definition.operationId} does not document ${status} for ${code}`,
        ).toBeDefined();
        expect(operation.responses[status]?.description).toContain(code);
      }
    }
  });

  it('documents the universal failures on every operation', () => {
    for (const operations of Object.values(document.paths)) {
      for (const operation of Object.values(operations)) {
        const responses = operation.responses as Record<string, unknown>;
        expect(responses['401']).toBeDefined();
        expect(responses['403']).toBeDefined();
        expect(responses['429']).toBeDefined();
        expect(responses['500']).toBeDefined();
      }
    }
  });

  it('lists ?async=true on exactly the long-running endpoints', () => {
    const asyncPaths: string[] = [];
    for (const [path, operations] of Object.entries(document.paths)) {
      for (const operation of Object.values(operations)) {
        const parameters = (operation.parameters ?? []) as { name: string }[];
        if (parameters.some((parameter) => parameter.name === 'async')) asyncPaths.push(path);
      }
    }
    expect(asyncPaths.sort()).toEqual(['/ask', '/extract', '/parse', '/split']);
  });

  it('gives every async endpoint a 202 response', () => {
    for (const path of ['/parse', '/extract', '/split', '/ask']) {
      expect(document.paths[path]?.post?.responses).toHaveProperty('202');
    }
  });

  it('accepts multipart only where a file can be uploaded', () => {
    const multipart: string[] = [];
    for (const [path, operations] of Object.entries(document.paths)) {
      for (const operation of Object.values(operations)) {
        const body = operation.requestBody as { content?: Record<string, unknown> } | undefined;
        if (body?.content && 'multipart/form-data' in body.content) multipart.push(path);
      }
    }
    expect(multipart.sort()).toEqual(['/ask', '/extract', '/parse', '/split']);
  });

  it('declares the X-API-Key security scheme and applies it to every operation', () => {
    expect(document.components.securitySchemes.apiKey).toMatchObject({
      type: 'apiKey',
      in: 'header',
      name: 'X-API-Key',
    });

    for (const operations of Object.values(document.paths)) {
      for (const operation of Object.values(operations)) {
        expect(operation.security).toEqual([{ apiKey: [] }]);
      }
    }
  });
});

describe('OpenAPI 3.1 structural validity', () => {
  /**
   * A structural check rather than a full meta-schema validation.
   *
   * Pulling a JSON Schema validator and the OpenAPI 3.1 meta-schema into the
   * unit suite to assert things a generated document cannot get wrong — it is
   * emitted by one function from typed inputs — would be buying a dependency to
   * test the dependency. What is checked here is what generation *can* get
   * wrong: a missing required key, a dangling reference, an operation with no
   * responses.
   */
  it('has the required top-level members', () => {
    expect(document).toHaveProperty('openapi');
    expect(document).toHaveProperty('info.title');
    expect(document).toHaveProperty('info.version');
    expect(document).toHaveProperty('paths');
  });

  it('gives every operation at least one response', () => {
    for (const operations of Object.values(document.paths)) {
      for (const operation of Object.values(operations)) {
        expect(Object.keys(operation.responses as object).length).toBeGreaterThan(0);
      }
    }
  });

  it('uses only valid HTTP status keys', () => {
    for (const operations of Object.values(document.paths)) {
      for (const operation of Object.values(operations)) {
        for (const status of Object.keys(operation.responses as object)) {
          expect(status).toMatch(/^[1-5]\d{2}$/);
        }
      }
    }
  });

  it('templates path parameters and declares each one', () => {
    for (const [path, operations] of Object.entries(document.paths)) {
      const templated = [...path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]);
      for (const operation of Object.values(operations)) {
        const declared = ((operation.parameters ?? []) as { name: string; in: string }[])
          .filter((parameter) => parameter.in === 'path')
          .map((parameter) => parameter.name);
        expect(declared.sort()).toEqual([...templated].sort());
      }
      // Hono-style `:param` must never survive into the document.
      expect(path).not.toContain(':');
    }
  });
});
