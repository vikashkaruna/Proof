import type { MetadataRoute } from 'next';
import { marketingOrigin } from '@/lib/public-urls';

export const dynamic = 'force-static';

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: '*', allow: '/', disallow: ['/api/'] }],
    sitemap: `${marketingOrigin()}/sitemap.xml`,
  };
}
