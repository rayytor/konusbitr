import { describe, expect, it } from 'vitest';
import { dropStopWords } from '../src/stopwords.js';

describe('dropStopWords', () => {
  it('removes the function words that made the sparse leg match everything', () => {
    // "What was Licensing revenue in 2023?" matched 98,485 of 100,000 chunks on
    // the benchmark, because "what", "was" and "in" are in every passage.
    expect(dropStopWords('What was Licensing revenue in 2023?')).toBe('Licensing revenue 2023?');
  });

  it('keeps quoted phrases whole', () => {
    // A phrase is an explicit instruction about word order; the words inside it
    // are not ours to discard.
    expect(dropStopWords('the "end of the tenancy" clause')).toBe('"end of the tenancy" clause');
  });

  it('keeps an exclusion, which websearch_to_tsquery reads as a negation', () => {
    expect(dropStopWords('revenue -the -licensing')).toBe('revenue -the -licensing');
  });

  it('leaves rare exact tokens untouched', () => {
    expect(dropStopWords('INV-4471-QX')).toBe('INV-4471-QX');
    expect(dropStopWords('what is INV-4471-QX')).toBe('INV-4471-QX');
  });

  it('returns the query unchanged when nothing would survive', () => {
    // A poor query, but answering it slowly beats answering it against no terms.
    expect(dropStopWords('what is it')).toBe('what is it');
  });

  it('handles Turkish function words, which the simple configuration does not strip', () => {
    expect(dropStopWords('gelir ne kadar')).toBe('gelir');
  });

  it('survives an empty query', () => {
    expect(dropStopWords('')).toBe('');
    expect(dropStopWords('   ')).toBe('   ');
  });
});
