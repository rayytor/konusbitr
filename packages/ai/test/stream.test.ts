import { describe, expect, it } from 'vitest';
import { describeStreamError } from '../src/stream.js';

/**
 * A provider rejection arrives as `AI_APICallError`, whose `message` is the
 * bare HTTP reason and whose `responseBody` holds the sentence that says what
 * is actually wrong. Showing the former alone is how "Please pass a valid API
 * key" reached a user as "Bad Request".
 */
function apiCallError(responseBody: string, statusCode = 400): Error {
  const error = new Error('Bad Request');
  error.name = 'AI_APICallError';
  return Object.assign(error, { responseBody, statusCode });
}

describe('describeStreamError', () => {
  it('surfaces the provider message rather than the HTTP reason', () => {
    const described = describeStreamError(
      apiCallError('{"error":{"code":400,"message":"Please pass a valid API key"}}'),
    );

    expect(described.message).toBe('chat provider responded 400: Please pass a valid API key');
    expect(described.name).toBe('AI_APICallError');
  });

  it('unwraps the single-element array some providers wrap the envelope in', () => {
    // Gemini's OpenAI-compatible endpoint returns `[{ error: ... }]`.
    const described = describeStreamError(
      apiCallError('[{"error":{"code":429,"message":"Quota exceeded"}}]', 429),
    );

    expect(described.message).toBe('chat provider responded 429: Quota exceeded');
  });

  it('keeps an unparseable body rather than dropping it', () => {
    const described = describeStreamError(apiCallError('upstream proxy failure', 502));

    expect(described.message).toBe('chat provider responded 502: upstream proxy failure');
  });

  it('preserves the original error as the cause', () => {
    const original = apiCallError('{"error":{"message":"nope"}}');

    expect(describeStreamError(original).cause).toBe(original);
  });

  it('passes through an error that carries no provider body', () => {
    const plain = new Error('socket hang up');

    expect(describeStreamError(plain)).toBe(plain);
  });

  it('wraps a non-Error so the caller can always throw something', () => {
    expect(describeStreamError('exploded')).toBeInstanceOf(Error);
    expect(describeStreamError('exploded').message).toBe('exploded');
  });
});
