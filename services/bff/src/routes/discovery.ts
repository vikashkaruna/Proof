import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { DiscoveryService } from '../connectors/discovery.js';

/** W4.6/W4.7 Drishti discovery. A trusted process controller supplies the
 * service; default startup denies all. Authority is the workload SVID in the
 * `x-workload-svid` header, never a browser session or query string. */
export function discoveryRoutes(service?: Pick<DiscoveryService, 'run'>) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.header('Cache-Control', 'private, no-store');
    await next();
  });
  app.use(
    '*',
    bodyLimit({ maxSize: 16384, onError: (c) => c.json({ error: 'discovery_refused' }, 413) }),
  );
  app.post('/run', async (c) => {
    if (!service) return c.json({ error: 'discovery_unavailable' }, 503);
    const proof = c.req.header('x-workload-svid');
    if (
      !proof ||
      new URL(c.req.url).search ||
      !c.req.header('content-type')?.startsWith('application/json')
    )
      return c.json({ error: 'discovery_refused' }, 403);
    try {
      return c.json({ data: await service.run(await c.req.json(), proof) });
    } catch {
      // Refusal reasons can describe grant state; the caller learns only refusal.
      return c.json({ error: 'discovery_refused' }, 403);
    }
  });
  return app;
}
