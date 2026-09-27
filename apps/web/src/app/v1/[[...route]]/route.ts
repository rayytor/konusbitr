import { handle } from 'hono/vercel';
import { createV1App } from '@/lib/v2/app';

/**
 * The legacy `/v1` endpoints, mounted into Next.js.
 *
 * A separate mount from `/v2` rather than a prefix inside it, so that an
 * operator who does not want to expose the compatibility surface at all can
 * delete this file and lose nothing else.
 */
const app = createV1App();

export const POST = handle(app);

export const dynamic = 'force-dynamic';
