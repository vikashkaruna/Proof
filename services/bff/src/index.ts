import { serve } from '@hono/node-server';
import { loadEnv } from '@axiom/config';
import { loadAssessmentProducer } from './workloads/assessment-producer.js';
import { loadAssessmentProducerSocket } from './workloads/assessment-producer-socket.js';
import { loadSandboxPostgresql } from './connectors/postgresql-sandbox.js';
import { createApp } from './app.js';
import { createEvidenceIngestionWriter, createHumanActionWriter } from '@axiom/supabase';
import { logger as rootLogger } from './lib/logger.js';

/**
 * Process entrypoint. The application itself lives in `app.ts` so the
 * middleware chain is testable without binding a port (W9).
 */
const env = loadEnv();
// A deployed API must fail at startup, before it can accept a human or
// provider-backed mutation with the wrong PostgREST identity.
createHumanActionWriter();
createEvidenceIngestionWriter();
const log = rootLogger.child({ module: 'bff' });

if (env.AXIOM_ASSESSMENT_PRODUCER_CONFIG_FILE && env.AXIOM_ASSESSMENT_PRODUCER_SOCKET_CONFIG_FILE)
  throw new Error('Choose one assessment producer deployment mode');
const assessmentRequests = env.AXIOM_ASSESSMENT_PRODUCER_SOCKET_CONFIG_FILE
  ? await loadAssessmentProducerSocket(env.AXIOM_ASSESSMENT_PRODUCER_SOCKET_CONFIG_FILE)
  : await loadAssessmentProducer(env.AXIOM_ASSESSMENT_PRODUCER_CONFIG_FILE);
const discovery = await loadSandboxPostgresql(
  env.AXIOM_POSTGRESQL_SANDBOX_CONFIG_FILE,
  env.ENVIRONMENT ?? '',
);
const app = createApp({ assessmentRequests, discovery });
const port = Number(process.env.PORT || env.BFF_PORT);

log.info({ port }, 'starting BFF');

serve({ fetch: app.fetch, port }, (info) =>
  log.info({ addr: info.address, port: info.port }, 'BFF listening'),
);

// Named before exporting: an anonymous default is harder to trace from a
// stack frame back to the module that produced it.
const server = { port, fetch: app.fetch };
export default server;
