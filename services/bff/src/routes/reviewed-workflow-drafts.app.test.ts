import type * as ActualSupabase from '@axiom/supabase';
import { beforeEach, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { canonicalJson, sha256 } from '@axiom/ledger';
import { UserRole } from '@axiom/types';
import type { Variables } from '../types.js';
const state = vi.hoisted(() => {
  Object.assign(process.env, {
    ENVIRONMENT: 'test',
    AXIOM_AUTH_MODE: 'strict',
    SUPABASE_URL: 'http://localhost:55321',
    SUPABASE_ANON_KEY: 'a'.repeat(40),
    SUPABASE_SERVICE_KEY: 'b'.repeat(40),
    APPROVAL_SIGNING_KEY: 'k'.repeat(48),
  });
  return {
    role: 'owner',
    killed: false,
    sourceCurrent: true,
    mfaRequired: false,
    domainRpc: vi.fn(),
    cacheRpc: vi.fn(),
    cache: null as null | { status: number; body: unknown; request: string; authority: string },
    claim: null as null | { request: string; authority: string },
  };
});
vi.mock('../middleware/auth.js', async () => {
  const { createMiddleware } = await import('hono/factory');
  return {
    authMiddleware: createMiddleware<{ Variables: Variables }>(async (c, next) => {
      c.set('user', { id: '77777777-7777-4777-8777-777777777777' } as never);
      c.set('sessionId', 'same-session');
      await next();
    }),
  };
});
vi.mock('../middleware/tenant.js', async () => {
  const { createMiddleware } = await import('hono/factory');
  return {
    tenantResolver: createMiddleware<{ Variables: Variables }>(async (c, next) => {
      c.set('tenantId', 'a0000000-0000-4000-8000-000000000001');
      c.set('role', state.role as UserRole);
      c.set('approvalScopes', []);
      await next();
    }),
  };
});
vi.mock('../services/kill-switch.js', () => ({
  createKillSwitchService: () => ({ isActive: async () => state.killed }),
}));
vi.mock('../services/approval.js', () => ({ createApprovalEngine: () => ({}) }));
vi.mock('../services/ledger.js', () => ({ createLedgerService: () => ({}) }));
vi.mock('../services/mfa.js', () => ({
  createMfaService: () => ({
    requiresLoginMfa: async () => state.mfaRequired,
    isEnrolled: async () => false,
  }),
}));
vi.mock('@supabase/supabase-js', () => ({ createClient: () => ({ rpc: state.cacheRpc }) }));
vi.mock('@axiom/supabase', async (importOriginal) => ({
  ...(await importOriginal<typeof ActualSupabase>()),
  createHumanActionWriter: () => ({
    rpc: (...args: unknown[]) => {
      const pending = state.domainRpc(...args) as Promise<unknown> & {
        abortSignal?: (signal: AbortSignal) => Promise<unknown>;
      };
      pending.abortSignal = () => pending;
      return pending;
    },
  }),
}));
import { createApp } from '../app.js';
const fixture = JSON.parse(
  readFileSync('../../packages/types/src/__fixtures__/reviewed-workflow-drafts.json', 'utf8'),
);
const input = fixture.input,
  output = fixture.output,
  actor = '77777777-7777-4777-8777-777777777777',
  key = '88888888-8888-4888-8888-888888888888',
  run = '99999999-9999-4999-8999-999999999999',
  ackKey = '60000000-0000-4000-8000-000000000006';
const selection = () => ({
  engagementId: input.engagement_id,
  recordIds: input.records.map((r: { id: string }) => r.id),
  sourceDigest: input.source_records_sha256,
});
let inputHash: string,
  outputHash: string,
  ackBody: {
    runId: string;
    outputHash: string;
    policyIndex: null;
    reason: string;
    confirmReview: true;
  };
function body(path: string) {
  return path.includes('acknowledgements')
    ? { ...selection(), originalOperationKey: key, operationKey: ackKey, acknowledgement: ackBody }
    : { ...selection(), operationKey: key, confirmSourceReview: true };
}
function request(
  app: ReturnType<typeof createApp>,
  path: string,
  options: { actor?: string; headerKey?: string | null; method?: string; payload?: unknown } = {},
) {
  return app.request(path, {
    method: options.method ?? 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Expected-Actor-Id': options.actor ?? actor,
      ...(options.headerKey === null
        ? {}
        : {
            'Idempotency-Key':
              options.headerKey ?? (path.includes('acknowledgements') ? ackKey : key),
          }),
    },
    body: JSON.stringify(options.payload ?? body(path)),
  });
}
beforeEach(async () => {
  inputHash = await sha256(canonicalJson(input));
  outputHash = await sha256(canonicalJson(output));
  ackBody = {
    runId: run,
    outputHash,
    policyIndex: null,
    reason: 'Reviewed genuine retained unknowns; no policy publication',
    confirmReview: true,
  };
  state.role = 'owner';
  state.killed = false;
  state.sourceCurrent = true;
  state.mfaRequired = false;
  state.cache = null;
  state.claim = null;
  state.cacheRpc.mockReset();
  state.domainRpc.mockReset();
  state.domainRpc.mockImplementation(async (name: string, args: Record<string, unknown>) => {
    if (name === 'read_reviewed_workflow_sources')
      return {
        data: state.sourceCurrent
          ? { records: input.records }
          : { error: 'source_context_refused' },
        error: null,
      };
    if (name === 'recover_reviewed_workflow_output')
      return {
        data: {
          run_id: run,
          input_hash: inputHash,
          output_hash: outputHash,
          output_text: canonicalJson(output),
          requested_receipt: '1',
          started_receipt: '2',
          completed_receipt: '3',
          settled_receipt: '4',
        },
        error: null,
      };
    if (name === 'acknowledge_reviewed_workflow_output')
      return {
        data: {
          acknowledgement_id: ackKey,
          receipt_id: '5',
          policy_draft_id: null,
          replayed: true,
          manifest: {
            kind: 'reviewed_workflow_acknowledgement_recorded',
            tenantId: input.tenant_id,
            actorId: actor,
            operationKey: ackKey,
            originalOperationKey: key,
            runId: run,
            inputHash,
            outputHash,
            sourceDigest: input.source_records_sha256,
            bodyHash: await sha256(String(args.p_body_text)),
            acknowledgementId: ackKey,
            receiptId: '5',
            policyIndex: null,
            policyDraftId: null,
            policyReceipt: null,
            initialPolicyStatus: null,
            currentPolicyStatus: null,
            requestedReceipt: '1',
            startedReceipt: '2',
            completedReceipt: '3',
            settledReceipt: '4',
          },
        },
        error: null,
      };
    throw new Error('Unexpected scoped domain RPC ' + name);
  });
  state.cacheRpc.mockImplementation(async (name: string, args: Record<string, unknown>) => {
    if (name === 'claim_request') {
      if (state.cache) {
        if (
          state.cache.request !== args.p_request_sha256 ||
          state.cache.authority !== args.p_authority_sha256
        )
          return { data: { decision: 'conflict' }, error: null };
        return {
          data: { decision: 'replay', status: state.cache.status, body: state.cache.body },
          error: null,
        };
      }
      state.claim = {
        request: String(args.p_request_sha256),
        authority: String(args.p_authority_sha256),
      };
      return { data: { decision: 'claimed', id: key }, error: null };
    }
    if (name === 'complete_request') {
      state.cache = {
        status: Number(args.p_status),
        body: args.p_body,
        request: state.claim!.request,
        authority: state.claim!.authority,
      };
      return { data: true, error: null };
    }
    throw new Error('Unexpected generic cache RPC ' + name);
  });
});
it.each(['/v1/reviewed-workflows/runs', '/v1/reviewed-workflows/acknowledgements'])(
  'actual createApp %s refuses wrong actor without poisoning same key and rechecks live source/role/kill',
  async (path) => {
    const app = createApp();
    expect((await request(app, path, { actor: run })).status).toBe(409);
    expect(state.domainRpc).not.toHaveBeenCalled();
    const first = await request(app, path);
    expect(first.status).toBe(200);
    expect(first.headers.get('cache-control')).toBe('private, no-store');
    const second = await request(app, path);
    expect(second.status).toBe(200);
    expect(second.headers.get('idempotency-replayed')).toBeNull();
    state.killed = true;
    expect((await request(app, path)).status).toBe(423);
    state.killed = false;
    state.sourceCurrent = false;
    expect((await request(app, path)).status).toBe(409);
    state.sourceCurrent = true;
    state.role = 'viewer';
    expect((await request(app, path)).status).toBe(403);
    expect(state.cacheRpc).not.toHaveBeenCalled();
    expect(
      state.domainRpc.mock.calls.filter((call) => call[0] === 'read_reviewed_workflow_sources'),
    ).toHaveLength(3);
  },
);
it.each(['/v1/reviewed-workflows/runs', '/v1/reviewed-workflows/acknowledgements'])(
  'actual createApp %s preserves MFA and strict original key/body gates',
  async (path) => {
    const app = createApp();
    state.mfaRequired = true;
    expect((await request(app, path)).status).toBe(403);
    state.mfaRequired = false;
    expect((await request(app, path, { headerKey: null })).status).toBe(400);
    expect((await request(app, path, { headerKey: 'not-a-uuid' })).status).toBe(400);
    expect((await request(app, path, { headerKey: run })).status).toBe(400);
    expect(state.domainRpc).not.toHaveBeenCalled();
    expect(state.cacheRpc).not.toHaveBeenCalled();
  },
);
it.each([
  ['POST', '/v1/reviewed-workflows/runs-extra'],
  ['POST', '/v1/reviewed-workflows/runs/extra'],
  ['POST', '/v1/reviewed-workflows/acknowledgements-extra'],
  ['POST', '/v1/reviewed-workflows/acknowledgements/extra'],
  ['PUT', '/v1/reviewed-workflows/runs'],
  ['PUT', '/v1/reviewed-workflows/acknowledgements'],
])('neighboring %s %s retains generic idempotency middleware', async (method, path) => {
  const app = createApp();
  await request(app, path, { method });
  expect(state.cacheRpc).toHaveBeenCalledWith('claim_request', expect.any(Object));
  expect(state.cacheRpc).toHaveBeenCalledWith('complete_request', expect.any(Object));
  expect(state.domainRpc).not.toHaveBeenCalled();
});
