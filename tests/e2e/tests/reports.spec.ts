import { test, expect } from '@playwright/test';
import { createMfaAccount, state } from '../fixtures';

// The old synthetic custom-report producer asserted a human/agent proof claim
// from caller-supplied text. It is intentionally unavailable to service_role.
// Real review, release, exact-content, XSS and revocation journeys live in
// board-reports-provider.spec.ts, where a finalized assessment and retained
// provider versions are required.
test('shared service credentials cannot manufacture a report draft', async () => {
  const manager = await createMfaAccount('report-denied-manager', { role: 'admin' });
  const operationKey = crypto.randomUUID();
  const response = await fetch(`${state.supabaseUrl}/rest/v1/rpc/record_report_draft`, {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
    headers: {
      apikey: state.publishableKey,
      authorization: `Bearer ${state.serviceKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      p_tenant_id: state.tenantA.id,
      p_actor_id: manager.id,
      p_operation_key: operationKey,
      p_kind: 'custom',
      p_title: `Forbidden synthetic report ${operationKey}`,
      p_engagement_id: state.engagementA,
      p_library_version: null,
      p_content_text: JSON.stringify({ statement: 'Unverified synthetic report' }),
      p_generated_by_agent: 'synthetic-browser-fixture',
      p_correlation_id: crypto.randomUUID(),
    }),
  });
  expect(response.status).toBe(403);
  const lookup = await fetch(
    `${state.supabaseUrl}/rest/v1/reports?operation_key=eq.${operationKey}&select=id`,
    {
      signal: AbortSignal.timeout(30_000),
      headers: {
        apikey: state.publishableKey,
        authorization: `Bearer ${state.serviceKey}`,
      },
    },
  );
  expect(lookup.status).toBe(200);
  expect(await lookup.json()).toEqual([]);
});
