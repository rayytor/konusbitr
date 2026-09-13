import { defineConfig, devices } from '@playwright/test';
import { BASE_URL, MODEL_STUB_PORT, mergedEnv, WEB_PORT } from './e2e/env';
import { STORAGE_STATE } from './e2e/fixtures';

/**
 * The product's smoke test.
 *
 * It runs against a **production build** of the web app, a real Postgres, a
 * real Redis, a real MinIO and the real Python worker — the only substitution
 * is the chat model, which is stubbed so that the citation it produces is
 * deterministic (see `e2e/model-stub.mjs`). Everything the citation passes
 * through on its way to the screen is the real thing.
 *
 * The backing services and the worker are *not* started here. They come from
 * `pnpm dev:infra` locally and from the CI job's services, because a Playwright
 * `webServer` that owns Docker is a Playwright config that fails in ways nobody
 * can debug from a test report.
 */
const base = mergedEnv();

export default defineConfig({
  testDir: './e2e',
  outputDir: './e2e/.results',
  fullyParallel: false,
  // One worker: the tests share one database and one object store, and a
  // library assertion that races another test's upload is a flaky test.
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  timeout: 240_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list']],

  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },

  projects: [
    // One sign-up for the whole run; `e2e/auth.setup.ts` explains why that is a
    // correctness requirement rather than a speed one.
    { name: 'setup', testMatch: /auth\.setup\.ts/ },
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], storageState: STORAGE_STATE },
      dependencies: ['setup'],
    },
  ],

  webServer: [
    {
      command: 'node e2e/model-stub.mjs',
      url: `http://127.0.0.1:${MODEL_STUB_PORT}/v1/chat/completions`,
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
      // The stub answers POSTs and 404s everything else, which is enough for
      // Playwright's readiness probe.
      ignoreHTTPSErrors: true,
    },
    {
      // `next start` takes the port as an argument, not from PORT, and the
      // package script hard-codes 3000 — so it is passed explicitly here, and an
      // e2e run never collides with a `pnpm dev` already on that port.
      command: `pnpm build && pnpm exec next start --port ${WEB_PORT}`,
      url: `${BASE_URL}/api/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 300_000,
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        ...base,
        NODE_ENV: 'production',
        PORT: String(WEB_PORT),
        APP_URL: BASE_URL,
        // The model router points at the stub. Nothing else about the AI
        // configuration is overridden, so retrieval behaves exactly as a
        // default self-hosted install does — keyword-only, no vectors.
        LLM_PROVIDER: 'openai',
        LLM_BASE_URL: `http://127.0.0.1:${MODEL_STUB_PORT}`,
        LLM_CHAT_MODEL: 'konusbitr-e2e-stub',
        LLM_API_KEY: 'e2e-stub-key',
        OFFLINE_MODE: 'false',
      },
    },
  ],
});
