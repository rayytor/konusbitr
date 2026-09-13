import { permanentRedirect } from 'next/navigation';

/**
 * `/library` was the Phase 05 address of what is now `/documents`.
 *
 * Kept as a permanent redirect rather than deleted: it is in the README, in the
 * sign-in redirect of anyone who bookmarked it, and in at least one screenshot.
 * Costing a redirect is cheaper than breaking a link.
 */
export default function LegacyLibraryPage(): never {
  permanentRedirect('/documents');
}
