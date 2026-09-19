/**
 * Resolves the appropriate Workbench Web App URL dynamically across all environments:
 * - Preprod Cloud Run: automatically transforms axiom-marketing-preprod-* -> axiom-web-preprod-*
 * - Generic Cloud Run: transforms *-marketing-* -> *-web-*
 * - Production: axiomproof.ai / www.axiomproof.ai -> https://app.axiomproof.ai
 * - Staging: staging.axiomproof.ai -> https://app-staging.axiomproof.ai
 * - Localhost: http://localhost:3001
 * - Honors NEXT_PUBLIC_APP_URL / APP_URL if explicitly configured with a non-localhost target.
 */
export function resolveAppUrl(): string {
  if (typeof window !== 'undefined') {
    const host = window.location.hostname;
    const origin = window.location.origin;

    // Check Cloud Run preprod / staging / prod URLs
    // e.g. https://axiom-marketing-preprod-188516662106.asia-south1.run.app
    if (host.includes('marketing-preprod')) {
      return origin.replace('marketing-preprod', 'web-preprod');
    }
    if (host.includes('marketing-staging')) {
      return origin.replace('marketing-staging', 'web-staging');
    }
    if (host.includes('marketing-')) {
      return origin.replace('marketing-', 'web-');
    }

    // Production domain mapping (axiomproof.ai for app, axiomminds.ai for company)
    if (
      host === 'axiomproof.ai' ||
      host === 'www.axiomproof.ai' ||
      host === 'axiomminds.ai' ||
      host === 'www.axiomminds.ai'
    ) {
      return 'https://app.axiomproof.ai';
    }
    if (host === 'staging.axiomproof.ai' || host === 'staging.axiomminds.ai') {
      return 'https://app-staging.axiomproof.ai';
    }

    // Firebase Hosting preprod site (axiom-proof.web.app / axiom-proof.firebaseapp.com)
    if (
      host.includes('axiom-proof') &&
      (host.endsWith('.web.app') || host.endsWith('.firebaseapp.com'))
    ) {
      return (
        process.env.NEXT_PUBLIC_APP_URL ||
        'https://axiom-web-preprod-188516662106.asia-south1.run.app'
      );
    }
    if (host.endsWith('.web.app') || host.endsWith('.firebaseapp.com')) {
      return (
        process.env.NEXT_PUBLIC_APP_URL ||
        'https://axiom-web-preprod-188516662106.asia-south1.run.app'
      );
    }

    // Explicit env variable if valid and not localhost when running in a remote browser
    if (
      process.env.NEXT_PUBLIC_APP_URL &&
      !process.env.NEXT_PUBLIC_APP_URL.includes('localhost') &&
      !process.env.NEXT_PUBLIC_APP_URL.includes('127.0.0.1')
    ) {
      return process.env.NEXT_PUBLIC_APP_URL;
    }

    // On-Premise / LAN IP deployment (e.g. http://192.168.x.x:3000 -> http://192.168.x.x:3001)
    if (
      window.location.port === '3000' ||
      window.location.port === String(process.env.MARKETING_PORT || '3000')
    ) {
      const targetPort = String(process.env.WEB_PORT || '3001');
      return `${window.location.protocol}//${window.location.hostname}:${targetPort}`;
    }

    // Localhost development
    if (host === 'localhost' || host === '127.0.0.1') {
      return process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3001';
    }
  }

  // Server-side fallback:
  if (
    process.env.NEXT_PUBLIC_APP_URL &&
    !process.env.NEXT_PUBLIC_APP_URL.includes('localhost') &&
    !process.env.NEXT_PUBLIC_APP_URL.includes('127.0.0.1')
  ) {
    return process.env.NEXT_PUBLIC_APP_URL;
  }
  if (
    process.env.APP_URL &&
    !process.env.APP_URL.includes('localhost') &&
    !process.env.APP_URL.includes('127.0.0.1')
  ) {
    return process.env.APP_URL;
  }
  if (process.env.ENVIRONMENT === 'preprod') {
    const projectNumber = process.env.GCP_PROJECT_NUMBER || '188516662106';
    const region = process.env.GCP_REGION || 'asia-south1';
    return (
      process.env.NEXT_PUBLIC_APP_URL ||
      process.env.APP_URL ||
      `https://axiom-web-preprod-${projectNumber}.${region}.run.app`
    );
  }
  return process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3001';
}
