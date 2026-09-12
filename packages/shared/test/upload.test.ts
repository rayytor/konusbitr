import { describe, expect, it } from 'vitest';
import {
  canonicalizeParseSettings,
  DEFAULT_PARSE_SETTINGS,
  parseSettingsHashInput,
} from '../src/parse-settings.js';
import {
  PresignRequestSchema,
  SUPPORTED_UPLOAD_MIMES,
  sanitizeFilename,
  UPLOAD_ACCEPT_ATTRIBUTE,
  uploadKindForFilename,
  uploadKindForMime,
} from '../src/upload.js';

describe('the upload allowlist', () => {
  it('accepts PDFs and nothing else yet', () => {
    expect(SUPPORTED_UPLOAD_MIMES).toEqual(['application/pdf']);
    expect(uploadKindForMime('application/pdf')?.extension).toBe('pdf');
    expect(uploadKindForMime('application/zip')).toBeUndefined();
  });

  it('ignores the parameters a browser appends to a media type', () => {
    expect(uploadKindForMime('application/pdf; charset=binary')?.extension).toBe('pdf');
    expect(uploadKindForMime('  APPLICATION/PDF ')?.extension).toBe('pdf');
  });

  it('falls back to the filename for clients that send octet-stream', () => {
    expect(uploadKindForFilename('Quarterly Report.PDF')?.mime).toBe('application/pdf');
    expect(uploadKindForFilename('notes.txt')).toBeUndefined();
  });

  it('derives the file picker’s accept attribute from the same list', () => {
    expect(UPLOAD_ACCEPT_ATTRIBUTE).toBe('application/pdf,.pdf');
  });
});

describe('sanitizeFilename', () => {
  it('keeps a filename as a label and never as a path', () => {
    expect(sanitizeFilename('../../etc/passwd')).toBe('passwd');
    expect(sanitizeFilename('C:\\Users\\ada\\report.pdf')).toBe('report.pdf');
  });

  it('strips control characters and falls back when nothing is left', () => {
    expect(sanitizeFilename('re\u0000port\u001f.pdf')).toBe('report.pdf');
    expect(sanitizeFilename('   ')).toBe('document.pdf');
  });

  it('bounds the length so it fits the column and the UI', () => {
    expect(sanitizeFilename(`${'a'.repeat(400)}.pdf`)).toHaveLength(255);
  });
});

describe('the settings half of the docId cache key', () => {
  it('is stable across language order and duplicates', () => {
    const a = parseSettingsHashInput(
      canonicalizeParseSettings({ quality: 'standard', langList: ['tr', 'en', 'tr'], llm: false }),
    );
    const b = parseSettingsHashInput(
      canonicalizeParseSettings({ quality: 'standard', langList: ['en', 'tr'], llm: false }),
    );

    expect(a).toBe(b);
  });

  it('changes when quality changes, which is what forces a new parse', () => {
    const standard = parseSettingsHashInput(DEFAULT_PARSE_SETTINGS);
    const advanced = parseSettingsHashInput({ ...DEFAULT_PARSE_SETTINGS, quality: 'advanced' });

    expect(standard).not.toBe(advanced);
  });

  it('emits canonical JSON — sorted keys, no whitespace — for the Python half', () => {
    expect(parseSettingsHashInput(DEFAULT_PARSE_SETTINGS)).toBe(
      '{"langList":[],"llm":false,"quality":"standard"}',
    );
  });
});

describe('PresignRequestSchema', () => {
  it('requires a positive, whole byte size', () => {
    const ok = PresignRequestSchema.safeParse({
      filename: 'a.pdf',
      mimeType: 'application/pdf',
      byteSize: 12,
    });
    expect(ok.success).toBe(true);

    for (const byteSize of [0, -1, 1.5]) {
      expect(
        PresignRequestSchema.safeParse({ filename: 'a.pdf', mimeType: 'application/pdf', byteSize })
          .success,
      ).toBe(false);
    }
  });
});
