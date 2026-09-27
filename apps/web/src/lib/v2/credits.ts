import { scopedDb } from '@konusbitr/db';
import type { CreditReason, Env } from '@konusbitr/shared';
import { db } from '@/lib/db';
import { ApiError } from './errors';

/**
 * Charging, and the two modes it happens in.
 *
 * `CREDITS_MODE=unlimited` is the self-host default and is **not** "billing
 * off". Usage is still written to the ledger, because an operator running this
 * on their own hardware still wants to know what it costs them — which
 * documents burned the model budget, which integration is responsible. What
 * `unlimited` removes is the *refusal*: nothing is ever declined for lack of
 * credits, and a self-hoster never has to understand a currency to use their
 * own software.
 *
 * `metered` is for anybody running Konusbitr as a service, and enforces the
 * balance before the work is done.
 *
 * Every charge is a ledger row with a reason and a reference. There is no
 * balance column to mutate: a balance that is a number nobody can explain is
 * worse than no balance at all, and "why did this call cost four credits" has
 * to be answerable from the database a month later.
 */

export type ChargeInput = {
  orgId: string;
  /** Credits to spend. Written negated; `0` is a legitimate, recorded charge. */
  amount: number;
  reason: CreditReason;
  /** The document, extraction or job the charge is for. */
  refId?: string | null;
  metadata?: Record<string, unknown>;
};

/**
 * Refuse now if the balance will not cover it. Only under `metered`.
 *
 * Checked before the work rather than after, because a charge levied after a
 * model call has already been paid for by us. The check and the charge are
 * deliberately two steps with the work in between: an operation that *failed*
 * must not be billed, and the only way to know whether it failed is to have
 * run it.
 *
 * Two gaps live in that arrangement and both are accepted rather than locked
 * away. Two concurrent requests can each see a sufficient balance; and a call
 * whose true cost is only known after the document has been read — a parse
 * bills by pages nobody has counted yet — is admitted on a balance check it
 * may then exceed. Either way the worst case is one operation's overdraft,
 * which shows up in the ledger as a negative balance and refuses the *next*
 * call. The alternative is serializing every call in an organization behind a
 * row lock, or quoting a price from a page count the file has not been opened
 * far enough to know. The rate limiter bounds how far either race can run.
 */
export async function assertCredits(orgId: string, env: Env, amount: number): Promise<void> {
  if (env.CREDITS_MODE !== 'metered') return;
  if (amount <= 0) return;

  const balance = await scopedDb(db(), orgId).creditBalance();
  if (balance >= amount) return;

  throw new ApiError(
    'insufficient_credits',
    `This call costs ${amount} credit${amount === 1 ? '' : 's'} and the organization has ${balance}.`,
    { required: amount, balance },
  );
}

/**
 * Refuse an organization that is already out, before any bytes are read.
 *
 * The admission check for operations whose price depends on a page count that
 * is not known yet. It does not pretend to be a quote — it is the one thing
 * that can honestly be asserted up front, which is that an organization with
 * nothing left does not get to start another call.
 */
export async function assertNotExhausted(orgId: string, env: Env): Promise<void> {
  if (env.CREDITS_MODE !== 'metered') return;

  const balance = await scopedDb(db(), orgId).creditBalance();
  if (balance > 0) return;

  throw new ApiError('insufficient_credits', 'This organization has no credits left.', { balance });
}

/**
 * Write the charge.
 *
 * Deltas are negative for spend so that the balance is the plain sum of the
 * column and no reader has to know which reasons are debits. A zero-delta row
 * is not a no-op and is never skipped: `cache_hit` rows are how "a second parse
 * of the same bytes cost nothing" is *provable* rather than merely claimed, and
 * the phase's acceptance criteria ask for exactly that.
 */
export async function charge(input: ChargeInput): Promise<void> {
  await scopedDb(db(), input.orgId).recordCredit({
    delta: -Math.abs(Math.trunc(input.amount)),
    reason: input.reason,
    refId: input.refId ?? null,
    metadata: input.metadata,
  });
}

/** Record that a call was served from the docId cache and cost nothing. */
export async function recordCacheHit(
  orgId: string,
  refId: string,
  metadata?: Record<string, unknown>,
): Promise<void> {
  await scopedDb(db(), orgId).recordCredit({
    delta: 0,
    reason: 'cache_hit',
    refId,
    metadata,
  });
}
