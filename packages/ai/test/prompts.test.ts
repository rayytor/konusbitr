import { describe, expect, it } from 'vitest';
import { loadPrompt } from '../src/prompts.js';

describe('loadPrompt', () => {
  it('loads existing versioned prompts', () => {
    const rewrite = loadPrompt('chat.rewrite.v1.md');
    expect(rewrite).toContain('rewrite the message into a clear, standalone search query');

    const hyde = loadPrompt('chat.hyde.v1');
    expect(hyde).toContain('Write a hypothetical passage');

    const multiquery = loadPrompt('chat.multiquery.v1');
    expect(multiquery).toContain('Generate 3 different search query variations');

    const summarize = loadPrompt('chat.summarize.v1');
    expect(summarize).toContain('Summarize the following document');
  });

  it('throws on non-existent prompt', () => {
    expect(() => loadPrompt('non.existent.v1')).toThrow(/Failed to load prompt/);
  });
});
