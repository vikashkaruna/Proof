// @vitest-environment jsdom
import React from 'react';
import { webcrypto } from 'node:crypto';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { canonicalJson, sha256 } from '@axiom/ledger';
import { PublicSourceWorkflow } from './source-workflow';
import { loadSourceOperation, operationStorageKey } from './source-request';
import {
  reviewOperationSchema,
  saveReviewOperation,
  reviewStorageKey,
} from './source-review-request';

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));
const TENANT = '11111111-1111-4111-8111-111111111111';
const ACTOR = '22222222-2222-4222-8222-222222222222';
const ENGAGEMENT = '33333333-3333-4333-8333-333333333333';
const CHECK = '44444444-4444-4444-8444-444444444444';
const BINDING = '55555555-5555-4555-8555-555555555555';
const DRISHTI = '66666666-6666-4666-8666-666666666666';
const VIBHAAG = '77777777-7777-4777-8777-777777777777';
const RUN = '88888888-8888-4888-8888-888888888888';
const DISPATCH = '99999999-9999-4999-8999-999999999999';
const timestamp = '2026-10-05T01:00:00Z';
const rootSha = 'a'.repeat(64),
  projectionSha = 'b'.repeat(64);
const binding = {
  tenant_id: TENANT,
  engagement_id: ENGAGEMENT,
  check_id: CHECK,
  root_content_sha256: rootSha,
  projection_sha256: projectionSha,
  projection_version: 1,
};
const pages = [
  { page: 'root', status: 'checked', content_sha256: rootSha },
  { page: 'contact', status: 'unavailable' },
];
const projection = { version: 1, pages };
const privateFacts = {
  hosting_region: 'unknown',
  backend_personal_data: 'unknown',
  cross_border_processing: 'unknown',
};

async function fixture() {
  let bound = false;
  let disconnected = false;
  let state = 'not_found';
  let corrupt = false;
  let cancelled = false;
  const observations = new Map<string, Record<string, unknown>>();
  async function observation(agent: 'drishti' | 'vibhaag') {
    const output =
      agent === 'drishti'
        ? {
            mode: 'public_website',
            observation: {
              version: 1,
              binding,
              pages: pages.map((page) => ({
                ...page,
                form_state: page.status === 'unavailable' ? 'unavailable' : 'unexamined',
              })),
              private_facts: privateFacts,
              requires_human_review: true,
            },
          }
        : {
            mode: 'public_website',
            source_binding: binding,
            indicators: [],
            private_facts: privateFacts,
            unexamined_pages: ['root'],
            unavailable_pages: ['contact'],
            scope_limited: true,
          };
    return {
      observation_id: agent === 'drishti' ? DRISHTI : VIBHAAG,
      dispatch_id: DISPATCH,
      binding_id: BINDING,
      run_id: RUN,
      output_sha256: await sha256(canonicalJson(output)),
      completion_receipt: '12',
      agent,
      output,
    };
  }
  const drishti = await observation('drishti'),
    vibhaag = await observation('vibhaag');
  function metadata(row: Record<string, unknown>) {
    const { output: _, ...identity } = row;
    return { ...identity, tenant_id: TENANT, engagement_id: ENGAGEMENT, created_at: timestamp };
  }
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    const path = String(url);
    if (init?.method === 'POST') {
      const retained = loadSourceOperation(localStorage, TENANT, ACTOR);
      expect(retained?.bodyUtf8).toBe(init.body);
      expect(retained?.operationKey).toBe(new Headers(init.headers).get('Idempotency-Key'));
    }
    if (path.includes('/options/engagements'))
      return Response.json({
        data: [
          {
            id: ENGAGEMENT,
            tenant_id: TENANT,
            title: 'Axiom website audit',
            status: cancelled ? 'cancelled' : 'discovery',
            library_version: '1.0',
            created_at: timestamp,
            estate: null,
          },
        ],
        meta: { limit: 20, hasMore: false, nextCursor: null },
      });
    if (path.endsWith('/public-website-checks'))
      return Response.json({
        data: [
          {
            id: CHECK,
            finalUrl: 'https://axiomminds.ai/',
            checkedAt: timestamp,
            status: 'checked',
            contentSha256: rootSha,
          },
        ],
      });
    if (path.includes('/source-preview'))
      return Response.json({
        data: {
          runtime_binding: binding,
          projection,
          ...(bound ? { binding_id: BINDING, creation_receipt: '3' } : {}),
        },
      });
    if (path.endsWith('/public-source-bindings')) {
      bound = true;
      return Response.json(
        {
          data: {
            runtime_binding: binding,
            projection,
            binding_id: BINDING,
            creation_receipt: '3',
            created: true,
            replayed: false,
          },
        },
        { status: 201 },
      );
    }
    if (path.includes('/reviews?'))
      return Response.json({ data: [], meta: { limit: 20, hasMore: false, nextCursor: null } });
    if (path.includes('/observations?'))
      return Response.json({
        data: Array.from(observations.values(), metadata),
        meta: { limit: 20, hasMore: false, nextCursor: null },
      });
    if (path.includes('/public-source-observations/')) {
      const row = observations.get(path.includes(DRISHTI) ? DRISHTI : VIBHAAG);
      return Response.json({
        data: corrupt && row ? { ...row, output_sha256: 'f'.repeat(64) } : row,
      });
    }
    if (path.includes('/request?'))
      return Response.json({
        data: {
          tenant_id: TENANT,
          actor_id: ACTOR,
          engagement_id: ENGAGEMENT,
          binding_id: BINDING,
          agent: 'drishti',
          correlation_id: RUN,
          outcome:
            state === 'retained'
              ? { state, observation: metadata(drishti) }
              : state === 'not_found'
                ? { state }
                : {
                    state,
                    run_id: RUN,
                    dispatch_id: DISPATCH,
                    ...(state === 'completed_without_observation'
                      ? { output_sha256: drishti.output_sha256, completion_receipt: '12' }
                      : {}),
                  },
        },
      });
    if (path.includes('/agents/') && init?.method === 'POST') {
      if (disconnected) throw new Error('private transport details');
      const row = path.includes('/drishti/') ? drishti : vibhaag;
      observations.set(String(row.observation_id), row);
      return Response.json({ data: row }, { status: 201 });
    }
    throw new Error(`Unexpected synthetic URL: ${path}`);
  });
  vi.stubGlobal('fetch', fetcher);
  return {
    fetcher,
    drishti,
    vibhaag,
    observations,
    setBound: () => {
      bound = true;
    },
    setDisconnected: (v: boolean) => {
      disconnected = v;
    },
    setState: (v: string) => {
      state = v;
    },
    setCorrupt: () => {
      corrupt = true;
    },
    setCancelled: () => {
      cancelled = true;
    },
  };
}
function view(canInvoke = true, actorId = ACTOR) {
  return render(<PublicSourceWorkflow tenantId={TENANT} actorId={actorId} canInvoke={canInvoke} />);
}
async function selectSource() {
  await screen.findByRole('option', { name: /Axiom website audit/ });
  fireEvent.change(screen.getByLabelText('Engagement'), { target: { value: ENGAGEMENT } });
  fireEvent.change(screen.getByLabelText('Saved public website check'), {
    target: { value: CHECK },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Preview saved source' }));
  await screen.findByRole('heading', { name: 'Retained public HTML facts' });
}
async function ready() {
  await waitFor(() =>
    expect(
      (screen.getByRole('button', { name: 'Refresh choices' }) as HTMLButtonElement).disabled,
    ).toBe(false),
  );
}
/** Observe the next real SHA operation immediately before selecting an observation.
 * The gate controls completion only; native SHA bytes and production verification remain real. */
function nextObservationDigest() {
  let release!: () => void;
  let entered!: () => void;
  let finished!: () => void;
  let failed!: (cause: unknown) => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const completed = new Promise<void>((resolve, reject) => {
    finished = resolve;
    failed = reject;
  });
  const realDigest = webcrypto.subtle.digest.bind(webcrypto.subtle);
  const spy = vi.spyOn(webcrypto.subtle, 'digest').mockImplementationOnce((algorithm, input) => {
    entered();
    const result = realDigest(algorithm, input).then(async (bytes) => {
      await gate;
      return bytes;
    });
    void result.then(() => finished(), failed);
    return result;
  });
  return { started, completed, release, spy };
}
beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal('crypto', webcrypto);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it('loads a linked earlier check without crawling or dispatching and retains it when choices refresh', async () => {
  const f = await fixture();
  const original = f.fetcher.getMockImplementation()!;
  const earlier = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  f.fetcher.mockImplementation(async (url, init) =>
    String(url).includes(`/public-website-checks?id=${earlier}`)
      ? Response.json({
          data: [
            {
              id: earlier,
              finalUrl: 'https://earlier.example/',
              checkedAt: timestamp,
              status: 'checked',
              contentSha256: rootSha,
            },
          ],
        })
      : original(url, init),
  );
  render(
    <PublicSourceWorkflow tenantId={TENANT} actorId={ACTOR} canInvoke initialCheckId={earlier} />,
  );
  await ready();
  expect((screen.getByLabelText('Saved public website check') as HTMLSelectElement).value).toBe(
    earlier,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Refresh choices' }));
  await ready();
  expect((screen.getByLabelText('Saved public website check') as HTMLSelectElement).value).toBe(
    earlier,
  );
  expect(screen.getByRole('option', { name: /earlier.example/ })).toBeTruthy();
  expect(f.fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0);
});

it('does not substitute an earlier-check link for an unresolved retained operation', async () => {
  const f = await fixture();
  f.setBound();
  f.setDisconnected(true);
  const first = view();
  await selectSource();
  await ready();
  fireEvent.click(screen.getByRole('button', { name: 'Run Drishti on saved source' }));
  await screen.findByRole('alert');
  const retained = loadSourceOperation(localStorage, TENANT, ACTOR);
  first.unmount();
  render(
    <PublicSourceWorkflow tenantId={TENANT} actorId={ACTOR} canInvoke initialCheckId={DRISHTI} />,
  );
  await screen.findByText('A retained request needs reconciliation before another action.');
  await screen.findByRole('option', { name: /Axiom website audit/ });
  expect((screen.getByLabelText('Saved public website check') as HTMLSelectElement).value).toBe(
    CHECK,
  );
  expect(loadSourceOperation(localStorage, TENANT, ACTOR)).toEqual(retained);
  expect(f.fetcher.mock.calls.some(([url]) => String(url).includes(`?id=${DRISHTI}`))).toBe(false);
  expect(f.fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
});

it('completes source binding, discovery and classification using retained receipts and exact scoped bodies', async () => {
  const f = await fixture();
  view();
  await selectSource();
  await ready();
  fireEvent.click(screen.getByRole('button', { name: 'Record source binding' }));
  await screen.findByText(/Source binding recorded/);
  await ready();
  fireEvent.click(screen.getByRole('button', { name: 'Run Drishti on saved source' }));
  await screen.findByRole('heading', { name: 'Drishti public observation' });
  await ready();
  fireEvent.click(screen.getByRole('button', { name: 'Run Vibhaag on selected observation' }));
  await screen.findByRole('heading', { name: 'Vibhaag structural indicators' });
  expect(screen.getByText('Human review pending')).toBeTruthy();
  expect(screen.getByText(/Private hosting: unknown/)).toBeTruthy();
  expect(screen.getByText(/This does not prove personal data is absent/)).toBeTruthy();
  const posts = f.fetcher.mock.calls.filter(([, init]) => init?.method === 'POST');
  expect(posts).toHaveLength(3);
  expect(JSON.parse(String(posts[0]![1]!.body))).toEqual({
    checkId: CHECK,
    engagementId: ENGAGEMENT,
    expectedRootSha256: rootSha,
    expectedProjectionSha256: projectionSha,
  });
  expect(JSON.parse(String(posts[1]![1]!.body))).toEqual({
    engagementId: ENGAGEMENT,
    expectedProjectionSha256: projectionSha,
  });
  expect(JSON.parse(String(posts[2]![1]!.body))).toEqual({
    engagementId: ENGAGEMENT,
    expectedProjectionSha256: projectionSha,
    observationId: DRISHTI,
  });
  expect(
    new Set(posts.map(([, init]) => new Headers(init!.headers).get('Idempotency-Key'))).size,
  ).toBe(3);
  expect(loadSourceOperation(localStorage, TENANT, ACTOR)).toBeNull();
});

it('lets viewers select retained Drishti and Vibhaag outputs with no mutation controls or requests', async () => {
  const f = await fixture();
  f.setBound();
  f.observations.set(DRISHTI, f.drishti);
  f.observations.set(VIBHAAG, f.vibhaag);
  view(false);
  await selectSource();
  await screen.findByRole('button', { name: 'Select Drishti observation' });
  fireEvent.click(screen.getByRole('button', { name: 'Select Drishti observation' }));
  await screen.findByRole('heading', { name: 'Drishti public observation' });
  await ready();
  fireEvent.click(screen.getByRole('button', { name: 'Review Vibhaag result' }));
  await screen.findByRole('heading', { name: 'Vibhaag structural indicators' });
  expect(screen.queryByRole('button', { name: 'Run Drishti on saved source' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Run Vibhaag on selected observation' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Record source binding' })).toBeNull();
  expect(f.fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0);
});

it.each(['unknown', 'running', 'completed_without_observation'])(
  'retains and blocks interrupted %s operations across remount without redispatch',
  async (state) => {
    const f = await fixture();
    f.setBound();
    f.setDisconnected(true);
    f.setState(state);
    const v = view();
    await selectSource();
    await ready();
    fireEvent.click(screen.getByRole('button', { name: 'Run Drishti on saved source' }));
    await screen.findByRole('alert');
    const original = loadSourceOperation(localStorage, TENANT, ACTOR)!;
    v.unmount();
    view();
    await screen.findByRole('button', { name: 'Reconcile retained request' });
    await waitFor(() =>
      expect(
        (screen.getByRole('button', { name: 'Reconcile retained request' }) as HTMLButtonElement)
          .disabled,
      ).toBe(false),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Reconcile retained request' }));
    await waitFor(() =>
      expect(f.fetcher.mock.calls.some(([url]) => String(url).includes('/request?'))).toBe(true),
    );
    await waitFor(() =>
      expect(
        (screen.getByRole('button', { name: 'Reconcile retained request' }) as HTMLButtonElement)
          .disabled,
      ).toBe(false),
    );
    expect(screen.queryByRole('button', { name: 'Retry exact retained request' })).toBeNull();
    expect(f.fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
    expect(actionStatus('Run Drishti on saved source').message).toContain(
      'Reconcile the retained request',
    );
    expect(loadSourceOperation(localStorage, TENANT, ACTOR)).toEqual(original);
    const read = f.fetcher.mock.calls.find(([url]) => String(url).includes('/request?'))!;
    expect(new Headers(read[1]!.headers).get('X-Public-Source-Request-Key')).toBe(
      original.operationKey,
    );
    expect(String(read[0])).not.toContain(original.operationKey);
  },
);

it('retries only after explicit not-found reconciliation and uses the same exact key and body', async () => {
  const f = await fixture();
  f.setBound();
  f.setDisconnected(true);
  view();
  await selectSource();
  await ready();
  fireEvent.click(screen.getByRole('button', { name: 'Run Drishti on saved source' }));
  await screen.findByRole('alert');
  const original = loadSourceOperation(localStorage, TENANT, ACTOR)!;
  fireEvent.click(screen.getByRole('button', { name: 'Reconcile retained request' }));
  await screen.findByRole('button', { name: 'Retry exact retained request' });
  f.setDisconnected(false);
  fireEvent.click(screen.getByRole('button', { name: 'Retry exact retained request' }));
  await screen.findByRole('heading', { name: 'Drishti public observation' });
  const posts = f.fetcher.mock.calls.filter(([, init]) => init?.method === 'POST');
  expect(posts).toHaveLength(2);
  for (const [, init] of posts) {
    expect(init!.body).toBe(original.bodyUtf8);
    expect(new Headers(init!.headers).get('Idempotency-Key')).toBe(original.operationKey);
  }
});

it('recovers a retained interrupted result through reconciliation and detail reads without a second invocation', async () => {
  const f = await fixture();
  f.setBound();
  f.setDisconnected(true);
  view();
  await selectSource();
  await ready();
  fireEvent.click(screen.getByRole('button', { name: 'Run Drishti on saved source' }));
  await screen.findByRole('alert');
  f.observations.set(DRISHTI, f.drishti);
  f.setState('retained');
  fireEvent.click(screen.getByRole('button', { name: 'Reconcile retained request' }));
  await screen.findByRole('heading', { name: 'Drishti public observation' });
  await waitFor(() => expect(loadSourceOperation(localStorage, TENANT, ACTOR)).toBeNull());
  expect(f.fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
});

it('rejects a corrupted retained output without displaying or discarding its operation', async () => {
  const f = await fixture();
  f.setBound();
  f.setCorrupt();
  view();
  await selectSource();
  await ready();
  fireEvent.click(screen.getByRole('button', { name: 'Run Drishti on saved source' }));
  await screen.findByRole('alert');
  expect(screen.queryByRole('heading', { name: 'Drishti public observation' })).toBeNull();
  expect(loadSourceOperation(localStorage, TENANT, ACTOR)).not.toBeNull();
  expect(screen.queryByRole('button', { name: 'Retry exact retained request' })).toBeNull();
});

it('does not load another actor retained operation or present a no-engagement execution path', async () => {
  const f = await fixture();
  f.setBound();
  f.setDisconnected(true);
  const v = view();
  await selectSource();
  await ready();
  fireEvent.click(screen.getByRole('button', { name: 'Run Drishti on saved source' }));
  await screen.findByRole('alert');
  const original = localStorage.getItem(operationStorageKey(TENANT, ACTOR));
  v.unmount();
  view(false, VIBHAAG);
  await screen.findByRole('option', { name: /Axiom website audit/ });
  expect(screen.queryByRole('button', { name: 'Reconcile retained request' })).toBeNull();
  expect(screen.queryByText(/No engagement/)).toBeNull();
  expect(localStorage.getItem(operationStorageKey(TENANT, ACTOR))).toBe(original);
});

it('fails closed on cancelled historical choices and requires an actual selected engagement', async () => {
  const f = await fixture();
  f.setCancelled();
  view();
  await screen.findByRole('alert');
  expect(screen.queryByRole('option', { name: /Axiom website audit/ })).toBeNull();
  expect(
    (screen.getByRole('button', { name: 'Preview saved source' }) as HTMLButtonElement).disabled,
  ).toBe(true);
});

it('preserves invalid journal refusal even when choices fail, and never dispatches', async () => {
  localStorage.setItem(operationStorageKey(TENANT, ACTOR), '{broken');
  const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 503 }));
  vi.stubGlobal('fetch', fetcher);
  render(<PublicSourceWorkflow tenantId={TENANT} actorId={ACTOR} canInvoke />);
  await waitFor(() => expect(screen.queryByText('Loading recorded state…')).toBeNull());
  expect(screen.getByRole('alert').textContent).toContain('Retained request storage');
  expect(actionStatus('Record source binding').message).toContain('browser request storage');
  expect(fetcher.mock.calls.every(([, init]) => init?.method === 'GET')).toBe(true);
});

it('refuses an operator action before POST when journal persistence fails', async () => {
  const f = await fixture();
  f.setBound();
  view();
  await selectSource();
  await ready();
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new Error('storage quota');
  });
  fireEvent.click(screen.getByRole('button', { name: 'Run Drishti on saved source' }));
  await screen.findByRole('alert');
  expect(f.fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0);
  expect(screen.queryByRole('heading', { name: 'Drishti public observation' })).toBeNull();
});

it('locks source mutations while a separate human review journal remains unconfirmed', async () => {
  const f = await fixture();
  f.setBound();
  const body = {
    engagementId: ENGAGEMENT,
    expectedOutputSha256: f.drishti.output_sha256,
    expectedProjectionSha256: projectionSha,
    target: { kind: 'whole_observation' },
    decision: 'acknowledged',
    justification: 'Saved source facts reviewed.',
    expectedPreviousReviewId: null,
  };
  saveReviewOperation(
    localStorage,
    reviewOperationSchema.parse({
      version: 1,
      tenantId: TENANT,
      actorId: ACTOR,
      operationKey: RUN,
      engagementId: ENGAGEMENT,
      bindingId: BINDING,
      observationId: DRISHTI,
      checkId: CHECK,
      agent: 'drishti',
      rootSha256: rootSha,
      outputSha256: f.drishti.output_sha256,
      projectionSha256: projectionSha,
      bodyUtf8: JSON.stringify(body),
    }),
  );
  view();
  await selectSource();
  await ready();
  expect(screen.getByRole('button', { name: 'Reconcile retained review' })).toBeTruthy();
  for (const name of [
    'Record source binding',
    'Run Drishti on saved source',
    'Run Vibhaag on selected observation',
  ]) {
    expect((screen.getByRole('button', { name }) as HTMLButtonElement).disabled).toBe(true);
    expect(actionStatus(name).message).toContain('human-review state');
  }
  expect(f.fetcher.mock.calls.every(([, init]) => init?.method === 'GET')).toBe(true);
});
it('keeps reviewer access distinct from invocation controls in the full workflow', async () => {
  await fixture();
  render(<PublicSourceWorkflow tenantId={TENANT} actorId={ACTOR} canInvoke={false} canReview />);
  await screen.findByRole('option', { name: /Axiom website audit/ });
  expect(screen.getByText(/Human review is available/)).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Run Drishti on saved source' })).toBeNull();
  expect(screen.getByRole('heading', { name: 'Human source review' })).toBeTruthy();
});

function actionStatus(name: string) {
  const action = screen.getByRole('button', { name }) as HTMLButtonElement;
  const id = action.getAttribute('aria-describedby');
  expect(id).toBeTruthy();
  const message = document.getElementById(id!);
  expect(message).not.toBeNull();
  return { action, message: message!.textContent ?? '' };
}
it('explains disabled prerequisites and readiness through source binding and retained Drishti selection', async () => {
  const f = await fixture();
  view();
  expect(actionStatus('Preview saved source').message).toContain('Loading recorded state');
  await ready();
  expect(actionStatus('Preview saved source').message).toContain('Choose an engagement');
  await waitFor(() =>
    expect(actionStatus('Record source binding').message).toContain('Preview the saved source'),
  );
  fireEvent.change(screen.getByLabelText('Engagement'), { target: { value: ENGAGEMENT } });
  expect(actionStatus('Preview saved source').message).toContain(
    'Choose a saved public website check',
  );
  fireEvent.change(screen.getByLabelText('Saved public website check'), {
    target: { value: CHECK },
  });
  expect(actionStatus('Preview saved source').action.disabled).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'Preview saved source' }));
  await ready();
  expect(actionStatus('Record source binding').action.disabled).toBe(false);
  expect(actionStatus('Run Drishti on saved source').message).toContain(
    'Record the source binding',
  );
  fireEvent.click(screen.getByRole('button', { name: 'Record source binding' }));
  await screen.findByText(/Source binding recorded/);
  await ready();
  expect(actionStatus('Record source binding').message).toContain('already recorded');
  expect(actionStatus('Run Drishti on saved source').action.disabled).toBe(false);
  expect(actionStatus('Run Vibhaag on selected observation').message).toContain(
    'Select a retained Drishti observation',
  );
  f.observations.set(DRISHTI, f.drishti);
  fireEvent.click(screen.getByRole('button', { name: 'Refresh observations' }));
  await ready();
  const selection = await screen.findByRole('button', { name: 'Select Drishti observation' });
  const digest = nextObservationDigest();
  await act(async () => {
    fireEvent.click(selection);
    await digest.started;
    digest.release();
    await digest.completed;
  });
  expect(digest.spy).toHaveBeenCalledTimes(1);
  expect(digest.spy.mock.calls[0]?.[0]).toBe('SHA-256');
  await screen.findByRole('heading', { name: 'Drishti public observation' });
  await ready();
  expect(actionStatus('Run Vibhaag on selected observation').action.disabled).toBe(false);
  expect(actionStatus('Run Vibhaag on selected observation').message).toContain('Ready');
});

it('keeps a selected observation pending until real SHA completion and synchronizes its final readiness', async () => {
  const f = await fixture();
  f.setBound();
  f.observations.set(DRISHTI, f.drishti);
  view();
  await selectSource();
  await ready();
  const selection = await screen.findByRole('button', { name: 'Select Drishti observation' });
  const digest = nextObservationDigest();
  fireEvent.click(selection);
  await digest.started;
  expect(actionStatus('Run Vibhaag on selected observation').action.disabled).toBe(true);
  expect(actionStatus('Run Vibhaag on selected observation').message).toContain(
    'Loading recorded state',
  );
  // The previous click-then-find form expires while a legitimate digest is pending.
  // This uses the original Testing Library deadline; no sleep or extra timeout.
  await expect(
    screen.findByRole('heading', { name: 'Drishti public observation' }),
  ).rejects.toThrow('Unable to find');
  await act(async () => {
    digest.release();
    await digest.completed;
  });
  await screen.findByRole('heading', { name: 'Drishti public observation' });
  await ready();
  expect(actionStatus('Run Vibhaag on selected observation').action.disabled).toBe(false);
  expect(actionStatus('Run Vibhaag on selected observation').message).toContain('Ready');
});

it('explains a review-storage lock even after the chosen bound preview loads', async () => {
  const f = await fixture();
  f.setBound();
  localStorage.setItem(reviewStorageKey(TENANT, ACTOR), '{broken');
  view();
  await selectSource();
  await ready();
  expect(screen.getByRole('alert').textContent).toContain('Review request storage');
  for (const name of [
    'Record source binding',
    'Run Drishti on saved source',
    'Run Vibhaag on selected observation',
  ]) {
    expect(actionStatus(name).action.disabled).toBe(true);
    expect(actionStatus(name).message).toContain('human-review state');
  }
  expect(actionStatus('Preview saved source').action.disabled).toBe(false);
  expect(f.fetcher.mock.calls.every(([, init]) => init?.method === 'GET')).toBe(true);
});

it('recaptures the selected website in its engagement without binding or changing the historical check', async () => {
  const f = await fixture();
  const original = f.fetcher;
  const newId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const fetcher = vi.fn(async (input: string, init?: RequestInit) => {
    if (input.includes('/control-review'))
      return Response.json({ error: { code: 'website_recapture_required' } }, { status: 409 });
    if (input.endsWith('/public-website-checks') && init?.method === 'POST')
      return Response.json(
        {
          data: {
            id: newId,
            requestedUrl: 'https://axiomminds.ai/',
            finalUrl: 'https://axiomminds.ai/',
            checkedAt: timestamp,
            status: 'checked',
            bytes: 12,
            contentSha256: rootSha,
            title: 'Fresh',
            headings: [],
            publicLinks: [],
            auditPages: [],
            observations: [],
          },
        },
        { status: 201 },
      );
    return original(input, init);
  });
  vi.stubGlobal('fetch', fetcher);
  render(<PublicSourceWorkflow tenantId={TENANT} actorId={ACTOR} canInvoke canCapture />);
  await selectSource();
  fireEvent.click(screen.getByRole('button', { name: 'Review website against DPDPA controls' }));
  const capture = await screen.findByRole('button', { name: 'Audit public website' });
  expect(screen.getByLabelText('Public page URL')).toHaveProperty(
    'value',
    'https://axiomminds.ai/',
  );
  expect(document.body.textContent).toContain('Estate: Unassigned');
  expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0);
  await waitFor(() => expect(capture).toHaveProperty('disabled', false));
  fireEvent.click(capture);
  await waitFor(() =>
    expect(screen.getByLabelText('Saved public website check')).toHaveProperty('value', newId),
  );
  expect(
    screen.getByRole('option', { name: /https:\/\/axiomminds.ai\//, selected: false }),
  ).toBeTruthy();
  const posts = fetcher.mock.calls.filter(([, init]) => init?.method === 'POST');
  expect(posts).toHaveLength(1);
  expect(posts[0]?.[0]).toContain('/public-website-checks');
  expect(posts[0]?.[1]?.body).toBe(JSON.stringify({ url: 'https://axiomminds.ai/' }));
  expect(document.body.textContent).toContain('Earlier checks and bindings remain unchanged');
  expect(loadSourceOperation(localStorage, TENANT, ACTOR)).toBeNull();
});
