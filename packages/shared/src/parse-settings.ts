import { z } from 'zod';

/**
 * Parser tier.
 *
 * `standard` is the cleanly Apache-2.0-licensed default path. `advanced` opts
 * into the restrictively-licensed extras that ship only behind the Compose
 * `advanced` profile.
 */
export const ParseQualitySchema = z.enum(['standard', 'advanced']);

export type ParseQuality = z.infer<typeof ParseQualitySchema>;

/**
 * Everything that can change the bytes of a parse result.
 *
 * This object is hashed (canonical JSON, `langList` sorted) into the
 * `settings_hash` half of the docId cache key, so nothing may be added here
 * that does not actually affect parser output.
 */
export const ParseSettingsSchema = z.object({
  quality: ParseQualitySchema.default('standard'),
  /** BCP-47-ish OCR language hints. Order is not significant. */
  langList: z.array(z.string().min(1)).default([]),
  /** Whether a vision/LLM pass may be used to enrich the parse. */
  llm: z.boolean().default(false),
});

export type ParseSettings = z.infer<typeof ParseSettingsSchema>;

export const DEFAULT_PARSE_SETTINGS: ParseSettings = Object.freeze({
  quality: 'standard',
  langList: [],
  llm: false,
});

/**
 * Canonical form used for hashing: `langList` sorted and de-duplicated so that
 * two requests differing only in language order share one cache entry.
 */
export function canonicalizeParseSettings(settings: ParseSettings): ParseSettings {
  return {
    quality: settings.quality,
    langList: [...new Set(settings.langList)].sort(),
    llm: settings.llm,
  };
}

/**
 * The exact string that gets hashed into `settings_hash`.
 *
 * Half of the docId cache key is `sha256` of this, so its bytes are a contract:
 * every runtime that computes a settings hash — the TypeScript intake path
 * today, the Python worker when it verifies one — must produce this string
 * character for character. Hence the explicit key order and the absence of any
 * whitespace, rather than a `JSON.stringify` of whatever shape happened to be
 * in hand.
 *
 * The hashing itself lives with the code that has a crypto implementation;
 * this package stays free of Node built-ins so it can be imported anywhere.
 */
export function parseSettingsHashInput(settings: ParseSettings): string {
  const canonical = canonicalizeParseSettings(settings);
  // Keys in lexicographic order, which is what "canonical JSON" means here and
  // what a Python `json.dumps(..., sort_keys=True, separators=(",", ":"))`
  // produces for the same object.
  return JSON.stringify({
    langList: canonical.langList,
    llm: canonical.llm,
    quality: canonical.quality,
  });
}
