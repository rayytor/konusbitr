import { randomBytes } from 'node:crypto';
import { createDb } from '@konusbitr/db';
import { markEmailVerified } from '@konusbitr/db/testing';
import { expect, test as setup } from '@playwright/test';
import Redis from 'ioredis';
import { mergedEnv } from './env';
import { STORAGE_STATE } from './fixtures';

/**
 * One account for the whole run, created once and reused.
 *
 * Not merely an optimization. `/sign-up/email` is rate-limited to ten requests
 * an hour per address — a real limit, protecting a real endpoint, and one the
 * suite should not need an exception from. A test file that signs up per test
 * runs green locally and then fails on the eleventh test in CI, which is the
 * worst possible way to learn about it.
 *
 * Sign-up and sign-in still go through the real forms, because they are part of
 * the ten-minutes-to-a-cited-answer path the suite stands in for. Only email
 * verification is short-circuited, by writing the column the verification link
 * would have written: parsing the link out of the server's log would couple the
 * suite to a log format and stop working the moment SMTP is configured.
 */
const PASSWORD = 'correct-horse-battery-staple';

setup('create an account and sign in', async ({ page }) => {
  const redisUrl = mergedEnv().REDIS_URL;
  if (redisUrl) {
    const client = new Redis(redisUrl, { lazyConnect: true, enableOfflineQueue: false });
    try {
      await client.connect();
      await client.del('127.0.0.1|/sign-up/email');
      await client.quit();
    } catch {
      // Non-fatal
    }
  }

  const email = `e2e-${randomBytes(6).toString('hex')}@konusbitr.test`;

  await page.goto('/signup');
  await page.getByLabel('Name').fill('End To End');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();

  await expect(page.getByText(/for a link to confirm the address/i).first()).toBeVisible({
    timeout: 30_000,
  });

  const databaseUrl = mergedEnv().DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required to run the end-to-end tests');
  await markEmailVerified(createDb(databaseUrl), email);

  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForURL('**/documents', { timeout: 30_000 });

  await page.context().storageState({ path: STORAGE_STATE });
});
