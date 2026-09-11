import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // The seam between packages is source, not build output: internal packages
  // export TypeScript directly and Next compiles them with the app.
  transpilePackages: ['@konusbitr/shared'],
  typedRoutes: true,
};

export default nextConfig;
