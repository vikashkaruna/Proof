// @vitest-environment jsdom
import { webcrypto } from 'node:crypto';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { SourceReview } from './source-review';
import { reviewFixture, reviewIds as i } from './source-review-fixture.test-helper';
import {
  loadReviewOperation,
  reviewStorageKey,
  reviewOperationSchema,
  saveReviewOperation,
} from './source-review-request';
import type { PublicSourceReview } from '@axiom/types';
beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal('crypto', webcrypto);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
async function fixture() {
  const f = await reviewFixture();
  let rows: PublicSourceReview[] = [],
    state = 'not_found',
    post = 'ok',
    corrupt = '',
    more = false;
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    const path = String(url);
    if (path.includes('/public-source-observations/'))
      return Response.json({ data: f.observation });
    if (path.includes('/reviews/request?')) {
      const op = loadReviewOperation(localStorage, i.tenant, i.actor)!;
      return Response.json({
        data: {
          tenant_id: corrupt === 'tenant' ? i.review : i.tenant,
          actor_id: corrupt === 'actor' ? i.review : i.actor,
          operation_key: corrupt === 'key' ? i.review : op.operationKey,
          engagement_id: i.engagement,
          binding_id: i.binding,
          observation_id: i.observation,
          outcome: state === 'retained' ? { state, review: rows[0] } : { state },
        },
      });
    }
    if (init?.method === 'POST') {
      const op = loadReviewOperation(localStorage, i.tenant, i.actor)!;
      expect(init.body).toBe(op.bodyUtf8);
      expect(new Headers(init.headers).get('Idempotency-Key')).toBe(op.operationKey);
      if (post === 'interrupted') throw new Error('transport');
      if (post === 'refused')
        return Response.json({ error: { code: 'stale_review' } }, { status: 409 });
      if (post === 'malformed') return Response.json({ data: {} });
      const body = JSON.parse(op.bodyUtf8);
      const target = body.target;
      rows = [
        {
          ...f.row,
          operation_key: op.operationKey,
          decision: body.decision,
          justification: body.justification,
          previous_review_id: body.expectedPreviousReviewId,
          ...(target.kind === 'vibhaag_indicator'
            ? {
                target_kind: 'vibhaag_indicator',
                page: target.page,
                form_ordinal: target.formOrdinal,
                control_ordinal: target.controlOrdinal,
                content_sha256: target.expectedContentSha256,
                source_indicator:
                  f.observation.agent === 'vibhaag' ? f.observation.output.indicators[0]! : null,
              }
            : {}),
        },
      ];
      return Response.json({ data: rows[0], created: true, replayed: false });
    }
    if (path.includes('/reviews?'))
      return Response.json({
        data: rows,
        meta: { limit: 20, hasMore: more, nextCursor: more ? 'cursor' : null },
      });
    throw new Error(path);
  });
  vi.stubGlobal('fetch', fetcher);
  const view = (canReview = true, observation: typeof f.observation | null = f.observation) =>
    render(
      <SourceReview
        tenantId={i.tenant}
        actorId={i.actor}
        canReview={canReview}
        observation={observation}
        onWriteLock={vi.fn()}
      />,
    );
  return {
    ...f,
    fetcher,
    view,
    setPost: (s: string) => (post = s),
    setState: (s: string) => (state = s),
    setRows: (r: PublicSourceReview[], m = false) => {
      rows = r;
      more = m;
    },
    setCorrupt: (s: string) => (corrupt = s),
  };
}
async function reason(text = '  Saved attributes reviewed.  ') {
  await screen.findByText('No judgment recorded for this target.');
  fireEvent.change(screen.getByLabelText('Reason (required)'), { target: { value: text } });
}
async function submit() {
  fireEvent.click(screen.getByRole('button', { name: 'Record human judgment' }));
}
async function retained() {
  return screen.findByRole('region', { name: 'Retained human review request' });
}
it('records reviewer-only human decisions, preserves raw codepoint notes and does not close assessment', async () => {
  const f = await fixture();
  f.view();
  await reason('😀'.repeat(2000));
  await submit();
  await screen.findByText(/Human source judgment recorded/);
  expect(f.fetcher.mock.calls.filter(([, v]) => v?.method === 'POST')).toHaveLength(1);
  expect(await screen.findByText(/Current whole observation judgment: acknowledged/)).toBeTruthy();
  expect(loadReviewOperation(localStorage, i.tenant, i.actor)).toBeNull();
  expect(screen.getByText(/Assessment closure remains a separate action/)).toBeTruthy();
});
it('separates indicator judgment from whole observation current state', async () => {
  const f = await fixture();
  f.view();
  await reason();
  fireEvent.change(screen.getByLabelText('Review target'), {
    target: { value: 'root/1/2/' + 'a'.repeat(64) },
  });
  fireEvent.change(screen.getByLabelText('Reason (required)'), {
    target: { value: '  Indicator is tentative.\n  ' },
  });
  fireEvent.change(screen.getByLabelText('Human judgment'), { target: { value: 'disputed' } });
  await submit();
  await screen.findByText(/Human source judgment recorded/);
  expect(await screen.findByText('No judgment recorded for this target.')).toBeTruthy();
  const post = f.fetcher.mock.calls.find(([, v]) => v?.method === 'POST')!;
  expect(JSON.parse(String(post[1]!.body))).toMatchObject({
    decision: 'disputed',
    justification: '  Indicator is tentative.\n  ',
    target: { kind: 'vibhaag_indicator', controlOrdinal: 2 },
  });
  fireEvent.change(screen.getByLabelText('Review target'), {
    target: { value: 'root/1/2/' + 'a'.repeat(64) },
  });
  await screen.findByText('Current indicator judgment: disputed');
});
it('does not offer write controls or POST for a viewer', async () => {
  const f = await fixture();
  f.setRows([f.row]);
  f.view(false);
  await screen.findByText(/Current whole observation judgment/);
  expect(screen.queryByLabelText('Reason (required)')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Record human judgment' })).toBeNull();
  expect(f.fetcher.mock.calls.every(([, v]) => v?.method === 'GET')).toBe(true);
});
it.each(['empty', 'whitespace', 'overlong'])(
  'requires a valid %s reason before POST',
  async (kind) => {
    const f = await fixture();
    f.view();
    await reason(kind === 'empty' ? '' : kind === 'whitespace' ? ' \n ' : '😀'.repeat(2001));
    expect(
      (screen.getByRole('button', { name: 'Record human judgment' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(f.fetcher.mock.calls.filter(([, v]) => v?.method === 'POST')).toHaveLength(0);
  },
);
it.each(['missing', 'duplicate', 'superseded'])(
  'disables recording with %s current chain head',
  async (kind) => {
    const f = await fixture();
    const rows =
      kind === 'duplicate'
        ? [f.row, { ...f.row, review_id: i.check }]
        : [{ ...f.row, is_current: false }];
    f.setRows(
      kind === 'missing'
        ? Array.from({ length: 20 }, (_, n) => ({
            ...f.row,
            target_kind: 'vibhaag_indicator',
            page: 'root',
            form_ordinal: 1,
            control_ordinal: 2,
            content_sha256: 'a'.repeat(64),
            source_indicator:
              f.observation.agent === 'vibhaag' ? f.observation.output.indicators[0]! : null,
            review_id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
            is_current: n === 0,
          }))
        : rows,
      kind === 'missing',
    );
    f.view();
    await screen.findByText(/Current judgment is unresolved/);
    fireEvent.change(screen.getByLabelText('Reason (required)'), { target: { value: 'Reviewed' } });
    expect(
      (screen.getByRole('button', { name: 'Record human judgment' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  },
);
it.each(['interrupted', 'malformed'])(
  'holds %s outcomes across reload and recovers original scope with no selected result',
  async (post) => {
    const f = await fixture();
    f.setPost(post);
    const v = f.view();
    await reason();
    await submit();
    await retained();
    await screen.findByRole('alert');
    const original = loadReviewOperation(localStorage, i.tenant, i.actor)!;
    v.unmount();
    f.view(true, null);
    await retained();
    fireEvent.click(screen.getByRole('button', { name: 'Reconcile retained review' }));
    await screen.findByRole('button', { name: 'Retry exact retained review' });
    f.setPost('ok');
    fireEvent.click(screen.getByRole('button', { name: 'Retry exact retained review' }));
    await screen.findByText(/Human source judgment recorded/);
    const posts = f.fetcher.mock.calls.filter(([, v]) => v?.method === 'POST');
    expect(posts).toHaveLength(2);
    expect(
      posts.every(
        ([, v]) =>
          v?.body === original.bodyUtf8 &&
          new Headers(v.headers).get('Idempotency-Key') === original.operationKey,
      ),
    ).toBe(true);
    const request = f.fetcher.mock.calls.find(([url]) =>
      String(url).includes('/reviews/request?'),
    )!;
    expect(new Headers(request[1]!.headers).get('X-Public-Source-Request-Key')).toBe(
      original.operationKey,
    );
  },
);
it('offers explicit refused discard only after matching original-key not_found, then reloads history', async () => {
  const f = await fixture();
  f.setPost('refused');
  f.view();
  await reason();
  await submit();
  await screen.findByRole('alert');
  expect(loadReviewOperation(localStorage, i.tenant, i.actor)?.refusalCode).toBe('stale_review');
  expect(
    screen.queryByRole('button', { name: 'Discard refused request and reload current review' }),
  ).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Reconcile retained review' }));
  await screen.findByRole('button', { name: 'Discard refused request and reload current review' });
  expect(screen.queryByRole('button', { name: 'Retry exact retained review' })).toBeNull();
  fireEvent.click(
    screen.getByRole('button', { name: 'Discard refused request and reload current review' }),
  );
  await screen.findByText('No judgment recorded for this target.');
  expect(loadReviewOperation(localStorage, i.tenant, i.actor)).toBeNull();
  expect(f.fetcher.mock.calls.filter(([, v]) => v?.method === 'POST')).toHaveLength(1);
});
it.each(['tenant', 'actor', 'key'])(
  'refuses mismatched reconciliation %s and focuses error without retry/discard',
  async (field) => {
    const f = await fixture();
    f.setPost('interrupted');
    f.view();
    await reason();
    await submit();
    await screen.findByRole('alert');
    f.setCorrupt(field);
    fireEvent.click(screen.getByRole('button', { name: 'Reconcile retained review' }));
    await waitFor(() => expect(document.activeElement?.getAttribute('role')).toBe('alert'));
    expect(loadReviewOperation(localStorage, i.tenant, i.actor)).not.toBeNull();
    expect(screen.queryByRole('button', { name: 'Retry exact retained review' })).toBeNull();
  },
);
it('does not dispatch when durable journal persistence fails', async () => {
  const f = await fixture();
  f.view();
  await reason();
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new Error('quota');
  });
  await submit();
  await screen.findByRole('alert');
  expect(f.fetcher.mock.calls.filter(([, v]) => v?.method === 'POST')).toHaveLength(0);
});
it('recovers retained review only by pairing its raw intent and source with original scope', async () => {
  const f = await fixture();
  const body = {
    engagementId: i.engagement,
    expectedOutputSha256: f.row.output_sha256,
    expectedProjectionSha256: f.row.projection_sha256,
    target: { kind: 'whole_observation' },
    decision: 'acknowledged',
    justification: f.row.justification,
    expectedPreviousReviewId: null,
  };
  const op = reviewOperationSchema.parse({
    version: 1,
    tenantId: i.tenant,
    actorId: i.actor,
    operationKey: i.check,
    engagementId: i.engagement,
    bindingId: i.binding,
    observationId: i.observation,
    checkId: i.check,
    agent: 'vibhaag',
    rootSha256: f.row.root_content_sha256,
    outputSha256: f.row.output_sha256,
    projectionSha256: f.row.projection_sha256,
    bodyUtf8: JSON.stringify(body),
  });
  saveReviewOperation(localStorage, op);
  f.setState('retained');
  f.setRows([f.row]);
  f.view(true, null);
  await retained();
  fireEvent.click(screen.getByRole('button', { name: 'Reconcile retained review' }));
  await screen.findByText(/Original human source judgment recovered/);
  expect(loadReviewOperation(localStorage, i.tenant, i.actor)).toBeNull();
  expect(f.fetcher.mock.calls.filter(([, v]) => v?.method === 'POST')).toHaveLength(0);
});
it('holds invalid scoped storage and locks all writes', async () => {
  const f = await fixture();
  localStorage.setItem(reviewStorageKey(i.tenant, i.actor), '{broken');
  f.view();
  await screen.findByRole('alert');
  expect(
    (screen.getByRole('button', { name: 'Record human judgment' }) as HTMLButtonElement).disabled,
  ).toBe(true);
});

it('uses the current predecessor and keeps it unchanged when a concurrent reviewer causes refusal', async () => {
  const f = await fixture();
  f.setRows([f.row]);
  f.setPost('refused');
  f.view();
  await screen.findByText(/Current whole observation judgment/);
  fireEvent.change(screen.getByLabelText('Reason (required)'), {
    target: { value: 'Further review' },
  });
  await submit();
  await screen.findByRole('alert');
  const original = loadReviewOperation(localStorage, i.tenant, i.actor)!;
  expect(JSON.parse(original.bodyUtf8).expectedPreviousReviewId).toBe(f.row.review_id);
  expect(screen.queryByRole('button', { name: 'Retry exact retained review' })).toBeNull();
});
it('keeps unknown not_found outcomes limited to exact retry and never offers discard', async () => {
  const f = await fixture();
  f.setPost('interrupted');
  f.view();
  await reason();
  await submit();
  await screen.findByRole('alert');
  fireEvent.click(screen.getByRole('button', { name: 'Reconcile retained review' }));
  await screen.findByRole('button', { name: 'Retry exact retained review' });
  expect(
    screen.queryByRole('button', { name: 'Discard refused request and reload current review' }),
  ).toBeNull();
});
it('reconciles the original observation when another retained observation is selected', async () => {
  const f = await fixture();
  f.setPost('interrupted');
  const v = f.view();
  await reason();
  await submit();
  await screen.findByRole('alert');
  const original = loadReviewOperation(localStorage, i.tenant, i.actor)!;
  v.rerender(
    <SourceReview
      tenantId={i.tenant}
      actorId={i.actor}
      canReview
      observation={{ ...f.observation, observation_id: i.run }}
      onWriteLock={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Reconcile retained review' }));
  await screen.findByRole('button', { name: 'Retry exact retained review' });
  const read = f.fetcher.mock.calls.find(([url]) => String(url).includes('/reviews/request?'))!;
  expect(String(read[0])).toContain(`/observations/${original.observationId}/reviews/request?`);
  expect(String(read[0])).not.toContain(`/observations/${i.run}/`);
});
it('loads later history before assuming an unreviewed target, and detects overlapping pages', async () => {
  const f = await fixture();
  const rows = Array.from({ length: 20 }, (_, n) => ({
    ...f.row,
    review_id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    target_kind: 'vibhaag_indicator' as const,
    page: 'root' as const,
    form_ordinal: 1,
    control_ordinal: 2,
    content_sha256: 'a'.repeat(64),
    source_indicator:
      f.observation.agent === 'vibhaag' ? f.observation.output.indicators[0]! : null,
    is_current: n === 0,
  }));
  f.setRows(rows, true);
  f.view();
  await screen.findByText(/Current judgment is unresolved/);
  fireEvent.click(screen.getByRole('button', { name: 'Load more review history' }));
  await screen.findByRole('alert');
  expect(
    (screen.getByRole('button', { name: 'Record human judgment' }) as HTMLButtonElement).disabled,
  ).toBe(true);
  f.setRows([f.row]);
  fireEvent.click(screen.getByRole('button', { name: 'Refresh review history' }));
  await screen.findByText(/Current whole observation judgment/);
});
it('retains original intent when server reconciliation returns mismatched raw reason', async () => {
  const f = await fixture();
  f.setPost('interrupted');
  f.view();
  await reason();
  await submit();
  await screen.findByRole('alert');
  const op = loadReviewOperation(localStorage, i.tenant, i.actor)!;
  f.setRows([
    { ...f.row, operation_key: op.operationKey, justification: f.row.justification.trim() },
  ]);
  f.setState('retained');
  fireEvent.click(screen.getByRole('button', { name: 'Reconcile retained review' }));
  await screen.findByText(/differs from this original request/);
  expect(loadReviewOperation(localStorage, i.tenant, i.actor)).toEqual(op);
  expect(
    screen.queryByRole('button', { name: 'Discard refused request and reload current review' }),
  ).toBeNull();
});
