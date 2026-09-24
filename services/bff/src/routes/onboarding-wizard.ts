import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { z } from 'zod';
import { createSupabaseAdmin } from '@axiom/supabase';
import { AdvanceOnboardingWizardRequestSchema, Capability } from '@axiom/types';
import { requireCapability } from '../middleware/authorize.js';
import type { Variables } from '../types.js';

const failures: Record<string, [400 | 403 | 404 | 409, string]> = {
  forbidden: [403, 'Your role cannot run onboarding for this organization.'],
  not_found: [404, 'That wizard, estate or system was not found in this organization.'],
  invalid_step: [400, 'Unknown onboarding step.'],
  invalid_payload: [400, 'Check the fields for this step.'],
  version_conflict: [409, 'This onboarding run changed. Refresh before continuing.'],
  wizard_completed: [409, 'This onboarding run is complete. Start a new run to re-onboard.'],
  step_out_of_order: [409, 'Complete the earlier steps first.'],
  estate_archived: [409, 'Choose an active estate.'],
  inventory_incomplete: [409, 'Declare at least one system, each with its data categories.'],
  connection_path_missing: [
    409,
    'Register a connector for each system or mark it as assessed with manual evidence.',
  ],
  confirmation_required: [400, 'Confirm this step explicitly.'],
  not_ready: [409, 'Readiness checks are not all met.'],
};
const unavailable = {
  error: { code: 'onboarding_unavailable', message: 'Retry this same request.' },
};

/**
 * C-W3-5 resumable onboarding. Records progress and confirmations only: it
 * never issues connector grants or credentials, and a registered connector is
 * reported as registered, not as a live connection.
 */
export function onboardingWizardRoutes(deps: { client?: typeof createSupabaseAdmin } = {}) {
  const app = new Hono<{ Variables: Variables }>();
  const db = () => (deps.client ?? createSupabaseAdmin)();

  app.get('/onboarding/wizard', async (c) => {
    const denied = requireCapability(c, Capability.POSTURE_READ);
    if (denied) return denied;
    const tenant = c.get('tenantId');
    // The open run if there is one, otherwise the most recent completed run.
    const { data, error } = await db()
      .from('tenant_onboarding_wizards')
      .select(
        'id,tenant_id,estate_id,status,completed_steps,manual_system_ids,version,started_by,completed_by,completed_at,readiness,created_at,updated_at',
      )
      .eq('tenant_id', tenant)
      .order('created_at', { ascending: false })
      .limit(5);
    if (error) return c.json(unavailable, 503);
    const run = data?.find((w) => w.status === 'in_progress') ?? data?.[0] ?? null;
    if (!run) return c.json({ data: null, readiness: null });
    if (run.status === 'completed') return c.json({ data: run, readiness: run.readiness });
    const live = await db().rpc('onboarding_wizard_readiness', {
      p_tenant_id: tenant,
      p_wizard_id: run.id,
    });
    if (live.error) return c.json(unavailable, 503);
    return c.json({ data: run, readiness: live.data });
  });

  app.post('/onboarding/wizard', async (c) => {
    const denied = requireCapability(c, Capability.ESTATE_MANAGE);
    if (denied) return denied;
    const { data, error } = await db().rpc('start_onboarding_wizard', {
      p_tenant_id: c.get('tenantId'),
      p_actor_id: c.get('user').id,
      p_correlation_id: randomUUID(),
    });
    if (error || !data) return c.json(unavailable, 503);
    if (data.error) {
      const failure = failures[String(data.error)];
      if (!failure) return c.json(unavailable, 503);
      return c.json({ error: { code: data.error, message: failure[1] } }, failure[0]);
    }
    return c.json({ data: data.resource, readiness: data.readiness }, data.created ? 201 : 200);
  });

  app.post('/onboarding/wizard/:id/steps', async (c) => {
    const denied =
      requireCapability(c, Capability.ESTATE_MANAGE) ??
      requireCapability(c, Capability.TENANT_SETTINGS_WRITE);
    if (denied) return denied;
    if (!z.uuid().safeParse(c.req.param('id')).success)
      return c.json({ error: { code: 'invalid_id' } }, 400);
    const parsed = AdvanceOnboardingWizardRequestSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success)
      return c.json(
        { error: { code: 'invalid_request', message: 'Check the fields for this step.' } },
        400,
      );
    const { step, expectedVersion, ...payload } = parsed.data;
    const { data, error } = await db().rpc('advance_onboarding_wizard', {
      p_tenant_id: c.get('tenantId'),
      p_actor_id: c.get('user').id,
      p_wizard_id: c.req.param('id'),
      p_step: step,
      p_expected_version: expectedVersion,
      p_payload: payload,
      p_correlation_id: randomUUID(),
    });
    if (error || !data) return c.json(unavailable, 503);
    if (data.error) {
      const code = String(data.error);
      const failure = failures[code];
      if (!failure) return c.json(unavailable, 503);
      return c.json(
        {
          error: {
            code,
            message: failure[1],
            ...(data.nextStep ? { nextStep: data.nextStep } : {}),
            ...(data.missing !== undefined ? { missing: data.missing } : {}),
            ...(data.readiness ? { readiness: data.readiness } : {}),
          },
        },
        failure[0],
      );
    }
    return c.json({ data: data.resource, readiness: data.readiness });
  });
  return app;
}
