import { describe, expect, it } from 'vitest';
import { ID_PREFIXES, newId } from '../src/id.js';

describe('newId', () => {
  it('generates a prefixed id', () => {
    const id = newId('doc');
    expect(id).toMatch(/^doc_[a-z0-9]+$/);
  });

  it('uses known prefixes', () => {
    expect(newId(ID_PREFIXES.user)).toMatch(/^usr_/);
    expect(newId(ID_PREFIXES.organization)).toMatch(/^org_/);
    expect(newId(ID_PREFIXES.document)).toMatch(/^doc_/);
    expect(newId(ID_PREFIXES.chunk)).toMatch(/^chk_/);
    expect(newId(ID_PREFIXES.apiKey)).toMatch(/^key_/);
    expect(newId(ID_PREFIXES.conversation)).toMatch(/^cnv_/);
    expect(newId(ID_PREFIXES.message)).toMatch(/^msg_/);
    expect(newId(ID_PREFIXES.job)).toMatch(/^job_/);
  });

  it('generates unique ids', () => {
    const ids = new Set(Array.from({ length: 1000 }, () => newId('test')));
    expect(ids.size).toBe(1000);
  });

  it('produces URL-safe characters', () => {
    for (let i = 0; i < 50; i++) {
      const id = newId('x');
      // Only lowercase alphanumerics and underscores
      expect(id).toMatch(/^[a-z0-9_]+$/);
    }
  });
});
