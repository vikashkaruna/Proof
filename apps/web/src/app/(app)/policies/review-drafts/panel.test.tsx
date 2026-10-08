// @vitest-environment jsdom
import { StrictMode } from 'react';
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react';
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { webcrypto, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { ReviewDraftPanel } from './panel';
import { draftKey, readDraftJournal, retainDraftJournal, type DraftJournal } from './request';
const f = JSON.parse(
  readFileSync('../../packages/types/src/__fixtures__/reviewed-workflow-drafts.json', 'utf8'),
);
const actor = '77777777-7777-4777-8777-777777777777',
  key = '88888888-8888-4888-8888-888888888888',
  run = '99999999-9999-4999-8999-999999999999',
  ackKey = '60000000-0000-4000-8000-000000000006';
const props = { tenantId: f.input.tenant_id, actorId: actor, canSavePolicy: true };
const journal = (): DraftJournal => ({
  version: 1,
  tenantId: props.tenantId,
  actorId: actor,
  input: f.input,
  request: {
    engagementId: f.input.engagement_id,
    recordIds: f.input.records.map((r: { id: string }) => r.id),
    sourceDigest: f.input.source_records_sha256,
    operationKey: key,
    confirmSourceReview: true,
  },
});
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v);
}
const hash = (v: unknown) => createHash('sha256').update(canonical(v)).digest('hex');
const output = () => ({
  data: f.output,
  invocation: {
    runId: run,
    correlationId: key,
    requestHash: hash(f.input),
    responseHash: hash(f.output),
  },
  outputProof: {
    kind: 'settled_output_recorded',
    tenantId: props.tenantId,
    actorId: actor,
    operationKey: key,
    runId: run,
    requestHash: hash(f.input),
    responseHash: hash(f.output),
    requestedReceipt: '1',
    startedReceipt: '2',
    completedReceipt: '3',
    settledReceipt: '4',
  },
});
const response = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal('crypto', webcrypto);
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: { request: vi.fn(async (_name: string, callback: () => Promise<void>) => callback()) },
  });
  fetchMock = vi.fn(async (url) => {
    const kind = String(url).includes('kind=ropa') ? 'ropa' : 'delivery_task';
    return response({
      data: f.input.records.filter((r: { kind: string }) => r.kind === kind),
      meta: { total: 1, limit: 20, offset: 0, hasMore: false },
    });
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it('mount including StrictMode never invokes an agent or automatically acknowledges retained output', async () => {
  retainDraftJournal(localStorage, journal());
  render(
    <StrictMode>
      <ReviewDraftPanel {...props} />
    </StrictMode>,
  );
  await screen.findByText(/Retained request/);
  expect(fetchMock.mock.calls.every((call) => !call[1]?.method || call[1]?.method === 'GET')).toBe(
    true,
  );
  expect(readDraftJournal(localStorage, props.tenantId, actor)).toEqual(journal());
});
it('storage unreadable preserves reference and prevents every submit action', async () => {
  localStorage.setItem(draftKey(props.tenantId, actor), 'broken');
  render(<ReviewDraftPanel {...props} />);
  await screen.findByText(/retained request is unreadable/);
  expect(screen.queryByRole('button', { name: 'Submit the same retained request' })).toBeNull();
  expect(fetchMock.mock.calls.every((call) => call[1]?.method !== 'POST')).toBe(true);
  expect(localStorage.getItem(draftKey(props.tenantId, actor))).toBe('broken');
});
it('lost original response requires explicit GET recovery; archive clears only confirmed browser reference', async () => {
  retainDraftJournal(localStorage, journal());
  const choices = fetchMock.getMockImplementation()!;
  fetchMock.mockImplementation(async (url, options) => {
    if (String(url).includes('/reviewed-workflows/runs/')) return response(output());
    if (options?.method === 'POST') throw new Error('lost');
    return choices(url, options);
  });
  render(<ReviewDraftPanel {...props} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Submit the same retained request' }));
  await screen.findByRole('alert');
  expect(readDraftJournal(localStorage, props.tenantId, actor)).toEqual(journal());
  fireEvent.click(screen.getByRole('button', { name: 'Check saved output and acknowledgement' }));
  await screen.findByRole('heading', { name: 'Saved source-bound review artifacts' });
  expect(fetchMock.mock.calls.filter((call) => call[1]?.method === 'POST')).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: 'Archive confirmed browser reference' }));
  await waitFor(() => expect(readDraftJournal(localStorage, props.tenantId, actor)).toBeNull());
  expect(fetchMock.mock.calls.filter((call) => call[1]?.method === 'POST')).toHaveLength(1);
});
it('recovered acknowledgement labels historical initial draft separately from current published status', async () => {
  const j = journal();
  j.acknowledgement = {
    operationKey: ackKey,
    body: {
      runId: run,
      outputHash: hash(f.output),
      policyIndex: 0,
      reason: 'Review original source; separate policy authority',
      confirmReview: true,
    },
  };
  retainDraftJournal(localStorage, j);
  const choices = fetchMock.getMockImplementation()!;
  fetchMock.mockImplementation(async (url, options) => {
    if (String(url).includes('/reviewed-workflows/runs/')) return response(output());
    if (String(url).endsWith('/acknowledgements')) {
      expect(JSON.parse(String(options?.body)).readOnly).toBe(true);
      return response({
        data: {
          acknowledgement_id: ackKey,
          receipt_id: '6',
          policy_draft_id: run,
          replayed: true,
          manifest: {
            kind: 'reviewed_workflow_acknowledgement_recorded',
            tenantId: props.tenantId,
            actorId: actor,
            operationKey: ackKey,
            originalOperationKey: key,
            runId: run,
            inputHash: hash(f.input),
            outputHash: hash(f.output),
            sourceDigest: f.input.source_records_sha256,
            bodyHash: hash(j.acknowledgement!.body),
            acknowledgementId: ackKey,
            receiptId: '6',
            policyIndex: 0,
            policyDraftId: run,
            policyReceipt: '5',
            initialPolicyStatus: 'draft',
            currentPolicyStatus: 'published',
            requestedReceipt: '1',
            startedReceipt: '2',
            completedReceipt: '3',
            settledReceipt: '4',
          },
        },
      });
    }
    return choices(url, options);
  });
  render(<ReviewDraftPanel {...props} />);
  fireEvent.click(
    await screen.findByRole('button', { name: 'Check saved output and acknowledgement' }),
  );
  await screen.findByText('published');
  expect(screen.getByRole('status').textContent).toContain(
    'Policy initial save: draft. Current saved policy status: published',
  );
  expect(fetchMock.mock.calls.filter((call) => call[1]?.method === 'POST')).toHaveLength(1);
  expect(readDraftJournal(localStorage, props.tenantId, actor)).toEqual(j);
});
it('changing actor remounts safely and never adopts another actors retained request', async () => {
  retainDraftJournal(localStorage, journal());
  const view = render(<ReviewDraftPanel {...props} />);
  await screen.findByText(/Retained request/);
  view.rerender(<ReviewDraftPanel {...props} actorId={ackKey} />);
  await waitFor(() => expect(screen.queryByText(/Retained request/)).toBeNull());
  expect(readDraftJournal(localStorage, props.tenantId, actor)).toEqual(journal());
  expect(fetchMock.mock.calls.every((call) => call[1]?.method !== 'POST')).toBe(true);
});
it('a cross-tab body change hides old confirmed output and refuses stale response adoption', async () => {
  retainDraftJournal(localStorage, journal());
  const choices = fetchMock.getMockImplementation()!;
  let resolve: (value: Response) => void = () => {};
  fetchMock.mockImplementation(async (url, options) =>
    String(url).includes('/reviewed-workflows/runs/')
      ? new Promise<Response>((done) => {
          resolve = done;
        })
      : choices(url, options),
  );
  render(<ReviewDraftPanel {...props} />);
  fireEvent.click(
    await screen.findByRole('button', { name: 'Check saved output and acknowledgement' }),
  );
  await waitFor(() =>
    expect(
      fetchMock.mock.calls.some((call) => String(call[0]).includes('/reviewed-workflows/runs/')),
    ).toBe(true),
  );
  const changed = { ...journal(), request: { ...journal().request, operationKey: ackKey } };
  await act(async () => {
    localStorage.setItem(draftKey(props.tenantId, actor), JSON.stringify(changed));
    window.dispatchEvent(new StorageEvent('storage', { key: draftKey(props.tenantId, actor) }));
    resolve(response(output()));
  });
  await screen.findByRole('alert');
  expect(screen.queryByRole('heading', { name: 'Saved source-bound review artifacts' })).toBeNull();
  expect(readDraftJournal(localStorage, props.tenantId, actor)?.request.operationKey).toBe(ackKey);
});
it('an unconfirmed retained acknowledgement exposes its exact retry without an agent resubmission', async () => {
  const j = journal();
  j.acknowledgement = {
    operationKey: ackKey,
    body: {
      runId: run,
      outputHash: hash(f.output),
      policyIndex: null,
      reason: 'Original explicit human review',
      confirmReview: true,
    },
  };
  retainDraftJournal(localStorage, j);
  const choices = fetchMock.getMockImplementation()!;
  fetchMock.mockImplementation(async (url, options) => {
    if (String(url).includes('/reviewed-workflows/runs/')) return response(output());
    if (String(url).endsWith('/acknowledgements')) return response({ missing: true }, 404);
    return choices(url, options);
  });
  render(<ReviewDraftPanel {...props} />);
  await screen.findByRole('button', { name: 'Submit the same retained acknowledgement' });
  expect(screen.queryByRole('button', { name: 'Submit the same retained request' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Check saved output and acknowledgement' }));
  await screen.findByRole('alert');
  expect(
    screen.getByRole('button', { name: 'Submit the same retained acknowledgement' }),
  ).toBeTruthy();
  const posts = fetchMock.mock.calls.filter((call) => call[1]?.method === 'POST');
  expect(posts).toHaveLength(1);
  expect(JSON.parse(String(posts[0]![1]?.body))).toMatchObject({
    readOnly: true,
    operationKey: ackKey,
    acknowledgement: j.acknowledgement.body,
  });
  expect(readDraftJournal(localStorage, props.tenantId, actor)).toEqual(j);
});
