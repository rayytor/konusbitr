import { EXTRACT_SCHEMA_LIMITS } from '@konusbitr/shared';
import { ApiError } from '../errors';

/**
 * Validating a JSON Schema somebody else wrote.
 *
 * This is the one place on the surface where a caller hands us a *structure*
 * rather than a value, and the structure decides how much work the request
 * makes: one retrieval per top-level field, one generation over a prompt whose
 * size is the schema's size. So the limits here are a cost ceiling with a
 * validation shape, not a tidiness rule — an unbounded schema is an unbounded
 * bill, and a deeply recursive one is a stack overflow in whatever walks it.
 *
 * What is deliberately *not* here is full JSON Schema validation. We do not
 * check that `pattern` is a valid regex or that `$ref` resolves, because we
 * never execute the schema: it is shown to a model as a description of the
 * shape to produce, and the result is then checked structurally against it. A
 * schema keyword we do not understand is a keyword the model may or may not
 * honour, which is a quality question and not a safety one.
 */

export type SchemaSummary = {
  /** Top-level properties. This is what the decomposition fans out over. */
  topLevelFields: string[];
  /** Leaf values across the whole schema, arrays counted once. */
  leafCount: number;
  depth: number;
};

type JsonSchema = Record<string, unknown>;

function isObject(value: unknown): value is JsonSchema {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Walk the schema, counting as we go and refusing anything past a ceiling.
 *
 * Refusing *during* the walk rather than after it is the point: a schema
 * nested ten thousand deep must be stopped at level seven, not counted to
 * completion and then reported on.
 */
function walk(node: unknown, depth: number, state: { leaves: number; maxDepth: number }): void {
  if (depth > EXTRACT_SCHEMA_LIMITS.maxDepth) {
    throw new ApiError(
      'invalid_schema',
      `The schema nests deeper than ${EXTRACT_SCHEMA_LIMITS.maxDepth} levels.`,
      { maxDepth: EXTRACT_SCHEMA_LIMITS.maxDepth },
    );
  }
  state.maxDepth = Math.max(state.maxDepth, depth);

  if (!isObject(node)) return;

  // A composed schema — `anyOf`, `oneOf`, `allOf` — is walked through every
  // branch, because each branch is a shape the model could be asked to produce.
  for (const key of ['anyOf', 'oneOf', 'allOf'] as const) {
    const branches = node[key];
    if (Array.isArray(branches)) {
      for (const branch of branches) walk(branch, depth, state);
    }
  }

  const type = node.type;

  if (type === 'object' || isObject(node.properties)) {
    const properties = isObject(node.properties) ? node.properties : {};
    for (const child of Object.values(properties)) walk(child, depth + 1, state);
    return;
  }

  if (type === 'array' || node.items !== undefined) {
    // An array counts as one leaf-bearing branch however many items it holds:
    // the schema describes the element, and the document decides the count.
    if (node.items !== undefined) walk(node.items, depth + 1, state);
    else state.leaves += 1;
    return;
  }

  state.leaves += 1;

  if (state.leaves > EXTRACT_SCHEMA_LIMITS.maxFields) {
    throw new ApiError(
      'invalid_schema',
      `The schema describes more than ${EXTRACT_SCHEMA_LIMITS.maxFields} values.`,
      { maxFields: EXTRACT_SCHEMA_LIMITS.maxFields },
    );
  }
}

export function validateExtractionSchema(schema: unknown): SchemaSummary {
  if (!isObject(schema)) {
    throw new ApiError('invalid_schema', 'The schema must be a JSON Schema object.');
  }

  const serialized = JSON.stringify(schema);
  if (serialized.length > EXTRACT_SCHEMA_LIMITS.maxBytes) {
    throw new ApiError(
      'invalid_schema',
      `The schema is larger than ${EXTRACT_SCHEMA_LIMITS.maxBytes} bytes.`,
      { maxBytes: EXTRACT_SCHEMA_LIMITS.maxBytes },
    );
  }

  const properties = isObject(schema.properties) ? schema.properties : null;
  if (!properties || Object.keys(properties).length === 0) {
    throw new ApiError(
      'invalid_schema',
      'The schema must be an object schema with at least one property.',
    );
  }

  const topLevelFields = Object.keys(properties);
  if (topLevelFields.length > EXTRACT_SCHEMA_LIMITS.maxTopLevelFields) {
    throw new ApiError(
      'invalid_schema',
      `The schema has more than ${EXTRACT_SCHEMA_LIMITS.maxTopLevelFields} top-level fields.`,
      { maxTopLevelFields: EXTRACT_SCHEMA_LIMITS.maxTopLevelFields },
    );
  }

  const state = { leaves: 0, maxDepth: 1 };
  walk(schema, 1, state);

  return { topLevelFields, leafCount: state.leaves, depth: state.maxDepth };
}

/**
 * What to search for when retrieving evidence for one top-level field.
 *
 * The field's own name, de-camel-cased, plus whatever its schema says about
 * itself. `invoiceTotal` alone is a poor query and `{ "description": "The
 * total amount due including tax" }` is a good one, so the description is used
 * when the caller wrote one — which is the cheapest way for a caller to improve
 * their own extraction quality, and worth saying in the docs.
 */
export function fieldQuery(name: string, node: unknown): string {
  const readable = name
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .trim();

  if (!isObject(node)) return readable;

  const parts = [readable];
  if (typeof node.title === 'string') parts.push(node.title);
  if (typeof node.description === 'string') parts.push(node.description);
  if (Array.isArray(node.enum)) parts.push(node.enum.slice(0, 10).map(String).join(' '));

  // An array of objects describes its element, and the element's property names
  // are usually the words that appear in the document — `people: [{ name, role
  // }]` should search for names and roles, not for the word "people".
  const items = isObject(node.items) ? node.items : null;
  const properties = isObject(node.properties)
    ? node.properties
    : items && isObject(items.properties)
      ? items.properties
      : null;
  if (properties) parts.push(Object.keys(properties).join(' '));

  return parts.join(' ').slice(0, 500);
}
