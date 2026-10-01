import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { BatchCard, type BatchDetail } from './batch-card';

const started = '2026-09-30T10:00:00Z';
const batch: BatchDetail['batch'] = {
  id: 'batch-12345678',
  plan_id: 'plan-1',
  request_key: 'request-1',
  correlation_id: 'corr-1',
  content_digest: 'a'.repeat(64),
  mode: 'batch',
  concurrency: 1,
  stop_on_failure: true,
  status: 'halted',
  dispatch_reference: 'dispatch-1',
  started_at: started,
  finished_at: started,
  remediation_plans: { title: 'Close finding' },
};
const action: BatchDetail['actions'][number] = {
  id: 'action-1',
  sequence: 1,
  action_type: 'connector.patch',
  description: 'Patch scope',
  execution_status: 'failed',
  final_outcome: 'failed',
  executed_at: started,
  pre_state_uri: null,
  post_state_uri: null,
  execution_batch_id: batch.id,
};
const base = (): BatchDetail => ({
  batch,
  actions: [action],
  rollbacks: [],
  verifications: [],
  reconciliation: null,
});
const render = (detail: BatchDetail) => renderToStaticMarkup(<BatchCard detail={detail} />);

it('shows an unsettled in-flight batch without fabricating action or verification outcomes', () => {
  const html = render({
    ...base(),
    batch: { ...batch, status: 'dispatched', finished_at: null },
    actions: [],
  });
  expect(html).toContain('In flight');
  expect(html).toContain('No actions are recorded against this batch yet');
  expect(html).toContain('No verification was recorded');
  expect(html).not.toContain('Reconciled clean');
});

it('renders failed execution and failed rollback as needing operator review', () => {
  const html = render({
    ...base(),
    rollbacks: [
      {
        id: 'rollback-1',
        action_id: action.id,
        batch_id: batch.id,
        definition_hash: 'b'.repeat(64),
        triggered_by: 'failure_threshold',
        status: 'failed',
        result: {},
        executed_by_agent: 'nivan',
        started_at: started,
        finished_at: started,
      },
    ],
  });
  expect(html).toContain('Halted — operator review required');
  expect(html).toContain('stop-on-failure rollback');
  expect(html).toContain('The undo itself did not complete');
  expect(html).not.toContain('Reconciled clean');
});

it('shows post-execution checks and signed reconciliation drift explicitly', () => {
  const detail = base();
  detail.verifications = [
    {
      id: 'verification-1',
      action_id: action.id,
      batch_id: batch.id,
      checks: [{ name: 'state', passed: false }],
      outcome: 'failed',
      evidence_uri: 's3://proof/version-1',
      verified_by_agent: 'parikshan',
      verified_at: started,
    },
  ];
  detail.reconciliation = {
    id: 'rec-1',
    plan_id: batch.plan_id,
    batch_id: batch.id,
    approved_scope: { token_id: 'token-1', content_digest: 'a'.repeat(64) },
    executed_reality: {
      batch_status: 'halted',
      succeeded_at_finish: 0,
      failed_at_finish: 1,
      content_digest_recomputed: 'b'.repeat(64),
    },
    unexecuted: [{ action_id: 'action-2', reason: 'halted' }],
    parameter_diffs: [
      { kind: 'content_digest_drift', approved: 'a'.repeat(64), recomputed: 'b'.repeat(64) },
    ],
    verification_outcomes: { 'action-1': 'failed' },
    statement: 'Approved scope differs from execution reality.',
    statement_signature: 'c'.repeat(64),
    created_at: started,
  };
  const html = render(detail);
  expect(html).toContain('Post-execution verification (Parikshan)');
  expect(html).toContain('s3://proof/version-1');
  expect(html).toContain('Content digest drift');
  expect(html).toContain('Needs review');
  expect(html).toContain('Approved scope differs from execution reality');
  expect(html).not.toContain('Reconciled clean');
});
