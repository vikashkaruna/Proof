import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { OwnedExecutionBroker } from '../services/owned-execution-broker.js';
/** No browser/shared-token authority; default off without trusted composition. */
export function ownedExecutionRoutes(broker?: Pick<OwnedExecutionBroker, 'run'> | null) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.header('Cache-Control', 'private, no-store');
    await next();
  });
  app.use(
    '*',
    bodyLimit({
      maxSize: 16384,
      onError: (c) => c.json({ error: 'owned_execution_refused' }, 413),
    }),
  );
  app.post('/run', async (c) => {
    if (!broker) return c.json({ error: 'owned_execution_unavailable' }, 503);
    try {
      const proof = c.req.header('x-workload-svid');
      if (
        !proof ||
        new URL(c.req.url).search ||
        c.req.header('content-type') !== 'application/json'
      )
        throw Error();
      const signal = AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(15000)]);
      return c.json({ data: await broker.run(await c.req.json(), proof, signal) });
    } catch {
      return c.json({ error: 'owned_execution_refused' }, 403);
    }
  });
  return app;
}
