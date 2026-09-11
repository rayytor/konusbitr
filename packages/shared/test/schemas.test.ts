import { describe, expect, it } from 'vitest';
import {
  CitationSchema,
  canonicalizeParseSettings,
  DEFAULT_PARSE_SETTINGS,
  DocumentStatusSchema,
  isTerminalDocumentStatus,
  JobProgressSchema,
  ParseSettingsSchema,
} from '../src/index.js';

describe('CitationSchema', () => {
  const valid = {
    quote: 'the rate was 4.25%',
    page: 7,
    bbox: [72, 108.5, 523.2, 124] as [number, number, number, number],
    chunkId: 'chk_01JB0Z9QF8',
  };

  it('accepts a citation without a schemaPath', () => {
    expect(CitationSchema.parse(valid)).toEqual(valid);
  });

  it('accepts an extraction citation with a schemaPath', () => {
    const parsed = CitationSchema.parse({ ...valid, schemaPath: '/invoice/total' });
    expect(parsed.schemaPath).toBe('/invoice/total');
  });

  it('rejects a zero or negative page number', () => {
    expect(CitationSchema.safeParse({ ...valid, page: 0 }).success).toBe(false);
    expect(CitationSchema.safeParse({ ...valid, page: -1 }).success).toBe(false);
  });

  it('rejects a bbox that is not exactly four numbers', () => {
    expect(CitationSchema.safeParse({ ...valid, bbox: [1, 2, 3] }).success).toBe(false);
    expect(CitationSchema.safeParse({ ...valid, bbox: [1, 2, 3, 4, 5] }).success).toBe(false);
  });

  it('rejects an empty quote', () => {
    expect(CitationSchema.safeParse({ ...valid, quote: '' }).success).toBe(false);
  });
});

describe('DocumentStatusSchema', () => {
  it('accepts every documented status', () => {
    for (const status of ['queued', 'parsing', 'ocr', 'embedding', 'ready', 'failed']) {
      expect(DocumentStatusSchema.parse(status)).toBe(status);
    }
  });

  it('rejects an unknown status', () => {
    expect(DocumentStatusSchema.safeParse('processing').success).toBe(false);
  });

  it('knows which statuses are terminal', () => {
    expect(isTerminalDocumentStatus('ready')).toBe(true);
    expect(isTerminalDocumentStatus('failed')).toBe(true);
    expect(isTerminalDocumentStatus('parsing')).toBe(false);
  });
});

describe('ParseSettingsSchema', () => {
  it('fills in the documented defaults', () => {
    expect(ParseSettingsSchema.parse({})).toEqual(DEFAULT_PARSE_SETTINGS);
  });

  it('rejects an unknown quality tier', () => {
    expect(ParseSettingsSchema.safeParse({ quality: 'turbo' }).success).toBe(false);
  });

  it('canonicalizes language order and duplicates so the settings hash is stable', () => {
    const a = ParseSettingsSchema.parse({ langList: ['tr', 'en', 'tr'] });
    const b = ParseSettingsSchema.parse({ langList: ['en', 'tr'] });
    expect(canonicalizeParseSettings(a)).toEqual(canonicalizeParseSettings(b));
    expect(canonicalizeParseSettings(a).langList).toEqual(['en', 'tr']);
  });
});

describe('JobProgressSchema', () => {
  it('accepts a progress event without a message', () => {
    const parsed = JobProgressSchema.parse({ jobId: 'job_1', stage: 'parsing', percent: 40 });
    expect(parsed.message).toBeUndefined();
  });

  it('rejects a percent outside 0-100', () => {
    const base = { jobId: 'job_1', stage: 'parsing' };
    expect(JobProgressSchema.safeParse({ ...base, percent: -1 }).success).toBe(false);
    expect(JobProgressSchema.safeParse({ ...base, percent: 101 }).success).toBe(false);
  });

  it('rejects an unknown stage', () => {
    expect(
      JobProgressSchema.safeParse({ jobId: 'job_1', stage: 'thinking', percent: 1 }).success,
    ).toBe(false);
  });
});
