// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { WorkflowPanel } from './panel';
import { workflowRequestSchema, type WorkflowRecord } from '@axiom/types';
const tenant = '99111000-0000-4000-8000-000000000001',
  actor = '99111000-0000-4000-8000-000000000002',
  id = '99111000-0000-4000-8000-000000000003';
const payload = {
  engagementId: null,
  sourceNote: 'Human observation, no private processing evidence',
  system: 'Public website',
  purpose: null,
  legalBasis: null,
  retentionMonths: null,
  dataCategories: null,
  dataPrincipals: null,
  processors: null,
  recipients: null,
  destinationCountries: null,
  transferSafeguards: null,
  dpiaRequired: null,
  region: null,
  crossBorder: null,
  securityMeasures: null,
};
const record: WorkflowRecord = {
  id,
  tenant_id: tenant,
  operation_key: id,
  kind: 'ropa',
  payload,
  created_by: actor,
  created_at: '2026-10-05T00:00:00Z',
  receipt_id: '211',
  content_sha256: null,
};
let rows: WorkflowRecord[], saved: WorkflowRecord | null, interrupted: boolean;
let calls: Array<{ url: string; options?: RequestInit }>;
beforeEach(() => {
  sessionStorage.clear();
  rows = [];
  saved = null;
  interrupted = false;
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, options?: RequestInit) => {
      calls.push({ url, options });
      if (url.endsWith('/cancel'))
        return new Response(JSON.stringify({ cancelled: saved === null, data: saved }), {
          status: 200,
        });
      if (url.endsWith('/reviews'))
        return new Response(
          JSON.stringify({ data: [], meta: { limit: 1, offset: 0, hasMore: false } }),
          { status: 200 },
        );
      if (options?.method === 'POST') {
        const request = workflowRequestSchema.parse(JSON.parse(String(options.body)));
        saved = {
          ...record,
          operation_key: request.operationKey,
          kind: request.kind,
          payload: request.payload,
        } as WorkflowRecord;
        rows = [saved];
        if (interrupted) throw new Error('lost response after commit');
        return new Response(JSON.stringify({ data: saved, replayed: false }), { status: 201 });
      }
      if (url.includes('/requests/'))
        return new Response(JSON.stringify({ data: saved }), { status: 200 });
      return new Response(
        JSON.stringify({
          data:
            url.includes('kind=policy_review') ||
            (url.includes('kind=ropa') && rows[0]?.kind === 'policy_draft')
              ? []
              : rows,
          meta: { limit: url.includes('limit=50') ? 50 : 20, offset: 0, hasMore: false },
        }),
        { status: 200 },
      );
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
async function openForm(label: string) {
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Refresh records' }).hasAttribute('disabled')).toBe(
      false,
    ),
  );
  fireEvent.click(screen.getByText(label));
}
async function processingForm() {
  render(<WorkflowPanel tenantId={tenant} actorId={actor} kind="ropa" canWrite />);
  await openForm('Record processing activity');
  fireEvent.change(screen.getByLabelText('System or processing activity'), {
    target: { value: 'Public website' },
  });
  fireEvent.change(screen.getByLabelText('Source and reason for this record'), {
    target: { value: payload.sourceNote },
  });
}
it('saves unknowns as null and reloads the human record rather than inventing residency', async () => {
  await processingForm();
  fireEvent.click(screen.getByRole('button', { name: 'Save processing activity' }));
  await screen.findByText('Saved with a human audit receipt. Reload reads the retained record.');
  expect(saved?.payload).toEqual(payload);
  expect(screen.getAllByText('Unknown — human confirmation required').length).toBeGreaterThan(8);
  expect(screen.queryByText('ap-south-1')).toBeNull();
  expect(sessionStorage.length).toBe(0);
  expect(calls.filter((c) => c.options?.method === 'POST')).toHaveLength(1);
});
it('reconciles a lost response without submitting another mutation', async () => {
  interrupted = true;
  await processingForm();
  fireEvent.click(screen.getByRole('button', { name: 'Save processing activity' }));
  await screen.findByRole('alert');
  expect(sessionStorage.length).toBe(1);
  fireEvent.click(screen.getByRole('button', { name: 'Check retained request' }));
  await screen.findByText('The interrupted request was already saved. No duplicate was submitted.');
  expect(calls.filter((c) => c.options?.method === 'POST')).toHaveLength(1);
  expect(sessionStorage.length).toBe(0);
});
it('hides mutating controls for a viewer but reads unknown fields and receipts', async () => {
  rows = [record];
  render(<WorkflowPanel tenantId={tenant} actorId={actor} kind="ropa" canWrite={false} />);
  await screen.findByText('Public website');
  expect(screen.queryByRole('button', { name: 'Save processing activity' })).toBeNull();
  expect(screen.queryByText('Record processing activity')).toBeNull();
  expect(screen.getByText(/audit receipt 211/)).toBeTruthy();
});
it('refuses a foreign-tenant response before rendering its processing data', async () => {
  rows = [{ ...record, tenant_id: actor, payload: { ...payload, system: 'Foreign secret' } }];
  render(<WorkflowPanel tenantId={tenant} actorId={actor} kind="ropa" canWrite={false} />);
  await screen.findByRole('alert');
  expect(screen.queryByText('Foreign secret')).toBeNull();
});
it('captures zero measured duration without inventing annual savings', async () => {
  render(<WorkflowPanel tenantId={tenant} actorId={actor} kind="delivery_task" canWrite />);
  await openForm('Record delivery task');
  fireEvent.change(screen.getByLabelText('Task name'), { target: { value: 'Review' } });
  fireEvent.change(screen.getByLabelText('Source of time record'), {
    target: { value: 'Stopwatch' },
  });
  fireEvent.change(screen.getByLabelText('Minutes per task'), { target: { value: '0' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save delivery task' }));
  await screen.findByText('Saved with a human audit receipt. Reload reads the retained record.');
  expect(saved?.payload).toMatchObject({ durationMinutes: 0, repetitions: 1 });
  expect(screen.getByText(/0 total minutes/)).toBeTruthy();
  expect(screen.queryByText(/annual savings achieved/)).toBeNull();
});
it('keeps policy bytes exact and a tenant owner cannot perform founder review', async () => {
  const content = ' Draft notice  \n  Review required.\n';
  rows = [
    {
      ...record,
      kind: 'policy_draft',
      content_sha256: 'a'.repeat(64),
      payload: {
        title: 'Notice',
        category: 'privacy_notice',
        content,
        sourceRopaId: null,
        engagementId: null,
        sourceNote: 'Human draft',
      },
    },
  ];
  render(
    <WorkflowPanel
      tenantId={tenant}
      actorId={actor}
      kind="policy_draft"
      canWrite
      canReview={false}
    />,
  );
  await screen.findByText('Read exact draft text');
  expect(screen.getByText(/Draft notice/, { selector: 'pre' }).textContent).toBe(content);
  expect(screen.queryByRole('button', { name: 'Record founder review' })).toBeNull();
});
it('shows founder review controls with a required reason and no automatic publishing', async () => {
  rows = [
    {
      ...record,
      kind: 'policy_draft',
      content_sha256: 'a'.repeat(64),
      payload: {
        title: 'Notice',
        category: 'privacy_notice',
        content: 'Review draft',
        sourceRopaId: null,
        engagementId: null,
        sourceNote: 'Human draft',
      },
    },
  ];
  render(
    <WorkflowPanel tenantId={tenant} actorId={actor} kind="policy_draft" canWrite canReview />,
  );
  await screen.findByRole('button', { name: 'Record founder review' });
  expect(screen.getByLabelText('Review reason for Notice').hasAttribute('required')).toBe(true);
  expect(screen.queryByRole('button', { name: /publish/i })).toBeNull();
});

it('keeps sibling forms blocked until authoritative cancellation acknowledges an unsaved request', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, options?: RequestInit) => {
      calls.push({ url, options });
      if (url.endsWith('/cancel'))
        return new Response(JSON.stringify({ data: null, cancelled: true }), { status: 200 });
      if (options?.method === 'POST')
        return new Response(JSON.stringify({ error: { code: 'source_refused' } }), { status: 404 });
      return new Response(
        JSON.stringify({ data: [], meta: { limit: 20, offset: 0, hasMore: false } }),
        { status: 200 },
      );
    }),
  );
  render(
    <>
      <WorkflowPanel tenantId={tenant} actorId={actor} kind="ropa" canWrite />
      <WorkflowPanel tenantId={tenant} actorId={actor} kind="delivery_task" canWrite />
    </>,
  );
  const ropa = within(screen.getByRole('region', { name: 'Processing activities' }));
  const tasks = within(screen.getByRole('region', { name: 'Delivery task capture' }));
  await waitFor(() =>
    expect(ropa.getByRole('button', { name: 'Refresh records' }).hasAttribute('disabled')).toBe(
      false,
    ),
  );
  fireEvent.change(ropa.getByLabelText('System or processing activity'), {
    target: { value: 'Contact form' },
  });
  fireEvent.change(ropa.getByLabelText('Source and reason for this record'), {
    target: { value: 'Human capture' },
  });
  fireEvent.click(ropa.getByRole('button', { name: 'Save processing activity' }));
  await ropa.findByRole('alert');
  expect(tasks.getByRole('button', { name: 'Save delivery task' }).hasAttribute('disabled')).toBe(
    true,
  );
  expect(sessionStorage.length).toBe(1);
  fireEvent.click(
    ropa.getByRole('button', { name: 'Cancel retained request or recover saved result' }),
  );
  await ropa.findByText(/Cancellation recorded/);
  expect(sessionStorage.length).toBe(0);
  expect(tasks.getByRole('button', { name: 'Save delivery task' }).hasAttribute('disabled')).toBe(
    false,
  );
  expect(calls.filter((c) => c.options?.method === 'POST')).toHaveLength(2);
});
it('keeps the journal when a cancellation response is interrupted', async () => {
  interrupted = true;
  await processingForm();
  fireEvent.click(screen.getByRole('button', { name: 'Save processing activity' }));
  await screen.findByRole('alert');
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('lost cancel')));
  fireEvent.click(
    screen.getByRole('button', { name: 'Cancel retained request or recover saved result' }),
  );
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: 'Check retained request' }).hasAttribute('disabled'),
    ).toBe(false),
  );
  expect(sessionStorage.length).toBe(1);
});
it('reads each displayed draft history and withholds review when history is incomplete', async () => {
  const draft = {
    ...record,
    kind: 'policy_draft',
    content_sha256: 'a'.repeat(64),
    payload: {
      title: 'Historical notice',
      category: 'privacy_notice',
      content: 'Draft',
      sourceRopaId: null,
      engagementId: null,
      sourceNote: 'Human draft',
    },
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      calls.push({ url });
      if (url.endsWith('/reviews'))
        return new Response(
          JSON.stringify({ error: { code: 'legacy_review_history_unavailable' } }),
          { status: 409 },
        );
      return new Response(
        JSON.stringify({
          data: url.includes('kind=policy_draft') ? [draft] : [],
          meta: { limit: url.includes('limit=50') ? 50 : 20, offset: 0, hasMore: false },
        }),
        { status: 200 },
      );
    }),
  );
  render(
    <WorkflowPanel tenantId={tenant} actorId={actor} kind="policy_draft" canWrite canReview />,
  );
  await screen.findByText('Historical notice');
  expect(screen.getByRole('alert').textContent).toContain(
    'Review history is unavailable or incomplete',
  );
  expect(screen.queryByRole('button', { name: 'Record founder review' })).toBeNull();
  expect(calls.some((c) => c.url.endsWith(`/policy-drafts/${id}/reviews`))).toBe(true);
  expect(calls.some((c) => c.url.includes('kind=policy_review'))).toBe(false);
});
it('preserves declared empty lists as human-recorded none', async () => {
  rows = [{ ...record, payload: { ...payload, processors: [] } }];
  render(<WorkflowPanel tenantId={tenant} actorId={actor} kind="ropa" canWrite={false} />);
  await screen.findByText('Human recorded none — review required');
});
it('allows reading records without discarding a corrupt retained journal', async () => {
  sessionStorage.setItem(`axiom.operator-workflow.v1:${tenant}:${actor}`, '{bad');
  rows = [record];
  render(<WorkflowPanel tenantId={tenant} actorId={actor} kind="ropa" canWrite />);
  await screen.findByText('Public website');
  expect(
    screen.getByRole('button', { name: 'Save processing activity' }).hasAttribute('disabled'),
  ).toBe(true);
  expect(sessionStorage.length).toBe(1);
});

it('generates from the selected persisted activity and requires regeneration after changing the document type', async () => {
  let finish: ((value: Response) => void) | undefined;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, options?: RequestInit) => {
      calls.push({ url, options });
      if (url.includes('/policy-preview?'))
        return new Promise<Response>((resolve) => {
          finish = resolve;
        });
      return new Response(
        JSON.stringify({
          data: url.includes('kind=ropa') ? [record] : [],
          meta: { limit: url.includes('limit=50') ? 50 : 20, offset: 0, hasMore: false },
        }),
        { status: 200 },
      );
    }),
  );
  render(<WorkflowPanel tenantId={tenant} actorId={actor} kind="policy_draft" canWrite />);
  await openForm('Create policy or notice draft');
  fireEvent.change(screen.getByLabelText('Saved processing activity'), { target: { value: id } });
  fireEvent.click(screen.getByRole('button', { name: 'Generate draft from selected activity' }));
  await waitFor(() => expect(finish).toBeDefined());
  expect((screen.getByLabelText('Document type') as HTMLSelectElement).matches(':disabled')).toBe(
    true,
  );
  finish!(
    new Response(
      JSON.stringify({
        data: {
          title: 'Review notice',
          category: 'privacy_notice',
          content: ' Unpublished draft. Unknown facts remain unknown.\n',
          sourceRopaId: id,
          engagementId: null,
          sourceNote: 'Retained human activity',
        },
      }),
      { status: 200 },
    ),
  );
  await screen.findByText(/Draft generated from the retained processing activity/);
  expect((screen.getByLabelText('Draft text') as HTMLTextAreaElement).value).toBe(
    ' Unpublished draft. Unknown facts remain unknown.\n',
  );
  fireEvent.change(screen.getByLabelText('Document type'), { target: { value: 'retention' } });
  await screen.findByText(/The generated draft uses a different source/);
  expect(screen.getByRole('button', { name: 'Save draft' }).hasAttribute('disabled')).toBe(true);
  expect(calls.filter((c) => c.options?.method === 'POST')).toHaveLength(0);
});
it('does not journal or submit a whitespace-only draft', async () => {
  render(<WorkflowPanel tenantId={tenant} actorId={actor} kind="policy_draft" canWrite />);
  await openForm('Create policy or notice draft');
  fireEvent.change(screen.getByLabelText('Document title'), { target: { value: 'Notice' } });
  fireEvent.change(screen.getByLabelText('Draft text'), { target: { value: ' \n ' } });
  fireEvent.change(screen.getByLabelText('Source and reason for this record'), {
    target: { value: 'Human draft' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
  await screen.findByRole('alert');
  expect(sessionStorage.length).toBe(0);
  expect(calls.filter((c) => c.options?.method === 'POST')).toHaveLength(0);
});
