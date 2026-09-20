import { serve } from '@hono/node-server';
import { loadEnv } from '@axiom/config';
import { createApp } from './app.js';
import { logger as rootLogger } from './lib/logger.js';

/**
 * Process entrypoint. The application itself lives in `app.ts` so the
 * middleware chain is testable without binding a port (W9).
 */
const env = loadEnv();
const log = rootLogger.child({ module: 'bff' });

const app = createApp();
const port = Number(process.env.PORT || env.BFF_PORT);

log.info({ port }, 'starting BFF');

serve({ fetch: app.fetch, port }, (info) =>
  log.info({ addr: info.address, port: info.port }, 'BFF listening'),
);

// Named before exporting: an anonymous default is harder to trace from a
// stack frame back to the module that produced it.
const server = { port, fetch: app.fetch };
export default server;
