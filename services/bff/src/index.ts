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

export default { port, fetch: app.fetch };
