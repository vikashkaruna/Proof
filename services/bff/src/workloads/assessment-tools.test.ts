import { createHash } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';
import { AssessmentTools } from './assessment-tools.js';
import type { AuthorizedTask } from './tasks.js';
import { workloadToolsRoutes } from '../routes/workload-tools.js';
const id = (n: number) => `50500000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const proof = Buffer.alloc(32, 9).toString('base64url');
const authorization = {
  tenantId: id(1),
  runId: id(2),
  taskProof: proof,
  workloadProof: 'private-svid',
};
const task: AuthorizedTask = {
  tenantId: id(1),
  runId: id(2),
  workloadId: id(3),
  agentName: 'parikshan',
  createdBy: id(4),
  estateId: null,
  engagementId: id(5),
  correlationId: id(6),
  inputHash: 'a'.repeat(64),
  spiffeId: 'spiffe://local.axiomproof.test/agent/parikshan',
  trustDomain: 'local.axiomproof.test',
  audience: 'axiom-assessment-tools',
  bundleRevision: 'live',
  expiresAt: Date.now() + 60000,
  declaredScopes: ['control_library.read', 'findings.write'],
  grantedScopes: ['control_library.read', 'findings.write'],
};
const packet = {
  engagement_id: id(5),
  library_version: 'test',
  library_digest: 'b'.repeat(64),
  controls: [{ id: 'test' }],
  started_receipt: '1',
};
const receipt = { completed_receipt: '2', result_digest: 'c'.repeat(64) };
const result = {
  library_version: 'test',
  posture_score: 0,
  estimated_exposure_inr: 1000000,
  findings: [{ control_id: 'test', score: 0, risk_points: 1, rationale: 'Test' }],
};
function fixture(reply: unknown = packet) {
  const authorize = vi.fn(async () => task);
  const fetcher = vi.fn<typeof fetch>(
    async () =>
      new Response(JSON.stringify(reply), { headers: { 'content-type': 'application/json' } }),
  );
  const db = createClient('https://db.test.invalid', 'private-service-key', {
    global: { fetch: fetcher },
    auth: { persistSession: false },
  });
  const tools = new AssessmentTools({ authorize }, db);
  return { authorize, fetcher, tools, router: workloadToolsRoutes(tools) };
}
describe('fixed workload assessment tools', () => {
  it('binds start to verified task, hashes the private proof and forwards the identity deadline', async () => {
    const f = fixture();
    expect(await f.tools.start({ authorization, inputHash: task.inputHash })).toEqual(packet);
    expect(f.authorize).toHaveBeenCalledWith(
      { ...authorization, agentName: 'parikshan' },
      'control_library.read',
    );
    const args = JSON.parse(String(f.fetcher.mock.calls[0]![1]!.body));
    expect(args).toEqual({
      p_tenant_id: task.tenantId,
      p_run_id: task.runId,
      p_workload_id: task.workloadId,
      p_proof_hash: createHash('sha256').update(proof).digest('hex'),
      p_identity_expires_at: new Date(task.expiresAt).toISOString(),
      p_input_hash: task.inputHash,
    });
    expect(JSON.stringify(args)).not.toContain(proof);
  });
  it('reauthenticates for write and preserves zero scores', async () => {
    const f = fixture(receipt);
    expect(
      await f.tools.complete({ authorization, libraryDigest: packet.library_digest, result }),
    ).toEqual(receipt);
    expect(f.authorize).toHaveBeenCalledWith(
      { ...authorization, agentName: 'parikshan' },
      'findings.write',
    );
    expect(JSON.parse(String(f.fetcher.mock.calls[0]![1]!.body)).p_result.findings[0].score).toBe(
      0,
    );
  });
  it.each([
    { inputHash: 'c'.repeat(64) },
    { inputHash: task.inputHash, agentName: 'karya' },
    { inputHash: task.inputHash, tenantId: id(7) },
  ])('refuses wrong input or caller-selected context before database access', async (extra) => {
    const f = fixture();
    await expect(f.tools.start({ authorization, ...extra })).rejects.toThrow(
      'Workload task authority was refused.',
    );
    expect(f.fetcher).not.toHaveBeenCalled();
  });
  it.each([null, { error: 'task_refused' }, { ...packet, engagement_id: id(8) }])(
    'refuses malformed or foreign database packets',
    async (reply) => {
      await expect(
        fixture(reply).tools.start({ authorization, inputHash: task.inputHash }),
      ).rejects.toThrow('Workload task authority was refused.');
    },
  );
  it('refuses expired authority before a write', async () => {
    const f = fixture();
    f.authorize.mockResolvedValue({ ...task, expiresAt: Date.now() - 1 });
    await expect(
      f.tools.complete({ authorization, libraryDigest: packet.library_digest, result }),
    ).rejects.toThrow();
    expect(f.fetcher).not.toHaveBeenCalled();
  });
  it('does not reveal private adapter failures over the route', async () => {
    const f = fixture();
    f.authorize.mockRejectedValue(new Error('private-service-key private-svid'));
    const response = await f.router.request('/assessment/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ authorization, inputHash: task.inputHash }),
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'tool_refused' });
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(f.fetcher).not.toHaveBeenCalled();
  });
  it('denies ordinary startup even with browser or legacy bearer headers', async () => {
    const router = workloadToolsRoutes();
    for (const token of ['human-session', 'legacy-shared-token']) {
      const response = await router.request('/assessment/start', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.status).toBe(503);
    }
  });
  it('bounds request size and refuses query-supplied authority', async () => {
    const f = fixture();
    expect(
      (await f.router.request('/assessment/start', { method: 'POST', body: 'x'.repeat(1048577) }))
        .status,
    ).toBe(413);
    expect(
      (
        await f.router.request('/assessment/start?taskProof=private', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        })
      ).status,
    ).toBe(403);
    expect(f.authorize).not.toHaveBeenCalled();
  });
});
