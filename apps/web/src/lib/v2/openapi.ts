import { API_ERROR_STATUS, type ApiErrorCode, ApiErrorSchema } from '@konusbitr/shared';
import { z } from 'zod';
import { API_SCOPES } from '@/lib/auth/scopes';
import type { RouteDefinition } from './registry';
import { UNIVERSAL_ERROR_CODES } from './registry';

/**
 * The OpenAPI 3.1 document, generated from the very schemas the routes validate
 * with.
 *
 * Not hand-written, and not generated from a second description of the API that
 * happens to sit next to it: `openapiDocument()` walks the same
 * `RouteDefinition` objects `mount.ts` turns into handlers, and converts their
 * Zod schemas with Zod's own `z.toJSONSchema`. The `draft-2020-12` target *is*
 * the dialect OpenAPI 3.1 uses, so no translation layer sits in between to have
 * its own opinions.
 *
 * That is what makes the phase's "CI fails if the spec drifts from the code"
 * criterion mean something. `test/v2/openapi.test.ts` regenerates the document
 * and compares it to the committed copy; a route whose schema changed and whose
 * spec did not cannot be merged.
 */

const OPENAPI_VERSION = '3.1.0';

type JsonSchema = Record<string, unknown>;

/**
 * Convert one Zod schema, hoisting its `$defs` into `components/schemas`.
 *
 * Zod emits shared subschemas as local `$defs` with `#/$defs/X` references,
 * which OpenAPI 3.1 permits — it is full JSON Schema 2020-12 — but which most
 * generators handle poorly and no SDK generator names usefully. Hoisting gives
 * every shared type one named component, which is what both SDKs are generated
 * from.
 */
function convert(
  schema: z.ZodType,
  io: 'input' | 'output',
  components: Record<string, JsonSchema>,
): JsonSchema {
  const converted = z.toJSONSchema(schema, {
    io,
    target: 'draft-2020-12',
    // A cycle or an unrepresentable type becomes `{}` rather than throwing. The
    // alternative is a build that fails because one field is hard to describe,
    // which trades a complete document for no document at all.
    unrepresentable: 'any',
  }) as JsonSchema & { $defs?: Record<string, JsonSchema>; $schema?: string };

  const { $defs, $schema, ...body } = converted;

  for (const [name, definition] of Object.entries($defs ?? {})) {
    components[name] = rewriteRefs(definition) as JsonSchema;
  }

  return rewriteRefs(body) as JsonSchema;
}

/** `#/$defs/X` → `#/components/schemas/X`, everywhere it appears. */
function rewriteRefs(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(rewriteRefs);
  if (typeof node !== 'object' || node === null) return node;

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === '$ref' && typeof value === 'string' && value.startsWith('#/$defs/')) {
      out.$ref = `#/components/schemas/${value.slice('#/$defs/'.length)}`;
      continue;
    }
    out[key] = rewriteRefs(value);
  }
  return out;
}

/** Hono's `/documents/:docId` → OpenAPI's `/documents/{docId}`. */
function templatePath(path: string): string {
  return path.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
}

/**
 * One response entry per documented failure code.
 *
 * Grouped by status, because several codes share one — `input_conflict` and
 * `invalid_schema` are both 400 — and OpenAPI keys responses by status. The
 * codes that share a status are listed in the description, so a reader can see
 * every code a call can return without reading the source.
 */
function errorResponses(
  definition: RouteDefinition,
  errorRef: JsonSchema,
): Record<string, JsonSchema> {
  const codes = [...new Set<ApiErrorCode>([...definition.errors, ...UNIVERSAL_ERROR_CODES])];
  const byStatus = new Map<number, ApiErrorCode[]>();

  for (const code of codes) {
    const status = API_ERROR_STATUS[code];
    const existing = byStatus.get(status);
    if (existing) existing.push(code);
    else byStatus.set(status, [code]);
  }

  const responses: Record<string, JsonSchema> = {};
  for (const [status, statusCodes] of [...byStatus].sort((a, b) => a[0] - b[0])) {
    responses[String(status)] = {
      description: `\`error.code\` is one of: ${statusCodes.sort().join(', ')}.`,
      content: { 'application/json': { schema: errorRef } },
    };
  }
  return responses;
}

function requestBody(
  definition: RouteDefinition,
  components: Record<string, JsonSchema>,
): JsonSchema | undefined {
  if (!definition.request || definition.body === 'none') return undefined;

  const json = convert(definition.request, 'input', components);
  const content: Record<string, JsonSchema> = { 'application/json': { schema: json } };

  if (definition.body === 'json-or-multipart') {
    // The multipart variant is the JSON one plus the binary part that cannot
    // travel in JSON, which is the only reason the variant exists. Composed
    // with `allOf` rather than by merging `properties` into the reference: the
    // JSON schema is a `$ref` by now, and while a sibling keyword beside a
    // `$ref` is legal in 2020-12, enough generators mishandle it that a
    // published document should not rely on it.
    content['multipart/form-data'] = {
      schema: {
        allOf: [
          json,
          {
            type: 'object',
            properties: {
              file: {
                type: 'string',
                format: 'binary',
                description: 'The document itself. Mutually exclusive with `url` and `docId`.',
              },
            },
          },
        ],
      },
    };
  }

  return { required: true, content };
}

export function openapiDocument(
  routes: readonly { definition: RouteDefinition }[],
  options: { version: string; serverUrl: string },
): Record<string, unknown> {
  const components: Record<string, JsonSchema> = {};
  components.ApiError = convert(ApiErrorSchema, 'output', components);
  const errorRef: JsonSchema = { $ref: '#/components/schemas/ApiError' };

  const paths: Record<string, Record<string, unknown>> = {};

  for (const { definition } of routes) {
    const path = templatePath(definition.path);
    const operation: Record<string, unknown> = {
      operationId: definition.operationId,
      summary: definition.summary,
      description: definition.description,
      tags: [definition.path.startsWith('/chat-with') ? 'legacy' : 'v2'],
      security: [{ apiKey: [] }],
      parameters: [
        ...(definition.params ?? []).map((param) => ({
          name: param.name,
          in: 'path',
          required: true,
          description: param.description,
          schema: { type: 'string' },
        })),
        ...(definition.async
          ? [
              {
                name: 'async',
                in: 'query',
                required: false,
                description:
                  'Return `202 { jobId }` immediately instead of waiting. Poll `GET /v2/jobs/{jobId}`, or give a `webhook_url` to be called on completion.',
                schema: { type: 'boolean' },
              },
            ]
          : []),
      ],
      responses: {
        [String(definition.status ?? 200)]: {
          description: definition.summary,
          content: {
            'application/json': { schema: convert(definition.response, 'output', components) },
          },
        },
        ...(definition.async
          ? {
              '202': {
                description: 'Accepted for asynchronous processing.',
                content: {
                  'application/json': {
                    schema: {
                      type: 'object',
                      required: ['jobId', 'status', 'kind', 'docId'],
                      properties: {
                        jobId: { type: 'string' },
                        status: { type: 'string' },
                        kind: { type: 'string' },
                        docId: { type: ['string', 'null'] },
                      },
                    },
                  },
                },
              },
            }
          : {}),
        ...errorResponses(definition, errorRef),
      },
    };

    const body = requestBody(definition, components);
    if (body) operation.requestBody = body;

    paths[path] = { ...(paths[path] ?? {}), [definition.method]: operation };
  }

  return {
    openapi: OPENAPI_VERSION,
    info: {
      title: 'Konusbitr API',
      version: options.version,
      description: [
        'Parse, extract from, split and ask questions about documents, with',
        'page-accurate citations that are verified against the source before',
        'they are returned.',
        '',
        'Wire-compatible with `api.pdf.ai/v2`: an existing integration can be',
        'repointed by changing the base URL. Every long-running endpoint also',
        'accepts `?async=true`, which upstream does not.',
        '',
        'Authenticate with an API key in the `X-API-Key` header. Keys are issued',
        'per organization and carry scopes; an endpoint names the scope it needs.',
      ].join('\n'),
      license: { name: 'Apache-2.0', identifier: 'Apache-2.0' },
    },
    servers: [{ url: options.serverUrl }],
    tags: [
      { name: 'v2', description: 'The current API.' },
      { name: 'legacy', description: 'PDF.ai-compatible v1 endpoints. Prefer the v2 equivalents.' },
    ],
    paths,
    components: {
      schemas: Object.fromEntries(
        Object.entries(components).sort(([a], [b]) => a.localeCompare(b)),
      ),
      securitySchemes: {
        apiKey: {
          type: 'apiKey',
          in: 'header',
          name: 'X-API-Key',
          description: `Scopes: ${API_SCOPES.join(', ')}.`,
        },
      },
    },
    security: [{ apiKey: [] }],
  };
}
