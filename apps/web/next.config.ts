import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';

const here = dirname(fileURLToPath(import.meta.url));

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // The seam between packages is source, not build output: internal packages
  // export TypeScript directly and Next compiles them with the app.
  transpilePackages: ['@konusbitr/shared'],
  typedRoutes: true,
  // Self-contained server output for docker/web.Dockerfile: Next traces exactly
  // the files the server can reach and copies them into .next/standalone, so
  // the runtime image needs neither pnpm nor node_modules.
  output: process.env.STANDALONE === 'true' ? 'standalone' : undefined,
  // Tracing has to start at the monorepo root, otherwise workspace packages
  // resolved through the root node_modules are missed and the container fails
  // at first request instead of at build.
  outputFileTracingRoot: join(here, '..', '..'),
  webpack: (config) => {
    // Workspace packages are compiled from source (see transpilePackages) and
    // their internal imports carry the `.js` specifiers TypeScript's ESM output
    // requires. webpack has to be told those map onto `.ts` files on disk;
    // Turbopack and Vitest already infer it.
    config.resolve.extensionAlias = {
      ...config.resolve.extensionAlias,
      '.js': ['.ts', '.tsx', '.js'],
    };
    return config;
  },
};

export default nextConfig;
