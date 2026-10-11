import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The floating dev badge overlays the sidebar's account controls in local review.
  devIndicators: false,
  output: 'standalone',
  outputFileTracingRoot: path.join(__dirname, '../../'),
  transpilePackages: [
    '@axiom/config',
    '@axiom/control-library',
    '@axiom/design-tokens',
    '@axiom/evidence',
    '@axiom/ledger',
    '@axiom/supabase',
    '@axiom/types',
    '@axiom/ui',
  ],
  experimental: {
    // Server Actions are stable in 14
    serverActions: {
      bodySizeLimit: '10mb', // allow evidence uploads
    },
  },
  // Security headers (Doc 04 §7 + BR-1)
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'X-DNS-Prefetch-Control', value: 'on' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
          {
            key: 'Strict-Transport-Security',
            value: 'max-age=63072000; includeSubDomains; preload',
          },
        ],
      },
    ];
  },
};

export default nextConfig;
