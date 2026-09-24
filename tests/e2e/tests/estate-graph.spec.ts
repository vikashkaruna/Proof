import { test, expect } from '@playwright/test';
import { registerWorkload, selectTenant, signIn, state } from '../fixtures';

// W3.5: access edges come only from active grants; Sudhaar has none, and the
// Karya write view shows write authority alone. Grants are seeded directly:
// the reference fixture connector is not a production binding, so the
// issuance RPC would (correctly) refuse the Karya write grant.

async function service(path: string, row: Record<string, unknown>) {
  const res = await fetch(`${state.supabaseUrl}/rest/v1/${path}`, {
    method: 'POST',
    headers: {
      apikey: state.publishableKey,
      Authorization: `Bearer ${state.serviceKey}`,
      'content-type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify(row),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: string }[])[0]!.id;
}

test('the estate graph derives agent access from grants and isolates Karya write authority', async ({
  page,
}) => {
  const suffix = crypto.randomUUID().slice(0, 8);
  await signIn(page, 'owner');
  await selectTenant(page, 'a');
  const estateName = `Graph estate ${suffix}`;
  const estate = (await (
    await page.request.post('/api/bff/v1/estates', {
      data: { name: estateName, slug: `graph-${suffix}` },
    })
  ).json()) as { data: { id: string } };
  const system = (await (
    await page.request.post(`/api/bff/v1/estates/${estate.data.id}/systems`, {
      data: { name: `Graph CRM ${suffix}`, systemKind: 'saas', dataCategories: ['contact'] },
    })
  ).json()) as { data: { id: string } };
  const created = await page.request.post('/api/bff/v1/connectors', {
    data: {
      systemId: system.data.id,
      descriptorId: '41410000-0000-4000-8000-000000000002',
      name: `Graph reader ${suffix}`,
      endpointRef: `graph_${suffix}`,
    },
  });
  expect(created.status()).toBe(201);
  const connectorId = ((await created.json()) as { data: { id: string } }).data.id;
  const expires = new Date(Date.now() + 30 * 86_400_000).toISOString();
  for (const [agent, scope] of [
    ['drishti', 'connector.read'],
    ['karya', 'connector.write'],
  ] as const) {
    const identity = await registerWorkload(agent, `graph-${suffix}`);
    await service('connector_grants', {
      tenant_id: state.tenantA.id,
      connector_id: connectorId,
      workload_identity_id: identity,
      agent_name: agent,
      internal_scope: scope,
      expires_at: expires,
    });
  }

  await page.goto('/estate/graph');
  const graph = page.getByTestId('estate-graph');
  await graph.getByLabel('Estate').selectOption({ label: estateName });
  await expect(graph.locator('[data-edge="read"]')).toHaveCount(1);
  await expect(graph.locator('[data-edge="write"]')).toHaveCount(1);
  await expect(graph.locator('[data-node="agent"]')).toHaveCount(10);
  await graph.getByRole('button', { name: 'agent Sudhaar' }).click();
  await expect(page.getByTestId('no-relationships')).toContainText('holds no client-system access');
  await graph.getByRole('button', { name: 'Everything Karya can write to' }).click();
  await expect(graph.locator('[data-edge="read"]')).toHaveCount(0);
  await expect(graph.locator('[data-edge="write"]')).toHaveCount(1);
  await graph.getByRole('button', { name: `connector Graph reader ${suffix}` }).click();
  await expect(page.getByTestId('graph-detail')).toContainText('WRITE Karya');
});
