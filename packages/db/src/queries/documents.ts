import { and, eq } from 'drizzle-orm';
import type { Database } from '../client.js';
import * as schema from '../schema/index.js';

/**
 * The one document query that deliberately has no organization predicate.
 *
 * It lives here, beside the API-key lookup, for the same reason: every other
 * query path in Konusbitr knows its organization before it runs, so the
 * exceptions are kept together, named, and few enough to review.
 *
 * This one is reachable **only** when an operator has set
 * `ALLOW_GLOBAL_PARSE_CACHE=true`. The route that calls it checks that flag
 * first; nothing else in the codebase calls it at all.
 */

/**
 * A finished parse for these bytes and settings, from any organization.
 *
 * Enabling this trades a privacy property for a cost one, and the trade is real
 * enough to be worth stating twice: an organization that uploads a file and
 * receives an instant `ready` has learned that some other tenant of this
 * instance already holds that exact file, byte for byte. On a single-tenant
 * self-hosted instance there is nobody to learn anything and the saving is
 * free, which is why the opt-in exists — and why it is off by default.
 *
 * Note what it returns and what it does not: the parse artifact is keyed by
 * `(content_hash, settings_hash)`, never by `document_id`, so a second
 * organization's document can point at the same parse without copying it. The
 * `document_id` column records which upload *caused* the parse, not who may
 * read it.
 */
export async function globalParseResultByHashes(
  db: Database,
  contentHash: string,
  settingsHash: string,
) {
  const [row] = await db
    .select({
      id: schema.parseResults.id,
      documentId: schema.parseResults.documentId,
      pageCount: schema.parseResults.pageCount,
    })
    .from(schema.parseResults)
    .where(
      and(
        eq(schema.parseResults.contentHash, contentHash),
        eq(schema.parseResults.settingsHash, settingsHash),
      ),
    )
    .limit(1);
  return row;
}
