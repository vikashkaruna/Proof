import { createClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';
import { AssessmentScheduling } from './assessment-scheduling.js';
const id = (n: number) => `57570000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ack = {
  tenantId: id(1),
  jobId: id(2),
  leaseId: id(3),
  namespace: 'default',
  workflowId: `assessment-${id(1)}-${id(2)}`,
  workflowRunId: id(4),
};
const { workflowRunId: _run, ...ticketBase } = ack;
const ticket = {
  ...ticketBase,
  leaseUntil: new Date(Date.now() + 180000).toISOString(),
  startBefore: null,
};
const { leaseId: _lease, ...receiptBase } = ack;
const receipt = { ...receiptBase, receipt: '12' };
function fixture(reply: unknown, status = 200) {
  const fetcher = vi.fn<typeof fetch>(
    async () =>
      new Response(JSON.stringify(reply), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
  );
  const db = createClient('https://db.test.invalid', 'synthetic-key', {
    global: { fetch: fetcher },
    auth: { persistSession: false },
  });
  return {
    fetcher,
    scheduling: new AssessmentScheduling(db, { namespace: 'default', tenantId: id(1) }),
  };
}
describe('durable assessment scheduling adapter', () => {
  it('polls one opaque job using trusted namespace and tenant configuration', async () => {
    const f = fixture({ jobs: [ticket] });
    expect(await f.scheduling.reserve()).toEqual({ jobs: [ticket] });
    expect(JSON.parse(String(f.fetcher.mock.calls[0]![1]!.body))).toEqual({
      p_namespace: 'default',
      p_tenant_id: id(1),
      p_limit: 1,
    });
  });
  it.each([
    { ...ticket, tenantId: id(9) },
    { ...ticket, jobId: id(9) },
    { ...ticket, namespace: 'other' },
    { ...ticket, leaseUntil: '2000-01-01T00:00:00Z' },
    { ...ticket, input: 'private-marker' },
  ])('refuses expired, conflicting and private reservation data', async (value) => {
    await expect(fixture({ jobs: [value] }).scheduling.reserve()).rejects.toThrow(
      'Assessment scheduling unavailable',
    );
  });
  it('bounds batch size and database failure output', async () => {
    await expect(fixture({ jobs: [ticket, ticket] }).scheduling.reserve()).rejects.toThrow(
      'Assessment scheduling unavailable',
    );
    await expect(fixture({ message: 'private-marker' }, 500).scheduling.reserve()).rejects.toThrow(
      'Assessment scheduling unavailable',
    );
  });
  it('records only the matching submission receipt', async () => {
    const f = fixture(receipt);
    expect(await f.scheduling.acknowledge(ack)).toEqual(receipt);
    expect(JSON.parse(String(f.fetcher.mock.calls[0]![1]!.body))).toEqual({
      p_tenant_id: id(1),
      p_job_id: id(2),
      p_lease_id: id(3),
      p_namespace: 'default',
      p_workflow_id: ack.workflowId,
      p_workflow_run_id: id(4),
    });
  });
  it.each([
    { ...ack, tenantId: id(9) },
    { ...ack, namespace: 'other' },
    { ...ack, input: 'private-marker' },
  ])('refuses changed caller binding before persistence', async (value) => {
    const f = fixture(receipt);
    await expect(f.scheduling.acknowledge(value)).rejects.toThrow(
      'Assessment scheduling unavailable',
    );
    expect(f.fetcher).not.toHaveBeenCalled();
  });
  it.each([
    { ...receipt, workflowRunId: id(9) },
    { ...receipt, receipt: '0' },
    { ...receipt, input: 'private-marker' },
    { error: 'scheduling_refused' },
  ])('never acknowledges a malformed or mismatched result', async (value) => {
    await expect(fixture(value).scheduling.acknowledge(ack)).rejects.toThrow(
      'Assessment scheduling unavailable',
    );
  });
});
