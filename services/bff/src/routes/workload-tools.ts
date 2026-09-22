import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { AssessmentTools } from '../workloads/assessment-tools.js';

/** A trusted process controller supplies tools. Default app startup denies all;
 * browser sessions and the legacy runtime shared token never enable this gate. */
export function workloadToolsRoutes(tools?: Pick<AssessmentTools, 'start' | 'complete'>) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.header('Cache-Control', 'private, no-store');
    await next();
  });
  app.use(
    '*',
    bodyLimit({ maxSize: 1048576, onError: (c) => c.json({ error: 'tool_refused' }, 413) }),
  );
  for (const operation of ['start', 'complete'] as const) {
    app.post(`/assessment/${operation}`, async (c) => {
      if (!tools) return c.json({ error: 'tool_unavailable' }, 503);
      // Never allow authority in query strings (request log/referrer exposure).
      if (
        new URL(c.req.url).search ||
        !c.req.header('content-type')?.startsWith('application/json')
      )
        return c.json({ error: 'tool_refused' }, 403);
      try {
        return c.json(await tools[operation](await c.req.json()));
      } catch {
        return c.json({ error: 'tool_refused' }, 403);
      }
    });
  }
  return app;
}
