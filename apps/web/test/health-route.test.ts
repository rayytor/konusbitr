import { describe, expect, it } from 'vitest';
import { GET } from '../src/app/api/health/route.js';

describe('GET /api/health', () => {
  it('reports ok and the app version', async () => {
    const response = GET();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, version: expect.any(String) });
  });
});
