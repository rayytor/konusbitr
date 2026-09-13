import { describe, expect, it } from 'vitest';
import { describePdfError } from '@/components/viewer/pdf';

describe('describePdfError', () => {
  it('identifies password-protected PDFs', () => {
    const error = new Error('Password required');
    error.name = 'PasswordException';
    expect(describePdfError(error)).toContain('password-protected');
  });

  it('identifies invalid or truncated PDFs', () => {
    const error = new Error('Bad PDF header');
    error.name = 'InvalidPDFException';
    expect(describePdfError(error)).toContain('not a readable PDF');
  });

  it('identifies missing or unexpected response storage errors', () => {
    const missing = new Error('404 Not Found');
    missing.name = 'MissingPDFException';
    expect(describePdfError(missing)).toContain('could not be fetched');

    const unexpected = new Error('500 Internal Error');
    unexpected.name = 'UnexpectedResponseException';
    expect(describePdfError(unexpected)).toContain('could not be fetched');
  });

  it('provides a graceful fallback message for unknown errors', () => {
    expect(describePdfError(new Error('Unknown failure'))).toBe(
      'The document could not be displayed.',
    );
  });
});
