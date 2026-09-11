/**
 * `@konusbitr/shared` — the single source of truth for every type that crosses a
 * boundary: web ↔ API, API ↔ Python worker, and the generated SDK.
 *
 * Schemas here are Zod v4. The Python worker's pydantic models are generated
 * from them, so a change in this package is a change to the cross-language
 * contract.
 */

export {
  type BoundingBox,
  BoundingBoxSchema,
  type Citation,
  CitationSchema,
} from './citation.js';

export {
  DOCUMENT_STATUSES,
  type DocumentStatus,
  DocumentStatusSchema,
  isTerminalDocumentStatus,
  TERMINAL_DOCUMENT_STATUSES,
} from './document.js';
export {
  CREDITS_MODES,
  type Env,
  EnvSchema,
  EnvValidationError,
  LLM_PROVIDERS,
  loadEnv,
  NODE_ENVS,
  parseEnv,
  resetEnvCache,
} from './env.js';
export {
  JOB_STAGES,
  type JobProgress,
  JobProgressSchema,
  type JobStage,
  JobStageSchema,
} from './job.js';
export {
  canonicalizeParseSettings,
  DEFAULT_PARSE_SETTINGS,
  type ParseQuality,
  ParseQualitySchema,
  type ParseSettings,
  ParseSettingsSchema,
} from './parse-settings.js';
