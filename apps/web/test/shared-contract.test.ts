import {
  CitationSchema,
  DocumentStatusSchema,
  JobProgressSchema,
  ParseSettingsSchema,
} from '@konusbitr/shared';
import { describe, expect, it } from 'vitest';

/**
 * Guards the acceptance criterion that `@konusbitr/shared` is importable from
 * the web app. If the workspace link or the package's `exports` map breaks,
 * this fails before anything downstream does.
 */
describe('@konusbitr/shared is reachable from apps/web', () => {
  it('exposes the four seed schemas', () => {
    expect(CitationSchema).toBeDefined();
    expect(DocumentStatusSchema).toBeDefined();
    expect(ParseSettingsSchema).toBeDefined();
    expect(JobProgressSchema).toBeDefined();
  });

  it('parses a payload through a shared schema', () => {
    const settings = ParseSettingsSchema.parse({ quality: 'advanced', langList: ['tr'] });
    expect(settings).toEqual({ quality: 'advanced', langList: ['tr'], llm: false });
  });
});
