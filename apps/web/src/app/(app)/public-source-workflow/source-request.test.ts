// @vitest-environment jsdom
import { webcrypto } from 'node:crypto';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { canonicalJson, sha256 } from '@axiom/ledger';
import {
  SourceWorkflowError,
  clearSourceOperation,
  loadSourceOperation,
  operationStorageKey,
  saveSourceOperation,
  sourceOperationSchema,
  sourceRequest,
  validateSourceObservation,
} from './source-request';
const TENANT = '11111111-1111-4111-8111-111111111111',
  ACTOR = '22222222-2222-4222-8222-222222222222',
  ENGAGEMENT = '33333333-3333-4333-8333-333333333333',
  CHECK = '44444444-4444-4444-8444-444444444444',
  BINDING = '55555555-5555-4555-8555-555555555555',
  KEY = '66666666-6666-4666-8666-666666666666';
const digest = 'a'.repeat(64);
function operation() {
  return sourceOperationSchema.parse({
    tenantId: TENANT,
    actorId: ACTOR,
    operationKey: KEY,
    kind: 'drishti',
    engagementId: ENGAGEMENT,
    checkId: CHECK,
    bindingId: BINDING,
    rootSha256: digest,
    projectionSha256: digest,
    bodyUtf8: JSON.stringify({ engagementId: ENGAGEMENT, expectedProjectionSha256: digest }),
  });
}
beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal('crypto', webcrypto);
});
afterEach(() => vi.unstubAllGlobals());
it('retains exact body and key across reload in only its actor and tenant namespace', () => {
  const op = operation();
  saveSourceOperation(localStorage, op);
  expect(loadSourceOperation(localStorage, TENANT, ACTOR)).toEqual(op);
  expect(loadSourceOperation(localStorage, TENANT, KEY)).toBeNull();
  expect(loadSourceOperation(localStorage, KEY, ACTOR)).toBeNull();
});
it.each(['engagement', 'projection', 'observation', 'bytes', 'binding', 'actor'])(
  'rejects inconsistent retained operation %s',
  (kind) => {
    const op = operation();
    const changed = {
      ...op,
      ...(kind === 'engagement'
        ? { engagementId: KEY }
        : kind === 'projection'
          ? { projectionSha256: 'b'.repeat(64) }
          : kind === 'observation'
            ? {
                bodyUtf8: JSON.stringify({
                  engagementId: ENGAGEMENT,
                  expectedProjectionSha256: digest,
                  observationId: KEY,
                }),
              }
            : kind === 'bytes'
              ? { bodyUtf8: op.bodyUtf8 + ' ' }
              : kind === 'binding'
                ? { bindingId: null }
                : { actorId: 'private-user' }),
    };
    expect(sourceOperationSchema.safeParse(changed).success).toBe(false);
  },
);
it('never overwrites another outstanding request from a separate tab', () => {
  const op = operation();
  saveSourceOperation(localStorage, op);
  expect(() => saveSourceOperation(localStorage, { ...op, operationKey: BINDING })).toThrow(
    /Reconcile/,
  );
  expect(loadSourceOperation(localStorage, TENANT, ACTOR)).toEqual(op);
});
it('refuses storage acknowledgement failure before a dispatch can use the operation', () => {
  expect(() =>
    saveSourceOperation(
      { setItem: () => undefined, getItem: () => null } as unknown as Storage,
      operation(),
    ),
  ).toThrow(/retain/);
});
it('does not clear an operation replaced by another scope or key', () => {
  const op = operation();
  saveSourceOperation(localStorage, op);
  expect(() => clearSourceOperation(localStorage, { ...op, operationKey: BINDING })).toThrow(
    /replaced/,
  );
  expect(loadSourceOperation(localStorage, TENANT, ACTOR)).toEqual(op);
  clearSourceOperation(localStorage, op);
  expect(loadSourceOperation(localStorage, TENANT, ACTOR)).toBeNull();
});
it('rejects a foreign identity in its own journal namespace', () => {
  localStorage.setItem(
    operationStorageKey(TENANT, ACTOR),
    JSON.stringify({ ...operation(), actorId: KEY }),
  );
  expect(() => loadSourceOperation(localStorage, TENANT, ACTOR)).toThrow(/another session/);
});
it('keeps exact idempotency bytes on explicit attempts and never auto retries an interrupted response', async () => {
  const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error('private-token'));
  vi.stubGlobal('fetch', fetcher);
  const op = operation(),
    path = `/public-source-bindings/${BINDING}/agents/drishti/run`;
  await expect(sourceRequest(TENANT, path, { operation: op })).rejects.toThrow(/Reconcile/);
  expect(fetcher).toHaveBeenCalledTimes(1);
  await expect(sourceRequest(TENANT, path, { operation: op })).rejects.toThrow(/Reconcile/);
  expect(fetcher).toHaveBeenCalledTimes(2);
  for (const [url, init] of fetcher.mock.calls) {
    expect(url).toBe(`/api/bff/v1${path}`);
    expect(init!.body).toBe(op.bodyUtf8);
    expect(new Headers(init!.headers).get('Idempotency-Key')).toBe(KEY);
  }
});
it('refuses foreign tenant and path override before any POST', async () => {
  const fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  await expect(
    sourceRequest(KEY, `/public-source-bindings/${BINDING}/agents/drishti/run`, {
      operation: operation(),
    }),
  ).rejects.toThrow(/scope/);
  await expect(
    sourceRequest(TENANT, '/public-source-bindings', { operation: operation() }),
  ).rejects.toThrow(/scope/);
  await expect(sourceRequest(TENANT, 'https://foreign.invalid')).rejects.toThrow(/path/);
  expect(fetcher).not.toHaveBeenCalled();
});
it('sends a retained request key only in the reconciliation header, never a fresh mutation header', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ data: {} }));
  vi.stubGlobal('fetch', fetcher);
  await sourceRequest(TENANT, '/public-source/request?engagementId=' + ENGAGEMENT, {
    requestKey: KEY,
  });
  const [url, init] = fetcher.mock.calls[0]!;
  expect(String(url)).not.toContain(KEY);
  expect(init!.method).toBe('GET');
  expect(new Headers(init!.headers).get('X-Public-Source-Request-Key')).toBe(KEY);
  expect(new Headers(init!.headers).has('Idempotency-Key')).toBe(false);
});
it('does not expose raw response errors or transport credentials', async () => {
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValue(Response.json({ error: { message: 'private-token' } }, { status: 409 })),
  );
  await expect(
    sourceRequest(TENANT, `/public-source-bindings/${BINDING}/agents/drishti/run`, {
      operation: operation(),
    }),
  ).rejects.toThrow(
    'The action was not confirmed. Reconcile the retained request before continuing.',
  );
});
async function result() {
  const source = {
    tenant_id: TENANT,
    engagement_id: ENGAGEMENT,
    check_id: CHECK,
    root_content_sha256: digest,
    projection_sha256: digest,
    projection_version: 1,
  };
  const output = {
    mode: 'public_website',
    observation: {
      version: 1,
      binding: source,
      pages: [
        { page: 'root', status: 'checked', content_sha256: digest, form_state: 'unexamined' },
      ],
      private_facts: {
        hosting_region: 'unknown',
        backend_personal_data: 'unknown',
        cross_border_processing: 'unknown',
      },
      requires_human_review: true,
    },
  };
  return {
    data: {
      observation_id: KEY,
      dispatch_id: KEY,
      binding_id: BINDING,
      run_id: KEY,
      output_sha256: await sha256(canonicalJson(output)),
      completion_receipt: '12',
      agent: 'drishti',
      output,
    },
  };
}
const expected = {
  tenantId: TENANT,
  engagementId: ENGAGEMENT,
  bindingId: BINDING,
  checkId: CHECK,
  rootSha256: digest,
  projectionSha256: digest,
  agent: 'drishti' as const,
};
it('validates a genuine observation output hash and literal unknown private facts', async () => {
  const value = await result();
  expect(await validateSourceObservation(value, expected)).toEqual(value.data);
});
it.each(['tenant', 'engagement', 'check', 'root', 'projection', 'binding', 'agent', 'sha'])(
  'rejects source or output commitment mismatch %s',
  async (kind) => {
    const value = await result();
    const fields = {
      tenant: 'tenantId',
      engagement: 'engagementId',
      check: 'checkId',
      root: 'rootSha256',
      projection: 'projectionSha256',
      binding: 'bindingId',
      agent: 'agent',
    };
    if (kind === 'sha') value.data.output_sha256 = 'b'.repeat(64);
    const changed =
      kind === 'sha'
        ? expected
        : {
            ...expected,
            [fields[kind as keyof typeof fields]]:
              kind === 'agent'
                ? 'vibhaag'
                : kind === 'root' || kind === 'projection'
                  ? 'b'.repeat(64)
                  : KEY,
          };
    await expect(validateSourceObservation(value, changed as typeof expected)).rejects.toThrow(
      /selected source/,
    );
  },
);
it('refuses private facts or falsely completed human review in an otherwise shaped response', async () => {
  const value = await result();
  value.data.output.observation.requires_human_review = false;
  await expect(validateSourceObservation(value, expected)).rejects.toThrow();
});

it('preserves only the allowlisted GET recapture refusal and never reflects server messages', async () => {
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValue(
        Response.json(
          { error: { code: 'website_recapture_required', message: 'PRIVATE_SERVER_DETAIL' } },
          { status: 409 },
        ),
      ),
  );
  try {
    await sourceRequest(
      TENANT,
      '/public-website-checks/' + CHECK + '/control-review?engagementId=' + ENGAGEMENT,
    );
    throw new Error('expected refusal');
  } catch (error) {
    expect(error).toBeInstanceOf(SourceWorkflowError);
    expect((error as SourceWorkflowError).readRefusal).toEqual({
      status: 409,
      code: 'website_recapture_required',
    });
    expect(String(error)).not.toContain('PRIVATE_SERVER_DETAIL');
  }
});
it.each([403, 503])(
  'does not grant recapture semantics to an untrusted %i error',
  async (status) => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          Response.json({ error: { code: 'website_recapture_required' } }, { status }),
        ),
    );
    const refusal = await sourceRequest(TENANT, '/read').catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(SourceWorkflowError);
    expect((refusal as SourceWorkflowError).readRefusal).toBeUndefined();
  },
);

it('preserves mutation and reconciliation refusals even if the server sends the read-only recapture code', async () => {
  const fetcher = vi
    .fn()
    .mockImplementation(async () =>
      Response.json(
        { error: { code: 'website_recapture_required', message: 'PRIVATE_SERVER_MESSAGE' } },
        { status: 409 },
      ),
    );
  vi.stubGlobal('fetch', fetcher);
  const write = await sourceRequest(
    TENANT,
    `/public-source-bindings/${BINDING}/agents/drishti/run`,
    {
      operation: operation(),
    },
  ).catch((error: unknown) => error);
  expect(write).toBeInstanceOf(SourceWorkflowError);
  expect((write as SourceWorkflowError).message).toBe(
    'The action was not confirmed. Reconcile the retained request before continuing.',
  );
  expect((write as SourceWorkflowError).readRefusal).toBeUndefined();
  const read = await sourceRequest(TENANT, '/request', { requestKey: KEY }).catch(
    (error: unknown) => error,
  );
  expect(read).toBeInstanceOf(SourceWorkflowError);
  expect((read as SourceWorkflowError).message).toBe('The recorded state could not be loaded.');
  expect((read as SourceWorkflowError).readRefusal).toBeUndefined();
});
