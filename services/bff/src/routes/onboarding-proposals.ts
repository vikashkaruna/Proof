import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { z } from 'zod';
import { createSupabaseAdmin } from '@axiom/supabase';
import {
  Capability,
  PrepareOnboardingProposalSchema,
  ReviewOnboardingProposalSchema,
} from '@axiom/types';
import { requireCapability } from '../middleware/authorize.js';
import type { Variables } from '../types.js';

const messages: Record<string, string> = {
  forbidden: 'Only client owners and admins can review staff proposals.',
  not_found: 'The proposal or estate was not found in this tenant.',
  no_intake: 'There is no retained onboarding intake.',
  proposal_exists: 'This intake already has a pending or approved proposal.',
  invalid_systems: 'Map every intake system to a valid inventory entry.',
  estate_archived: 'The estate is archived. Restore it before approval.',
  estate_changed: 'The estate changed after preparation. Reject and prepare a new proposal.',
  self_review: 'A proposal needs a different client owner or admin to review it.',
  already_reviewed: 'This proposal was already reviewed.',
  content_changed: 'The reviewed content does not match. Refresh the proposal.',
  source_changed: 'The source intake changed. Reject and prepare a new proposal.',
  invalid_review: 'Provide an approval or rejection reason.',
};
export function onboardingProposalRoutes() {
  const app = new Hono<{ Variables: Variables }>();
  app.get('/onboarding/proposals', async (c) => {
    const refused = requireCapability(c, Capability.POSTURE_READ);
    if (refused) return refused;
    const db = createSupabaseAdmin();
    const tenant = c.get('tenantId');
    const [intake, proposals] = await Promise.all([
      db.rpc('read_onboarding_inventory', { p_tenant_id: tenant }),
      db
        .from('onboarding_proposals')
        .select('*,onboarding_proposal_systems(source_index,system_id)')
        .eq('tenant_id', tenant)
        .order('created_at', { ascending: false }),
    ]);
    if (intake.error || proposals.error)
      return c.json({ error: { code: 'proposal_unavailable' } }, 503);
    return c.json({
      data: { intake: intake.data ?? [], proposals: proposals.data ?? [] },
    });
  });
  app.post('/onboarding/proposals', async (c) => {
    const refused = requireCapability(c, Capability.ONBOARDING_PREPARE);
    if (refused) return refused;
    const input = PrepareOnboardingProposalSchema.safeParse(await c.req.json().catch(() => null));
    if (!input.success)
      return c.json(
        {
          error: { code: 'invalid_request', message: 'Check the estate and all proposed systems.' },
        },
        400,
      );
    const { data, error } = await createSupabaseAdmin().rpc('prepare_onboarding_proposal', {
      p_tenant_id: c.get('tenantId'),
      p_actor_id: c.get('user').id,
      p_estate_id: input.data.estateId,
      p_systems: input.data.systems,
      p_correlation_id: randomUUID(),
    });
    if (error) return c.json({ error: { code: 'proposal_unavailable' } }, 503);
    if (data?.error) {
      const code = String(data.error);
      return c.json(
        { error: { code, message: messages[code] } },
        code === 'forbidden' ? 403 : code === 'not_found' ? 404 : 409,
      );
    }
    if (!data?.data) return c.json({ error: { code: 'proposal_unavailable' } }, 503);
    return c.json(data, 201);
  });
  app.post('/onboarding/proposals/:id/review', async (c) => {
    const refused = requireCapability(c, Capability.ONBOARDING_REVIEW);
    if (refused) return refused;
    const input = ReviewOnboardingProposalSchema.safeParse(await c.req.json().catch(() => null));
    if (!input.success || !z.uuid().safeParse(c.req.param('id')).success)
      return c.json(
        {
          error: {
            code: 'invalid_request',
            message: 'Confirm the proposal and provide a review reason.',
          },
        },
        400,
      );
    const { data, error } = await createSupabaseAdmin().rpc('review_onboarding_proposal', {
      p_tenant_id: c.get('tenantId'),
      p_actor_id: c.get('user').id,
      p_proposal_id: c.req.param('id'),
      p_content_sha256: input.data.contentSha256,
      p_decision: input.data.decision,
      p_reason: input.data.reason,
      p_correlation_id: randomUUID(),
    });
    if (error) return c.json({ error: { code: 'proposal_unavailable' } }, 503);
    if (data?.error) {
      const code = String(data.error);
      return c.json(
        { error: { code, message: messages[code] } },
        code === 'forbidden' || code === 'self_review' ? 403 : code === 'not_found' ? 404 : 409,
      );
    }
    if (!data?.data) return c.json({ error: { code: 'proposal_unavailable' } }, 503);
    return c.json(data);
  });
  return app;
}
