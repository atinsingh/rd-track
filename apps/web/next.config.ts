import type { NextConfig } from 'next';

const apiUrl = (process.env.API_URL ?? 'http://localhost:4000').replace(/\/$/, '');

const nextConfig: NextConfig = {
  // @rd/contracts ships TypeScript source.
  // Self-contained server bundle for the production Docker image (apps/web/Dockerfile).
  output: 'standalone',
  transpilePackages: ['@rd/contracts'],
  poweredByHeader: false,
  // Proxy the API through this origin so the HttpOnly session cookie stays first-party
  // (SameSite=Strict) and the browser never talks to the API host directly.
  async rewrites() {
    return [{ source: '/v1/:path*', destination: `${apiUrl}/v1/:path*` }];
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'same-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
        ],
      },
    ];
  },
};

export default nextConfig;
