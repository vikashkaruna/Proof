import { z } from 'zod';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { DiscoveryService } from '../connectors/discovery.js';

/** W4.6/W4.7 Drishti discovery. A trusted process controller supplies the
 * service; default startup denies all. Authority is the workload SVID in the
 * `x-workload-svid` header, never a browser session or query string. */
export function discoveryRoutes(
  service?: Pick<DiscoveryService, 'run'> & {
    runRetained?(
      tenantId: string,
      requestId: string,
      proof: string,
      signal?: AbortSignal,
    ): Promise<unknown>;
  },
) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.header('Cache-Control', 'private, no-store');
    await next();
  });
  app.use(
    '*',
    bodyLimit({ maxSize: 16384, onError: (c) => c.json({ error: 'discovery_refused' }, 413) }),
  );
  app.post('/retained', async (c) => {
    if (!service?.runRetained) return c.json({ error: 'discovery_unavailable' }, 503);
    try {
      if (new URL(c.req.url).search || c.req.header('content-type') !== 'application/json')
        throw new Error();
      const proof = c.req.header('x-workload-svid');
      if (!proof) throw new Error();
      const body = z
        .object({ tenantId: z.uuid(), requestId: z.uuid() })
        .strict()
        .parse(await c.req.json());
      return c.json({
        data: await service.runRetained(body.tenantId, body.requestId, proof, c.req.raw.signal),
      });
    } catch {
      return c.json({ error: 'discovery_refused' }, 403);
    }
  });
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
      return c.json({ data: await service.run(await c.req.json(), proof, c.req.raw.signal) });
    } catch {
      // Refusal reasons can describe grant state; the caller learns only refusal.
      return c.json({ error: 'discovery_refused' }, 403);
    }
  });
  return app;
}
