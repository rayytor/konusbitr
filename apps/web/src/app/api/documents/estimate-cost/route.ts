import { EstimateCostRequestSchema, type EstimateCostResponse } from '@konusbitr/shared';
import { withAuth } from '@/lib/auth/with-auth';
import { loadWebEnv } from '@/lib/env';
import { IngestError, problemResponse } from '@/lib/ingest/errors';
import { checkAllowance, estimateFor } from '@/lib/ingest/vlm';

/**
 * What would this cost, before I commit to it?
 *
 * The advanced tier reads every page with a vision model, and a 50-page
 * document against a frontier model is real money. This is the endpoint the
 * confirmation modal calls before the upload starts, so the number a person
 * agrees to is computed by the same code that will enforce the ceiling a moment
 * later — rather than by a second implementation in the browser that can drift
 * from it.
 *
 * It takes a **page count, not a file**. The browser already knows how many
 * pages a PDF has before it uploads one, the answer does not depend on the
 * bytes, and an endpoint that needed the file would mean uploading a 400-page
 * document in order to be told it is too long. That also makes this safe to
 * call repeatedly while somebody toggles a quality switch.
 *
 * `quality: "standard"` is answered rather than refused, with a zero estimate:
 * a UI comparing the two options should not have to special-case the free one.
 */
export const POST = withAuth(
  async (request, auth) => {
    try {
      const parsed = EstimateCostRequestSchema.safeParse(await request.json().catch(() => null));
      if (!parsed.success) {
        throw IngestError.badRequest('invalid_request', 'A positive page count is required.');
      }

      const env = loadWebEnv();
      const { pageCount, quality } = parsed.data;

      if (quality === 'standard') {
        // Zero pages through the VLM, which is the truth: the standard tier
        // costs CPU time on the operator's own machine and nothing per page.
        const body: EstimateCostResponse = {
          quality,
          pageCount,
          allowed: true,
          reason: null,
          message: 'Standard parsing runs on this deployment and costs nothing per page.',
          maxPages: env.MAX_VLM_PAGES_PER_JOB,
          estimate: { ...estimateFor(env, 0), estimatedUsd: 0 },
          spend: null,
        };
        return Response.json(body, { headers: { 'cache-control': 'no-store' } });
      }

      const allowance = await checkAllowance(auth.orgId, env, pageCount);

      const body: EstimateCostResponse = {
        quality,
        pageCount,
        allowed: allowance.allowed,
        reason: allowance.reason,
        message: allowance.message,
        maxPages: env.MAX_VLM_PAGES_PER_JOB,
        estimate: allowance.estimate,
        spend: allowance.spend,
      };

      // 200 even when `allowed` is false. This is a question, and "no, because
      // the document is too long" is an answer to it — a 4xx here would make a
      // UI that is doing exactly the right thing look like it made a bad
      // request. The refusal with a status attached happens at `POST
      // /api/documents`, where something is actually being attempted.
      return Response.json(body, { headers: { 'cache-control': 'no-store' } });
    } catch (error) {
      return problemResponse(error);
    }
  },
  { scopes: ['documents:write'] },
);

export const dynamic = 'force-dynamic';
