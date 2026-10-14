import { test, expect } from '@playwright/test';
import { registerWorkload, selectTenant, state, signInFreshOwner } from '../fixtures';

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
}, testInfo) => {
  const suffix = crypto.randomUUID().slice(0, 8);
  await signInFreshOwner(page, 'estate-graph.spec-1');
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
  let writeGrant = '';
  for (const [agent, scope] of [
    ['drishti', 'connector.read'],
    ['karya', 'connector.write'],
  ] as const) {
    const identity = await registerWorkload(agent, `graph-${suffix}`);
    const id = await service('connector_grants', {
      tenant_id: state.tenantA.id,
      connector_id: connectorId,
      workload_identity_id: identity,
      agent_name: agent,
      internal_scope: scope,
      expires_at: expires,
    });
    if (agent === 'karya') writeGrant = id;
  }

  await page.goto('/estate/graph');
  const graph = page.getByTestId('estate-graph');
  await graph.getByLabel('Estate filter', { exact: true }).selectOption({ label: estateName });
  await expect(graph.locator('[data-edge="read"]')).toHaveCount(1);
  await expect(graph.locator('[data-edge="write"]')).toHaveCount(1);
  await expect(graph.locator('[data-node="agent"]')).toHaveCount(12);
  await graph.getByRole('button', { name: 'agent Sudhaar' }).click();
  // The empty state describes the filtered view, not what the agent may do (W9).
  await expect(page.getByTestId('no-relationships')).toContainText('None in this view');
  await graph.getByRole('button', { name: 'Everything Karya can write to' }).click();
  await expect(graph.locator('[data-edge="read"]')).toHaveCount(0);
  await expect(graph.locator('[data-edge="write"]')).toHaveCount(1);
  await graph.getByRole('button', { name: `connector Graph reader ${suffix}` }).click();
  await expect(page.getByTestId('graph-detail')).toContainText('WRITE Karya');
  for (const [button, file] of [
    ['Export SVG', 'estate-graph.svg'],
    ['Export PNG', 'estate-graph.png'],
  ] as const) {
    const download = page.waitForEvent('download');
    await graph.getByRole('button', { name: button }).click();
    const artifact = await download;
    expect(artifact.suggestedFilename()).toBe(file);
    await artifact.saveAs(testInfo.outputPath(file));
    const stream = await artifact.createReadStream();
    expect(stream).not.toBeNull();
    const chunks: Buffer[] = [];
    for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
    const bytes = Buffer.concat(chunks);
    if (file.endsWith('.svg')) {
      const exported = await page.evaluate((source) => {
        const svg = new DOMParser().parseFromString(source, 'image/svg+xml');
        return {
          error: svg.querySelector('parsererror')?.textContent,
          text: svg.documentElement.textContent,
          writes: svg.querySelectorAll('[data-edge="write"]').length,
          reads: svg.querySelectorAll('[data-edge="read"]').length,
        };
      }, bytes.toString('utf8'));
      expect(exported.error).toBeUndefined();
      expect(exported.text).toContain('AXIOM PROOF');
      expect(exported.text).toContain(`View: ${estateName} · Karya · Write only`);
      expect(exported.text).toMatch(/Snapshot: \d{4}-\d{2}-\d{2}T/);
      expect(exported.text).toContain('Write grant');
      expect(exported.writes).toBe(1);
      expect(exported.reads).toBe(0);
    } else {
      const size = await page.evaluate(
        async (url) => {
          const image = new Image();
          await new Promise<void>((resolve, reject) => {
            image.onload = () => resolve();
            image.onerror = () => reject(new Error('PNG cannot be decoded'));
            image.src = url;
          });
          return { width: image.naturalWidth, height: image.naturalHeight };
        },
        `data:image/png;base64,${bytes.toString('base64')}`,
      );
      expect(size.width).toBe(2000);
      expect(size.height).toBeGreaterThan(400);
    }
  }
  const revoked = await fetch(`${state.supabaseUrl}/rest/v1/connector_grants?id=eq.${writeGrant}`, {
    method: 'PATCH',
    headers: {
      apikey: state.publishableKey,
      Authorization: `Bearer ${state.serviceKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ revoked_at: new Date().toISOString() }),
  });
  expect(revoked.status).toBe(204);
  await graph.getByRole('button', { name: 'Refresh graph' }).click();
  await expect(graph.locator('[data-edge="write"]')).toHaveCount(0);
  await expect(graph.getByLabel('Estate filter', { exact: true })).toHaveValue(estate.data.id);
  await expect(graph.getByLabel('Agent filter', { exact: true })).toHaveValue('karya');
});
