import { describe, expect, it } from 'vitest';
import {
  documentImageKey,
  documentPrefix,
  originalKey,
  pageThumbnailKey,
  StorageKeyError,
} from '../src/keys.js';

const ORG = 'org_clx1abcd2345';
const DOC = 'doc_clx1efgh6789';

describe('the key layout', () => {
  it('puts every artifact of a document under one prefix', () => {
    expect(documentPrefix(ORG, DOC)).toBe(`orgs/${ORG}/documents/${DOC}/`);
    expect(originalKey(ORG, DOC, 'pdf')).toBe(`orgs/${ORG}/documents/${DOC}/original.pdf`);
    expect(pageThumbnailKey(ORG, DOC, 3)).toBe(
      `orgs/${ORG}/documents/${DOC}/thumbnails/00003.webp`,
    );
    // Zero-padded, so a lexical listing of the prefix is a page-order listing.
    // The worker writes these keys and this function reads them, across a seam
    // with no shared code — `services/worker/tests/test_thumbnails.py` asserts
    // the same string from the other side.
    expect(pageThumbnailKey(ORG, DOC, 10)).toBe(
      `orgs/${ORG}/documents/${DOC}/thumbnails/00010.webp`,
    );
    expect(documentImageKey(ORG, DOC, 1)).toBe(`orgs/${ORG}/documents/${DOC}/images/1.png`);
  });

  it('normalizes an extension rather than trusting its shape', () => {
    expect(originalKey(ORG, DOC, '.PDF')).toBe(`orgs/${ORG}/documents/${DOC}/original.pdf`);
  });
});

describe('keys are never built from user input', () => {
  it.each([
    ['a traversal', '../../etc'],
    ['a path', 'orgs/other'],
    ['an empty id', ''],
    ['a filename', 'report.pdf'],
    ['an unprefixed id', 'clx1abcd2345'],
  ])('refuses %s as an org id', (_label, value) => {
    expect(() => documentPrefix(value, DOC)).toThrow(StorageKeyError);
  });

  it.each([
    ['a traversal', '../../etc'],
    ['a path', 'documents/other'],
    ['an empty id', ''],
  ])('refuses %s as a document id', (_label, value) => {
    expect(() => documentPrefix(ORG, value)).toThrow(StorageKeyError);
  });

  it('refuses an extension that is really a path', () => {
    expect(() => originalKey(ORG, DOC, 'pdf/../../secret')).toThrow(StorageKeyError);
    expect(() => originalKey(ORG, DOC, '')).toThrow(StorageKeyError);
  });

  it('refuses a page or image index that is not a positive integer', () => {
    expect(() => pageThumbnailKey(ORG, DOC, 0)).toThrow(StorageKeyError);
    expect(() => pageThumbnailKey(ORG, DOC, -1)).toThrow(StorageKeyError);
    expect(() => documentImageKey(ORG, DOC, 1.5)).toThrow(StorageKeyError);
  });
});
