/** Private loopback-only administrator transport. No CORS, browser session,
 * shared decoded-role authorization, or arbitrary backend RPC proxy. */
import { Hono } from 'hono';
import { getConnInfo } from '@hono/node-server/conninfo';
import { boundedJsonBody } from '../middleware/evidence-body-limit.js';
import { parsePrativedanAssessmentJson } from '../services/prativedan-assessment-json.js';
import type { OwnedDeploymentInstaller } from '../services/owned-deployment-installer.js';
import type { OwnedDeploymentOperatorAuth } from '../services/owned-deployment-operator.js';
export interface OwnedDeploymentPrivateDeps {
  auth: Pick<OwnedDeploymentOperatorAuth, 'authenticate'>;
  installer: Pick<
    OwnedDeploymentInstaller,
    | 'claim'
    | 'preflight'
    | 'authorize'
    | 'confirm'
    | 'unconfirmed'
    | 'issuerAuthorize'
    | 'issuerComplete'
  >;
}
export function ownedDeploymentPrivateRoutes(deps: OwnedDeploymentPrivateDeps | null = null) {
  const app = new Hono();
  app.use('*', boundedJsonBody(65536));
  app.use('*', async (c, next) => {
    c.header('Cache-Control', 'private, no-store');
    try {
      // Host headers/forwarded headers are not proof of local origin. Use the
      // actual accepted Node socket, whose peer is127.0.0.1 for fixed docker-exec.
      const remote = getConnInfo(c).remote.address;
      if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote ?? '')) throw Error();
      if (!deps) return c.json({ error: 'owned_deployment_unavailable' }, 503);
      if (
        ['Origin', 'Referer', 'Sec-Fetch-Site', 'Cookie', 'Authorization'].some((header) =>
          c.req.raw.headers.has(header),
        )
      )
        throw Error();
      if (
        c.req.method !== 'POST' ||
        c.req.header('Content-Type') !== 'application/json' ||
        new URL(c.req.url).search
      )
        throw Error();
      await deps.auth.authenticate(c.req.raw.headers);
      return next();
    } catch {
      return c.json({ error: 'owned_deployment_private_refused' }, 403);
    }
  });
  const raw = async (request: { text(): Promise<string> }) =>
    parsePrativedanAssessmentJson(await request.text());
  app.post('/tasks/claim', async (c) => {
    try {
      return c.json({ data: await deps!.installer.claim(await raw(c.req)) });
    } catch {
      return c.json({ error: 'owned_deployment_task_unconfirmed' }, 503);
    }
  });
  for (const phase of ['preflight', 'authorize', 'confirm', 'unconfirmed'] as const) {
    app.post('/tasks/:taskId/' + phase, async (c) => {
      try {
        return c.json({
          data: await deps!.installer[phase](c.req.param('taskId') ?? '', await raw(c.req)),
        });
      } catch {
        return c.json({ error: 'owned_deployment_task_unconfirmed' }, 503);
      }
    });
  }
  app.post('/credentials/authorize', async (c) => {
    try {
      return c.json({ data: await deps!.installer.issuerAuthorize(await raw(c.req)) });
    } catch {
      return c.json({ error: 'owned_deployment_credential_refused' }, 403);
    }
  });
  app.post('/credentials/complete', async (c) => {
    try {
      return c.json({ data: await deps!.installer.issuerComplete(await raw(c.req)) });
    } catch {
      return c.json({ error: 'owned_deployment_credential_unconfirmed' }, 503);
    }
  });
  return app;
}
