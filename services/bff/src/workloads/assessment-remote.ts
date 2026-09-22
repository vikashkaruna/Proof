import { createServer } from 'node:http';
import { createServer as createTlsServer } from 'node:https';
import {
  assessmentDeadline,
  assessmentRequestListener,
  type AssessmentEndpointOptions,
} from './assessment-http.js';
import type { SchedulerIdentity } from './scheduler-identity.js';

/** Separate controller listener; never installed into the public BFF by default.
 * `platform` means a trusted TLS-terminating ingress, not permission to expose
 * plaintext traffic. The application always checks its own scheduler identity,
 * independent of forwarding headers and platform invoker policy. */
export function createRemoteAssessmentServer(
  options: AssessmentEndpointOptions & {
    identity: SchedulerIdentity;
    tls: { key: string | Buffer; cert: string | Buffer } | 'platform';
  },
) {
  if (!options.identity || typeof options.identity.authorize !== 'function' || !options.tls)
    throw new Error('Remote controller configuration refused');
  const deadline = assessmentDeadline(options.deadlineMs);
  const listener = assessmentRequestListener(options, async (request) => {
    const authorizationCount = request.rawHeaders.filter(
      (value, index) => index % 2 === 0 && value.toLowerCase() === 'authorization',
    ).length;
    if (
      authorizationCount !== 1 ||
      request.headers.cookie ||
      request.headers['proxy-authorization']
    )
      throw new Error('Scheduler identity refused');
    // Cloud Run consumes X-Serverless-Authorization when both headers exist.
    // Only the independently signed Authorization value is trusted here.
    return (await options.identity.authorize(request.headers.authorization)).expiresAt;
  });
  const limits = { maxHeaderSize: 20480 };
  const server =
    options.tls === 'platform'
      ? createServer(limits, listener)
      : createTlsServer({ ...limits, ...options.tls }, listener);
  server.maxConnections = 8;
  server.maxHeadersCount = 16;
  server.headersTimeout = Math.min(5000, deadline);
  server.requestTimeout = deadline;
  server.keepAliveTimeout = 1;
  server.maxRequestsPerSocket = 1;
  server.on('clientError', (_error, socket) => socket.destroy());
  return server;
}
