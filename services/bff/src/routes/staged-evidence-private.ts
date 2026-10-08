import { Hono } from 'hono';
import { boundedJsonBody } from '../middleware/evidence-body-limit.js';
import { stageFromSignedRuntime } from '../services/saakshi-runtime-stage.js';
export function stagedEvidencePrivateRoutes(config?: Parameters<typeof stageFromSignedRuntime>[2]) {
  const app = new Hono();
  app.use('/stage', boundedJsonBody(64 * 1024));
  app.post('/stage', async (c) => {
    c.header('Cache-Control', 'private, no-store');
    if (!config) return c.json({ error: { code: 'staged_evidence_unavailable' } }, 503);
    if (Object.keys(c.req.query()).length || c.req.header('Content-Encoding'))
      return c.json({ error: { code: 'staged_evidence_refused' } }, 403);
    try {
      const value = await stageFromSignedRuntime(
        await c.req.json(),
        c.req.header('Authorization'),
        config,
      );
      return c.json(value);
    } catch {
      return c.json({ error: { code: 'staged_evidence_unconfirmed' } }, 503);
    }
  });
  return app;
}
