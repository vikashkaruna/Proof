/** Normal human Auth/session/tenant middleware must precede this router. */
import { Hono } from 'hono';
import { z } from 'zod';
import {
  Capability,
  ownedDeploymentRequest,
  ownedDeploymentPreflight,
  ownedDeploymentMfaEnvelope,
  ownedDeploymentFence,
  ownedDeploymentInstall,
  ownedDeploymentList,
  ownedDeploymentOptions,
  ownedDeploymentResult,
  ownedDeploymentChallenge,
  ownedDeploymentVerified,
  ownedDeploymentFenceResult,
  ownedDeploymentOperationReadback,
} from '@axiom/types';
import { requireCapability } from '../middleware/authorize.js';
import { boundedJsonBody } from '../middleware/evidence-body-limit.js';
import type { Variables } from '../types.js';
import type { OwnedDeploymentController } from '../services/owned-deployment-controller.js';
import type { OwnedDeploymentHuman } from '../services/owned-deployment-approval.js';
const uuid = z.uuid();
export type OwnedDeploymentRouteController = Pick<
  OwnedDeploymentController,
  'list' | 'options' | 'request' | 'preflight' | 'fence' | 'readOperation' | 'mfa' | 'install'
>;
export function ownedDeploymentRoutes(controller: OwnedDeploymentRouteController | null = null) {
  const app = new Hono<{ Variables: Variables }>();
  app.use('*', boundedJsonBody(16384));
  app.use('*', async (c, next) => {
    c.header('Cache-Control', 'private, no-store');
    if (
      !uuid.safeParse(c.get('tenantId')).success ||
      !uuid.safeParse(c.get('user')?.id).success ||
      !uuid.safeParse(c.get('sessionId')).success
    )
      return c.json(
        {
          error: {
            code: 'owned_deployment_forbidden',
            message: 'A current authenticated session is required.',
          },
        },
        403,
      );
    for (const capability of [Capability.PLAN_CREATE, Capability.PLAN_EXECUTE]) {
      const denied = requireCapability(c, capability);
      if (denied) return denied;
    }
    if (c.req.header('X-Expected-Actor-Id') !== c.get('user').id)
      return c.json(
        { error: { code: 'owned_deployment_forbidden', message: 'The current account changed.' } },
        409,
      );
    if ([...new URL(c.req.url).searchParams].length)
      return c.json(
        { error: { code: 'owned_deployment_invalid', message: 'Unexpected query parameters.' } },
        400,
      );
    if (!controller)
      return c.json(
        {
          error: {
            code: 'owned_deployment_unavailable',
            message: 'Local synthetic enrollment is not configured.',
          },
        },
        503,
      );
    return next();
  });
  const context = (tenantId: string, actorId: string, sessionId: string): OwnedDeploymentHuman => ({
    tenantId,
    actorId,
    sessionId,
    expectedActorId: actorId,
  });
  app.get('/', async (c) => {
    try {
      return c.json(
        ownedDeploymentList.parse({
          data: await controller!.list(
            context(c.get('tenantId'), c.get('user').id, c.get('sessionId')),
          ),
        }),
      );
    } catch {
      return c.json(
        {
          error: {
            code: 'owned_deployment_unconfirmed',
            message: 'Enrollment state could not be confirmed.',
          },
        },
        503,
      );
    }
  });
  app.get('/options/:engagementId', async (c) => {
    try {
      return c.json(
        ownedDeploymentOptions.parse({
          data: await controller!.options(
            context(c.get('tenantId'), c.get('user').id, c.get('sessionId')),
            uuid.parse(c.req.param('engagementId')),
          ),
        }),
      );
    } catch {
      return c.json(
        {
          error: {
            code: 'owned_deployment_unavailable',
            message: 'Reviewed deployment options are unavailable.',
          },
        },
        503,
      );
    }
  });
  app.get('/:requestId/operations/:phase/:operationKey', async (c) => {
    try {
      return c.json(
        ownedDeploymentOperationReadback.parse(
          await controller!.readOperation(
            context(c.get('tenantId'), c.get('user').id, c.get('sessionId')),
            uuid.parse(c.req.param('requestId')),
            c.req.param('phase'),
            uuid.parse(c.req.param('operationKey')),
          ),
        ),
      );
    } catch {
      return c.json(
        {
          error: {
            code: 'owned_deployment_unconfirmed',
            message: 'The original operation outcome could not be confirmed.',
          },
        },
        503,
      );
    }
  });
  app.get('/:requestId', async (c) => {
    try {
      const rows = await controller!.list(
        context(c.get('tenantId'), c.get('user').id, c.get('sessionId')),
        uuid.parse(c.req.param('requestId')),
      );
      if (rows.length !== 1)
        return c.json(
          { error: { code: 'owned_deployment_unavailable', message: 'Enrollment was not found.' } },
          404,
        );
      return c.json(ownedDeploymentResult.parse({ data: rows[0] }));
    } catch {
      return c.json(
        {
          error: {
            code: 'owned_deployment_unconfirmed',
            message: 'Enrollment state could not be confirmed.',
          },
        },
        503,
      );
    }
  });
  for (const phase of [
    'request',
    'preflight',
    'challenge',
    'verify',
    'approve',
    'install',
    'fence-intent',
  ] as const) {
    app.post(phase === 'request' ? '/' : `/:requestId/${phase}`, async (c) => {
      let body: unknown;
      try {
        body = JSON.parse(await c.req.text());
      } catch {
        return c.json(
          { error: { code: 'owned_deployment_invalid', message: 'The request body is invalid.' } },
          400,
        );
      }
      const schema =
        phase === 'request'
          ? ownedDeploymentRequest
          : phase === 'preflight'
            ? ownedDeploymentPreflight
            : phase === 'install'
              ? ownedDeploymentInstall
              : phase === 'fence-intent'
                ? ownedDeploymentFence
                : ownedDeploymentMfaEnvelope;
      const parsed = schema.safeParse(body);
      if (!parsed.success)
        return c.json(
          {
            error: {
              code: 'owned_deployment_invalid',
              message: 'The request does not match the reviewed operation.',
            },
          },
          400,
        );
      const operationKey =
        'request' in parsed.data ? parsed.data.request.operationKey : parsed.data.operationKey;
      if (c.req.header('Idempotency-Key') !== operationKey)
        return c.json(
          {
            error: {
              code: 'owned_deployment_invalid',
              message: 'The operation key does not match the request.',
            },
          },
          400,
        );
      const ctx = context(c.get('tenantId'), c.get('user').id, c.get('sessionId'));
      try {
        if (phase === 'request')
          return c.json(
            ownedDeploymentResult.parse({ data: await controller!.request(ctx, parsed.data) }),
            201,
          );
        const requestId = uuid.parse(c.req.param('requestId'));
        if (phase === 'preflight')
          return c.json(
            ownedDeploymentResult.parse({
              data: await controller!.preflight(ctx, requestId, parsed.data),
            }),
            202,
          );
        if (phase === 'install')
          return c.json(
            ownedDeploymentResult.parse({
              data: await controller!.install(ctx, requestId, parsed.data),
            }),
            202,
          );
        if (phase === 'fence-intent')
          return c.json(
            ownedDeploymentFenceResult.parse({
              data: await controller!.fence(ctx, requestId, parsed.data),
            }),
          );
        const result = await controller!.mfa(ctx, requestId, phase, parsed.data);
        return c.json(
          (phase === 'challenge'
            ? ownedDeploymentChallenge
            : phase === 'verify'
              ? ownedDeploymentVerified
              : ownedDeploymentResult
          ).parse(result),
        );
      } catch {
        return c.json(
          {
            error: {
              code: 'owned_deployment_unconfirmed',
              message:
                'The operation outcome is unconfirmed. Recover its exact recorded receipt before continuing.',
            },
          },
          503,
        );
      }
    });
  }
  return app;
}
