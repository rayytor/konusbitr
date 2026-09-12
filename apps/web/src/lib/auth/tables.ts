import {
  accounts,
  invitations,
  memberships,
  organizations,
  sessions,
  users,
  verifications,
} from '@konusbitr/db';

/**
 * The schema object the Better Auth Drizzle adapter is handed.
 *
 * Its *keys* matter: the adapter looks a table up by the `modelName` configured
 * in `config.ts`, so `member: { modelName: 'memberships' }` there requires a
 * `memberships` key here. Only the seven tables auth touches are listed —
 * handing over the whole schema would let a future plugin quietly start writing
 * to `documents`.
 */
export const authSchema = {
  users,
  sessions,
  accounts,
  verifications,
  organizations,
  memberships,
  invitations,
};
