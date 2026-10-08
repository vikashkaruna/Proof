import { beforeEach, it, expect, vi } from 'vitest';
import { canonicalJson, sha256 } from '@axiom/ledger';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const mock = vi.hoisted(() => {
  Object.assign(process.env, {
    ENVIRONMENT: 'test',
    SUPABASE_URL: 'http://localhost:55321',
    SUPABASE_ANON_KEY: 'a'.repeat(40),
    SUPABASE_SERVICE_KEY: 'b'.repeat(40),
    APPROVAL_SIGNING_KEY: 'k'.repeat(48),
  });
  return { recover: vi.fn() };
});
vi.mock('./sudhaar-proposal-output.js', () => ({ recoverSudhaarOutput: mock.recover }));
import { adoptSudhaarReview } from './sudhaar-review-adoption.js';
const fixture = JSON.parse(
  readFileSync(resolve(process.cwd(), '../../tests/contracts/sudhaar-source.v1.json'), 'utf8'),
);
const input = fixture.input,
  actor = '77777777-7777-4777-8777-777777777777',
  operation = '88888888-8888-4888-8888-888888888888';
const request = {
  adoptionKey: actor,
  acknowledgeReviewOnly: true as const,
  reason: 'Review declarations with supporting evidence',
};
const calls: { name: string; args: Record<string, unknown> }[] = [];
let resolved: unknown, adopted: unknown;
const writer = () =>
  ({
    rpc: (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      return {
        abortSignal: async () => ({
          data: name === 'read_sudhaar_review_adoption_source' ? resolved : adopted,
          error: null,
        }),
      };
    },
  }) as never;
beforeEach(async () => {
  calls.length = 0;
  mock.recover.mockReset();
  resolved = { input_text: canonicalJson(input) };
  const requestHash = await sha256(
    canonicalJson({
      tenantId: input.tenant_id,
      actorId: actor,
      proposalOperationKey: operation,
      ...request,
    }),
  );
  const outputProof = {
    runId: operation,
    inputHash: 'a'.repeat(64),
    outputHash: 'b'.repeat(64),
    requestedReceipt: '1',
    startedReceipt: '2',
    completedReceipt: '3',
    settledReceipt: '4',
  };
  adopted = {
    tenantId: input.tenant_id,
    actorId: actor,
    proposalOperationKey: operation,
    adoptionKey: request.adoptionKey,
    planId: actor,
    requestHash,
    adoptionReceipt: '5',
    purpose: 'source_review',
    status: 'review',
    taskCount: fixture.expectedOutput.review_tasks.length,
    actionCount: 0,
    executionAllowed: false,
    source: input.source,
    outputProof,
  };
  mock.recover.mockResolvedValue({
    data: fixture.expectedOutput,
    invocation: {
      runId: operation,
      requestHash: outputProof.inputHash,
      responseHash: outputProof.outputHash,
    },
    outputProof,
  });
});
it('resolves canonical source and verifies genuine settled output before atomic human write', async () => {
  expect(await adoptSudhaarReview(input.tenant_id, actor, operation, request, writer)).toEqual(
    adopted,
  );
  expect(calls.map((c) => c.name)).toEqual([
    'read_sudhaar_review_adoption_source',
    'adopt_sudhaar_review',
  ]);
  expect(calls[1]?.args).not.toHaveProperty('tasks');
  expect(calls[1]?.args).not.toHaveProperty('actions');
  expect(calls[1]?.args.p_expected_output_hash).toBe('b'.repeat(64));
});
it('missing, foreign and noncanonical original source cannot reach adoption', async () => {
  for (const value of [
    { error: 'not_found' },
    { input_text: canonicalJson({ ...input, tenant_id: actor }) },
    { input_text: JSON.stringify(input) + ' ' },
  ]) {
    resolved = value;
    calls.length = 0;
    await expect(
      adoptSudhaarReview(input.tenant_id, actor, operation, request, writer),
    ).rejects.toThrow('review_source_unavailable');
    expect(calls.map((c) => c.name)).toEqual(['read_sudhaar_review_adoption_source']);
  }
});
it('uncertain historical output cannot regenerate or write a plan', async () => {
  mock.recover.mockResolvedValue(null);
  await expect(
    adoptSudhaarReview(input.tenant_id, actor, operation, request, writer),
  ).rejects.toThrow('review_source_unavailable');
  expect(calls).toHaveLength(1);
});
it('mismatched returned actor/source/receipt/action authority cannot be presented as success', async () => {
  for (const change of [
    { actorId: input.tenant_id },
    { actionCount: 1 },
    { source: { ...input.source, resultDigest: 'c'.repeat(64) } },
    {
      outputProof: {
        ...((adopted as Record<string, unknown>).outputProof as object),
        settledReceipt: '3',
      },
    },
  ]) {
    const previous = adopted;
    adopted = { ...(previous as object), ...change };
    await expect(
      adoptSudhaarReview(input.tenant_id, actor, operation, request, writer),
    ).rejects.toThrow('review_adoption_conflict');
    adopted = previous;
  }
});
