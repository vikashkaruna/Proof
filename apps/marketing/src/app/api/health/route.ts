import { loadWebEnv } from '@axiom/config';

export const dynamic = 'force-dynamic';

/** Public deployment identity only; never expose configuration or credentials. */
export function GET() {
  const env = loadWebEnv();
  return Response.json(
    {
      status: 'ok',
      service: 'axiom-marketing',
      timestamp: new Date().toISOString(),
      environment: env.ENVIRONMENT ?? 'local',
      authMode: env.AXIOM_AUTH_MODE,
      revision: env.AXIOM_RELEASE_SHA ?? null,
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
