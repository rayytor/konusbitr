/**
 * Generate the TypeScript SDK from `docs/openapi.json`.
 *
 * Two files come out of this and neither may be hand-edited: `src/generated/
 * types.ts`, the request and response shapes, and `src/generated/operations.ts`,
 * one entry per operation naming its method, path, body mode and types. The
 * hand-written half is `src/client.ts`, which is the *runtime* — retries, typed
 * errors, polling an async job — and is deliberately not generated, because
 * none of that is described by an OpenAPI document and a generator's idea of it
 * would be worse than one written on purpose.
 *
 * `pnpm --filter @konusbitr/sdk generate` regenerates; `generate:check`
 * regenerates and diffs, which CI runs. So the chain is: Zod schema → route
 * declaration → OpenAPI document → SDK, with a drift check at each seam.
 *
 * Usage: `tsx scripts/generate.ts [path-to-openapi.json]`
 */

import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// biome-ignore lint/suspicious/noExplicitAny: walks arbitrary JSON Schema
type JsonSchema = Record<string, any>;

const SPEC = resolve(
  process.argv[2] ?? fileURLToPath(new URL('../../../docs/openapi.json', import.meta.url)),
);
const OUT = fileURLToPath(new URL('../src/generated', import.meta.url));

const document = JSON.parse(readFileSync(SPEC, 'utf8')) as {
  info: { version: string };
  paths: Record<string, Record<string, JsonSchema>>;
  components: { schemas: Record<string, JsonSchema> };
};

const BANNER = `/**
 * Generated from the API's OpenAPI document by \`scripts/generate.ts\`.
 * **Do not edit.** Run \`pnpm --filter @konusbitr/sdk generate\` instead; CI
 * regenerates this file and fails on any diff.
 */
`;

// ── JSON Schema → TypeScript ────────────────────────────────────────────────

/** A schema name as a TypeScript identifier. Names in the document are already valid. */
function typeName(name: string): string {
  return name.replace(/[^A-Za-z0-9_]/g, '');
}

function refName(ref: string): string {
  return typeName(ref.slice(ref.lastIndexOf('/') + 1));
}

/**
 * Render one schema as a type expression.
 *
 * Deliberately narrow: it covers what Zod emits through `z.toJSONSchema` and
 * nothing more. A keyword this does not understand becomes `unknown`, which is
 * honest — a client that has to cast is being told the SDK does not know the
 * shape, rather than being handed a confident wrong one.
 */
function render(schema: JsonSchema | undefined, indent: string): string {
  if (!schema || Object.keys(schema).length === 0) return 'unknown';
  if (schema.$ref) return refName(schema.$ref);

  if (Array.isArray(schema.anyOf)) {
    return schema.anyOf.map((branch: JsonSchema) => render(branch, indent)).join(' | ');
  }
  if (Array.isArray(schema.allOf)) {
    return schema.allOf.map((branch: JsonSchema) => render(branch, indent)).join(' & ');
  }
  if (Array.isArray(schema.enum)) {
    return schema.enum.map((value: unknown) => JSON.stringify(value)).join(' | ');
  }
  if (schema.const !== undefined) return JSON.stringify(schema.const);

  // `type` may be a list, which is how 2020-12 spells nullability.
  const types: string[] = Array.isArray(schema.type)
    ? schema.type
    : schema.type
      ? [schema.type]
      : [];

  if (types.length > 1) {
    return types.map((type: string) => render({ ...schema, type }, indent)).join(' | ');
  }

  switch (types[0]) {
    case 'string':
      return 'string';
    case 'integer':
    case 'number':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'null':
      return 'null';
    case 'array': {
      // A tuple, which is how a fixed-length array such as a bounding box is
      // described. Rendering it as `number[]` would lose the arity a caller
      // destructures on.
      if (Array.isArray(schema.prefixItems)) {
        const items = schema.prefixItems.map((item: JsonSchema) => render(item, indent));
        return `[${items.join(', ')}]`;
      }
      return `Array<${render(schema.items, indent)}>`;
    }
    case 'object':
      return renderObject(schema, indent);
    default:
      return schema.properties ? renderObject(schema, indent) : 'unknown';
  }
}

function renderObject(schema: JsonSchema, indent: string): string {
  const properties = schema.properties as Record<string, JsonSchema> | undefined;
  if (!properties || Object.keys(properties).length === 0) {
    const additional = schema.additionalProperties;
    if (additional && additional !== true) {
      return `Record<string, ${render(additional, indent)}>`;
    }
    return additional === false ? 'Record<string, never>' : 'Record<string, unknown>';
  }

  const required = new Set<string>(schema.required ?? []);
  const inner = `${indent}  `;

  const lines = Object.entries(properties).map(([key, value]) => {
    const optional = required.has(key) ? '' : '?';
    const comment = value.description
      ? `${inner}/** ${String(value.description).replace(/\s+/g, ' ').trim()} */\n`
      : '';
    return `${comment}${inner}${propertyKey(key)}${optional}: ${render(value, inner)};`;
  });

  return `{\n${lines.join('\n')}\n${indent}}`;
}

/** `lang_list` needs no quotes; anything with a dash would. */
function propertyKey(key: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? key : JSON.stringify(key);
}

// ── Emit the types ──────────────────────────────────────────────────────────

function emitTypes(): string {
  const parts = [BANNER];

  for (const [name, schema] of Object.entries(document.components.schemas)) {
    const description = schema.description
      ? `/**\n * ${String(schema.description).replace(/\n/g, '\n * ')}\n */\n`
      : '';
    parts.push(`${description}export type ${typeName(name)} = ${render(schema, '')};\n`);
  }

  return parts.join('\n');
}

// ── Emit the operations ─────────────────────────────────────────────────────

type Operation = {
  id: string;
  method: string;
  path: string;
  summary: string;
  description: string;
  body: 'json' | 'json-or-multipart' | 'none';
  requestType: string;
  responseType: string;
  status: number;
  params: string[];
  async: boolean;
};

function operations(): Operation[] {
  const found: Operation[] = [];

  for (const [path, methods] of Object.entries(document.paths)) {
    for (const [method, operation] of Object.entries(methods)) {
      const responses = operation.responses as Record<string, JsonSchema>;
      const successStatus = Object.keys(responses)
        .filter((status) => status.startsWith('2') && status !== '202')
        .sort()[0];

      const success = successStatus ? responses[successStatus] : undefined;
      const content = operation.requestBody?.content ?? {};

      found.push({
        id: operation.operationId,
        method,
        path,
        summary: operation.summary ?? '',
        description: operation.description ?? '',
        body:
          Object.keys(content).length === 0
            ? 'none'
            : 'multipart/form-data' in content
              ? 'json-or-multipart'
              : 'json',
        requestType: render(content['application/json']?.schema, ''),
        responseType: render(success?.content?.['application/json']?.schema, ''),
        status: Number(successStatus ?? 200),
        params: [...path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1] as string),
        async: ((operation.parameters ?? []) as { name: string }[]).some(
          (parameter) => parameter.name === 'async',
        ),
      });
    }
  }

  return found.sort((a, b) => a.id.localeCompare(b.id));
}

function emitOperations(found: Operation[]): string {
  const imported = [
    ...new Set(
      found.flatMap((operation) =>
        [operation.requestType, operation.responseType].filter((type) =>
          /^[A-Z][A-Za-z0-9_]*$/.test(type),
        ),
      ),
    ),
  ].sort();

  const entries = found.map((operation) => {
    const doc = [
      '/**',
      ` * ${operation.summary}`,
      ' *',
      ...operation.description.split('\n').map((line) => ` * ${line}`.trimEnd()),
      ' */',
    ].join('\n');

    return `${doc}
export const ${operation.id} = {
  method: ${JSON.stringify(operation.method.toUpperCase())},
  path: ${JSON.stringify(operation.path)},
  params: ${JSON.stringify(operation.params)},
  body: ${JSON.stringify(operation.body)},
  status: ${operation.status},
  async: ${operation.async},
} as const;

export type ${capitalize(operation.id)}Body = ${operation.requestType};
export type ${capitalize(operation.id)}Result = ${operation.responseType};`;
  });

  return [
    BANNER,
    imported.length > 0 ? `import type { ${imported.join(', ')} } from './types.js';\n` : '',
    `/** The API version this SDK was generated from. */\nexport const API_VERSION = ${JSON.stringify(document.info.version)};\n`,
    entries.join('\n\n'),
    '',
  ].join('\n');
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

// ── Write ───────────────────────────────────────────────────────────────────

await mkdir(OUT, { recursive: true });
await writeFile(resolve(OUT, 'types.ts'), emitTypes(), 'utf8');
await writeFile(resolve(OUT, 'operations.ts'), emitOperations(operations()), 'utf8');

// biome-ignore lint/suspicious/noConsole: CLI output
console.log(`sdk: wrote ${OUT}/types.ts and ${OUT}/operations.ts`);
void dirname;
