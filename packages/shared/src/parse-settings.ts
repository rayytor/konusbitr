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
