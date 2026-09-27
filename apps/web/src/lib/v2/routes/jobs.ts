import { ApiJobSchema } from '@konusbitr/shared';
import { readJob } from '../async';
import type { RouteContext } from '../context';
import type { RouteImplementation } from '../mount';
import type { RouteDefinition } from '../registry';

/**
 * `GET /v2/jobs/:jobId` — the durable half of the async twin.
 *
 * Every `?async=true` call's answer lives here, webhook or no webhook, which is
 * what lets the webhook retry policy be as short as it is. A caller who missed
 * a delivery, or never asked for one, polls this and gets the same body the
 * synchronous call would have returned.
 */

const definition: RouteDefinition = {
  method: 'get',
  path: '/jobs/:jobId',
  operationId: 'getJob',
  summary: 'Fetch an asynchronous operation',
  description: [
    'The status and result of an operation started with `?async=true`.',
    '',
    'While `status` is `pending` or `running`, `progress` moves from 0 to 100.',
    'On `succeeded`, `result` holds exactly the body the synchronous call would',
    'have returned. On `failed`, `error` holds exactly the error envelope it',
    'would have returned.',
    '',
    'Costs nothing to poll.',
  ].join('\n'),
  scopes: ['documents:read'],
  body: 'none',
  response: ApiJobSchema,
  params: [{ name: 'jobId', description: 'The job id returned by an `?async=true` call.' }],
  errors: ['not_found'],
};

async function run(ctx: RouteContext) {
  return readJob(ctx.auth, ctx.params.jobId ?? '');
}

export const getJobRoute: RouteImplementation = { definition, run };
