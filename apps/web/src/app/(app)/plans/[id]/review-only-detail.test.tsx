// @vitest-environment jsdom
import React from 'react';
import { it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ReviewOnlyDetail } from './review-only-detail';
import type { SupabaseClient } from '@supabase/supabase-js';
const fixture = JSON.parse(
  readFileSync(resolve(process.cwd(), '../../tests/contracts/sudhaar-source.v1.json'), 'utf8'),
);
const tenant = fixture.input.tenant_id,
  actor = '77777777-7777-4777-8777-777777777777',
  plan = actor;
function row() {
  return {
    tenant_id: tenant,
    actor_id: actor,
    proposal_operation_key: actor,
    adoption_key: actor,
    plan_id: plan,
    request_hash: 'a'.repeat(64),
    adoption_receipt: '5',
    adoption_receipt_text: '5',
    task_count: fixture.expectedOutput.review_tasks.length,
    reason: 'Review declarations with supporting evidence',
    source: fixture.input.source,
    output_proof: {
      runId: actor,
      inputHash: 'a'.repeat(64),
      outputHash: 'b'.repeat(64),
      requestedReceipt: '1',
      startedReceipt: '2',
      completedReceipt: '3',
      settledReceipt: '4',
    },
  };
}
function db(
  binding: unknown = row(),
  tasks = fixture.expectedOutput.review_tasks,
  error: unknown = null,
) {
  const calls: unknown[][] = [];
  const from = vi.fn((table: string) => {
    const q: Record<string, unknown> = {};
    for (const method of ['select', 'eq', 'order', 'limit'])
      q[method] = (...args: unknown[]) => {
        calls.push([table, method, ...args]);
        return q;
      };
    q.single = async () => ({ data: binding, error });
    q.then = (resolve: (v: unknown) => unknown) =>
      Promise.resolve({
        data: tasks.map((task: Record<string, unknown>) => ({ sequence: task.sequence, task })),
        error,
      }).then(resolve);
    return q;
  });
  return { client: { from } as unknown as SupabaseClient, from, calls };
}
async function render(dbClient: SupabaseClient) {
  return renderToStaticMarkup(
    await ReviewOnlyDetail({
      supabase: dbClient,
      tenantId: tenant,
      planId: plan,
      title: 'Saved source review',
    }),
  );
}
it('shows actual saved tasks/receipt/source with no execution or approval controls', async () => {
  const database = db();
  const html = await render(database.client);
  expect(html).toContain('0 corrective actions');
  expect(html).toContain('Human adoption receipt 5');
  expect(html).toContain(fixture.input.source.assessmentRunId);
  expect(html).not.toContain('<button');
  expect(html).not.toContain('Approve');
  expect(html).not.toContain('Execute');
  expect(database.from.mock.calls.map((c) => c[0])).toEqual([
    'plan_source_review_adoptions',
    'plan_source_review_tasks',
  ]);
  for (const table of ['plan_source_review_adoptions', 'plan_source_review_tasks'])
    expect(database.calls).toContainEqual([table, 'eq', 'tenant_id', tenant]);
  expect(database.calls).toContainEqual(['plan_source_review_tasks', 'limit', 501]);
});
it('foreign binding and unavailable query cannot present saved review success', async () => {
  for (const database of [
    db({ ...row(), tenant_id: actor }),
    db(null, [], { message: 'unavailable' }),
  ]) {
    const html = await render(database.client);
    expect(html).toContain('role="alert"');
    expect(html).not.toContain('Human adoption receipt');
  }
});
it('missing or duplicated tasks fail closed instead of showing partial success', async () => {
  for (const tasks of [
    [],
    [fixture.expectedOutput.review_tasks[0], fixture.expectedOutput.review_tasks[0]],
  ]) {
    const html = await render(db(row(), tasks).client);
    expect(html).toContain('role="alert"');
    expect(html).not.toContain('Human adoption receipt');
  }
});
it('invalid receipt order and executable metadata cannot become review authority', async () => {
  const html = await render(
    db({ ...row(), output_proof: { ...row().output_proof, settledReceipt: '2' } }).client,
  );
  expect(html).toContain('role="alert"');
});

it('preserves receipt IDs beyond JavaScript integer precision', async () => {
  const html = await render(
    db({ ...row(), adoption_receipt: 9007199254740992, adoption_receipt_text: '9007199254740993' })
      .client,
  );
  expect(html).toContain('Human adoption receipt 9007199254740993');
  expect(html).not.toContain('Human adoption receipt 9007199254740992');
});
