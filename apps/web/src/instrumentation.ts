import { EnvValidationError, loadEnv } from '@konusbitr/shared';

/**
 * Next.js calls this once per server instance, before the first request.
 *
 * Validating here is what makes "fail loudly at boot" true for the web app: a
 * missing or malformed variable kills the process while Compose is still
 * starting it, with a message that names the variable, rather than surfacing as
 * a 500 on some later route.
 */
export function register(): void {
  // `next build` also loads this module, and a build machine legitimately has
  // no runtime configuration. Validation belongs to the server that will serve
  // traffic, not to the compiler.
  if (process.env.NEXT_PHASE === 'phase-production-build') return;

  try {
    loadEnv();
  } catch (error) {
    if (!(error instanceof EnvValidationError)) throw error;
    console.error(`\n${error.message}\n`);
    process.exit(1);
  }
}
