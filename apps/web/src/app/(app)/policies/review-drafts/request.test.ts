// @vitest-environment jsdom
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { canonicalJson, sha256 } from '@axiom/ledger';
import {
  draftKey,
  readDraftJournal,
  retainDraftJournal,
  retainDraftAcknowledgement,
  readDraftSource,
  submitDraft,
  recoverDraft,
  resolveDraftAcknowledgement,
  archiveDraftReference,
  draftMatchesJournal,
  acknowledgementMatchesJournal,
  type DraftJournal,
} from './request';
const fixture = JSON.parse(
  readFileSync('../../packages/types/src/__fixtures__/reviewed-workflow-drafts.json', 'utf8'),
);
const actor = '77777777-7777-4777-8777-777777777777',
  key = '88888888-8888-4888-8888-888888888888',
  run = '99999999-9999-4999-8999-999999999999',
  ackKey = '60000000-0000-4000-8000-000000000006';
const journal = (): DraftJournal => ({
  version: 1,
  tenantId: fixture.input.tenant_id,
  actorId: actor,
  input: structuredClone(fixture.input),
  request: {
    engagementId: fixture.input.engagement_id,
    recordIds: fixture.input.records.map((r: { id: string }) => r.id),
    sourceDigest: fixture.input.source_records_sha256,
    operationKey: key,
    confirmSourceReview: true,
  },
});
async function response() {
  const inputHash = await sha256(canonicalJson(fixture.input)),
    outputHash = await sha256(canonicalJson(fixture.output));
  return {
    data: structuredClone(fixture.output),
    invocation: {
      runId: run,
      correlationId: key,
      requestHash: inputHash,
      responseHash: outputHash,
    },
    outputProof: {
      kind: 'settled_output_recorded',
      tenantId: fixture.input.tenant_id,
      actorId: actor,
      operationKey: key,
      runId: run,
      requestHash: inputHash,
      responseHash: outputHash,
      requestedReceipt: '1',
      startedReceipt: '2',
      completedReceipt: '3',
      settledReceipt: '4',
    },
  };
}
async function withAck() {
  const j = journal();
  j.acknowledgement = {
    operationKey: ackKey,
    body: {
      runId: run,
      outputHash: await sha256(canonicalJson(fixture.output)),
      policyIndex: 0,
      reason: 'Reviewed original human declarations; legal review is separate',
      confirmReview: true,
    },
  };
  return j;
}
async function acknowledgement(j: DraftJournal, status = 'draft') {
  return {
    data: {
      acknowledgement_id: ackKey,
      receipt_id: '6',
      policy_draft_id: run,
      replayed: true,
      manifest: {
        kind: 'reviewed_workflow_acknowledgement_recorded',
        tenantId: j.tenantId,
        actorId: actor,
        operationKey: ackKey,
        originalOperationKey: key,
        runId: run,
        inputHash: await sha256(canonicalJson(j.input)),
        outputHash: j.acknowledgement!.body.outputHash,
        sourceDigest: j.input.source_records_sha256,
        bodyHash: await sha256(canonicalJson(j.acknowledgement!.body)),
        acknowledgementId: ackKey,
        receiptId: '6',
        policyIndex: 0,
        policyDraftId: run,
        policyReceipt: '5',
        initialPolicyStatus: 'draft',
        currentPolicyStatus: status,
        requestedReceipt: '1',
        startedReceipt: '2',
        completedReceipt: '3',
        settledReceipt: '4',
      },
    },
  };
}
const fetchMock = vi.fn();
beforeEach(() => {
  localStorage.clear();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('crypto', webcrypto);
});
afterEach(() => vi.unstubAllGlobals());
it('retains original actor/body/ordered source and refuses overwritten or unparseable journals', () => {
  const j = journal();
  retainDraftJournal(localStorage, j);
  expect(readDraftJournal(localStorage, j.tenantId, actor)).toEqual(j);
  expect(() =>
    retainDraftJournal(localStorage, { ...j, request: { ...j.request, operationKey: ackKey } }),
  ).toThrow();
  localStorage.setItem(draftKey(j.tenantId, actor), 'broken');
  expect(() => readDraftJournal(localStorage, j.tenantId, actor)).toThrow();
  expect(fetchMock).not.toHaveBeenCalled();
});
it('storage failed readback refuses submission and retains uncertainty', () => {
  const j = journal();
  expect(() => retainDraftJournal({ getItem: () => null, setItem: () => {} }, j)).toThrow(
    /retained/,
  );
  expect(fetchMock).not.toHaveBeenCalled();
});
it('source GET checks exact selected order/hash/context and refuses unreviewed extra facts', async () => {
  const j = journal();
  fetchMock.mockResolvedValue(new Response(JSON.stringify({ input: j.input })));
  expect(
    await readDraftSource(j.tenantId, actor, j.input.engagement_id, j.request.recordIds),
  ).toEqual(j.input);
  fetchMock.mockResolvedValue(
    new Response(JSON.stringify({ input: { ...j.input, tenant_id: actor } })),
  );
  await expect(
    readDraftSource(j.tenantId, actor, j.input.engagement_id, j.request.recordIds),
  ).rejects.toThrow();
  expect(fetchMock.mock.calls[0]![1]).not.toHaveProperty('method', 'POST');
});
it('lost response preserves exact original key/body, explicit same request retry and GET recovery', async () => {
  const j = journal();
  retainDraftJournal(localStorage, j);
  fetchMock
    .mockRejectedValueOnce(new Error('network lost'))
    .mockResolvedValueOnce(new Response(JSON.stringify(await response())))
    .mockResolvedValueOnce(new Response(JSON.stringify(await response())));
  await expect(submitDraft(j)).rejects.toThrow();
  expect(readDraftJournal(localStorage, j.tenantId, actor)).toEqual(j);
  const output = await submitDraft(j);
  expect(draftMatchesJournal(output, j)).toBe(true);
  expect(fetchMock.mock.calls[0]![1].body).toBe(fetchMock.mock.calls[1]![1].body);
  expect(fetchMock.mock.calls[1]![1].headers['Idempotency-Key']).toBe(key);
  await recoverDraft(j);
  expect(fetchMock.mock.calls[2]![1]).not.toHaveProperty('method', 'POST');
  expect(readDraftJournal(localStorage, j.tenantId, actor)).toEqual(j);
});
it.each(['actor', 'hash', 'receipt', 'content', 'key'])(
  'refuses %s altered server output authority',
  async (kind) => {
    const j = journal(),
      r = await response();
    if (kind === 'actor') r.outputProof.actorId = key;
    if (kind === 'hash') r.outputProof.requestHash = 'f'.repeat(64);
    if (kind === 'receipt') r.outputProof.completedReceipt = '1';
    if (kind === 'key') r.outputProof.operationKey = ackKey;
    if (kind === 'content') {
      r.data.policy_drafts[0].content += ' Independently verified compliant.';
      r.invocation.responseHash = await sha256(canonicalJson(r.data));
      r.outputProof.responseHash = r.invocation.responseHash;
    }
    fetchMock.mockResolvedValue(new Response(JSON.stringify(r)));
    await expect(recoverDraft(j)).rejects.toThrow();
    expect(readDraftJournal(localStorage, j.tenantId, actor)).toBeNull();
  },
);
it('read-only missing acknowledgement never automatically saves or clears its retained key', async () => {
  const j = await withAck();
  retainDraftJournal(localStorage, j);
  fetchMock.mockResolvedValue(new Response(JSON.stringify({ missing: true }), { status: 404 }));
  await expect(resolveDraftAcknowledgement(j, true)).rejects.toThrow(/unconfirmed/);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toMatchObject({
    readOnly: true,
    operationKey: ackKey,
    acknowledgement: j.acknowledgement!.body,
  });
  expect(readDraftJournal(localStorage, j.tenantId, actor)).toEqual(j);
});
it('lost acknowledgement response keeps exact body and recovers historical initial draft with current approved status', async () => {
  const j = journal();
  retainDraftJournal(localStorage, j);
  const wanted = await withAck(),
    retained = retainDraftAcknowledgement(localStorage, j, wanted.acknowledgement!);
  fetchMock
    .mockRejectedValueOnce(new Error('lost'))
    .mockResolvedValueOnce(
      new Response(JSON.stringify(await acknowledgement(retained, 'approved'))),
    );
  await expect(resolveDraftAcknowledgement(retained, false)).rejects.toThrow();
  const recovered = await resolveDraftAcknowledgement(retained, true);
  expect(recovered.data.manifest).toMatchObject({
    initialPolicyStatus: 'draft',
    currentPolicyStatus: 'approved',
  });
  expect(acknowledgementMatchesJournal(recovered, retained)).toBe(true);
  const first = JSON.parse(fetchMock.mock.calls[0]![1].body),
    second = JSON.parse(fetchMock.mock.calls[1]![1].body);
  delete second.readOnly;
  expect(first).toEqual(second);
  expect(() =>
    retainDraftAcknowledgement(localStorage, retained, {
      ...wanted.acknowledgement!,
      operationKey: key,
    }),
  ).toThrow();
});
it('archive requires genuinely validated proof and exact current journal including acknowledgement across tabs', async () => {
  const j = await withAck();
  retainDraftJournal(localStorage, j);
  fetchMock
    .mockResolvedValueOnce(new Response(JSON.stringify(await response())))
    .mockResolvedValueOnce(new Response(JSON.stringify(await acknowledgement(j, 'published'))));
  const output = await recoverDraft(j),
    ack = await resolveDraftAcknowledgement(j, true);
  expect(() => archiveDraftReference(localStorage, j, structuredClone(output), ack)).toThrow();
  expect(() => archiveDraftReference(localStorage, j, output)).toThrow();
  const changed = {
    ...j,
    acknowledgement: {
      ...j.acknowledgement!,
      body: { ...j.acknowledgement!.body, reason: 'Other tab changed reason' },
    },
  };
  localStorage.setItem(draftKey(j.tenantId, actor), JSON.stringify(changed));
  expect(() => archiveDraftReference(localStorage, j, output, ack)).toThrow();
  localStorage.setItem(draftKey(j.tenantId, actor), JSON.stringify(j));
  archiveDraftReference(localStorage, j, output, ack);
  expect(readDraftJournal(localStorage, j.tenantId, actor)).toBeNull();
});
it('archive requires acknowledgement receipts to match the same confirmed output lifecycle', async () => {
  const j = await withAck();
  retainDraftJournal(localStorage, j);
  const forged = await acknowledgement(j);
  forged.data.receipt_id = '7';
  Object.assign(forged.data.manifest, {
    receiptId: '7',
    requestedReceipt: '2',
    startedReceipt: '3',
    completedReceipt: '4',
    settledReceipt: '5',
    policyReceipt: '6',
  });
  fetchMock
    .mockResolvedValueOnce(new Response(JSON.stringify(await response())))
    .mockResolvedValueOnce(new Response(JSON.stringify(forged)));
  const output = await recoverDraft(j),
    ack = await resolveDraftAcknowledgement(j, true);
  expect(() => archiveDraftReference(localStorage, j, output, ack)).toThrow();
  expect(readDraftJournal(localStorage, j.tenantId, actor)).toEqual(j);
});
