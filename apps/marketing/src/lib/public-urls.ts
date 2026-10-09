import { BRAND } from '@axiom/config';

/** Canonical public marketing origin used by metadata, robots, and sitemap. */
export function marketingOrigin(): string {
  const configured = process.env.AXIOM_PROOF_MARKETING_URL;
  if (!configured) {
    if (process.env.AXIOM_STRICT_PUBLIC_URLS === '1') {
      throw new Error('AXIOM_PROOF_MARKETING_URL is required for marketing deployment');
    }
    return `https://${BRAND.primaryDomain}`;
  }
  const url = new URL(configured);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    throw new Error('AXIOM_PROOF_MARKETING_URL must be a bare HTTPS origin');
  }
  return url.origin;
}
