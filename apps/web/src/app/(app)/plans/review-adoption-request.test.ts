// @vitest-environment jsdom
import { it, expect, vi, afterEach } from 'vitest';
import type { ConfirmedProposal } from './proposal-request';
import { canonicalJson, sha256 } from '@axiom/ledger';
import {
  archiveConfirmedReviewAdoption,
  readCompletedReviewAdoptionReference,
  readReviewAdoptionJournal,
  retainReviewAdoptionJournal,
  reviewAdoptionJournalKey,
  submitReviewAdoption,
} from './review-adoption-request';
const tenantId = '11111111-1111-4111-8111-111111111111',
  actorId = '22222222-2222-4222-8222-222222222222',
  proposalOperationKey = '33333333-3333-4333-8333-333333333333';
const journal = () => ({
  version: 1 as const,
  tenantId,
  actorId,
  proposalOperationKey,
  request: {
    adoptionKey: '44444444-4444-4444-8444-444444444444',
    acknowledgeReviewOnly: true as const,
    reason: 'Review declarations with supporting evidence',
  },
});
afterEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
});
it('requires exact durable readback and refuses silent storage loss or rewriting', () => {
  const setItem = vi.fn();
  expect(() => retainReviewAdoptionJournal({ getItem: () => null, setItem }, journal())).toThrow(
    'could not be retained',
  );
  let raw: string | null = null;
  expect(() =>
    retainReviewAdoptionJournal(
      {
        getItem: () => raw,
        setItem: (_k, v) => {
          raw = v + ' ';
        },
      },
      journal(),
    ),
  ).toThrow('could not be retained');
});
it('binds tenant, actor and immutable exact request across tabs', () => {
  retainReviewAdoptionJournal(localStorage, journal());
  expect(readReviewAdoptionJournal(localStorage, tenantId, actorId)).toEqual(journal());
  expect(() =>
    retainReviewAdoptionJournal(localStorage, {
      ...journal(),
      request: { ...journal().request, reason: 'Different reason with enough detail' },
    }),
  ).toThrow('retained review');
  localStorage.setItem(
    reviewAdoptionJournalKey(tenantId, actorId),
    JSON.stringify({ ...journal(), actorId: tenantId }),
  );
  expect(() => readReviewAdoptionJournal(localStorage, tenantId, actorId)).toThrow(
    'another session',
  );
});
it('posts the strict original body and exact actor/key and accepts only matching saved receipt', async () => {
  const value = journal();
  const requestHash = await sha256(
    canonicalJson({ tenantId, actorId, proposalOperationKey, ...value.request }),
  );
  const receipt = {
    tenantId,
    actorId,
    proposalOperationKey,
    adoptionKey: value.request.adoptionKey,
    planId: tenantId,
    requestHash,
    adoptionReceipt: '5',
    purpose: 'source_review',
    status: 'review',
    taskCount: 1,
    actionCount: 0,
    executionAllowed: false,
    source: {
      assessmentRunId: tenantId,
      libraryVersion: 'v1',
      libraryDigest: 'a'.repeat(64),
      resultDigest: 'b'.repeat(64),
      finalizedReceipt: '1',
    },
    outputProof: {
      runId: tenantId,
      inputHash: 'b'.repeat(64),
      outputHash: 'c'.repeat(64),
      requestedReceipt: '1',
      startedReceipt: '2',
      completedReceipt: '3',
      settledReceipt: '4',
    },
  };
  const fetcher = vi.fn().mockResolvedValue({ status: 201, json: async () => receipt });
  vi.stubGlobal('fetch', fetcher);
  const validated = await submitReviewAdoption(value);
  expect(validated).toEqual(receipt);
  const confirmed = {
    proposal: { source: receipt.source, review_tasks: [{}] },
    outputProof: {
      ...receipt.outputProof,
      requestHash: receipt.outputProof.inputHash,
      responseHash: receipt.outputProof.outputHash,
    },
  } as unknown as ConfirmedProposal;
  retainReviewAdoptionJournal(localStorage, value);
  expect(() =>
    archiveConfirmedReviewAdoption(localStorage, value, { ...validated }, confirmed),
  ).toThrow('Confirm the saved');
  expect(() =>
    archiveConfirmedReviewAdoption(localStorage, value, validated, {
      ...confirmed,
      outputProof: { ...confirmed.outputProof, responseHash: 'f'.repeat(64) },
    }),
  ).toThrow('source could not');
  expect(readReviewAdoptionJournal(localStorage, tenantId, actorId)).toEqual(value);
  expect(() =>
    archiveConfirmedReviewAdoption(
      {
        getItem: localStorage.getItem.bind(localStorage),
        setItem: () => {},
        removeItem: localStorage.removeItem.bind(localStorage),
      },
      value,
      validated,
      confirmed,
    ),
  ).toThrow('reference could not be retained');
  expect(() =>
    archiveConfirmedReviewAdoption(
      {
        getItem: localStorage.getItem.bind(localStorage),
        setItem: localStorage.setItem.bind(localStorage),
        removeItem: () => {},
      },
      value,
      validated,
      confirmed,
    ),
  ).toThrow('could not be archived');
  archiveConfirmedReviewAdoption(localStorage, value, validated, confirmed);
  expect(readReviewAdoptionJournal(localStorage, tenantId, actorId)).toBeNull();
  expect(
    readCompletedReviewAdoptionReference(localStorage, tenantId, actorId, proposalOperationKey),
  ).toEqual(value);
  expect(() => archiveConfirmedReviewAdoption(localStorage, value, validated, confirmed)).toThrow(
    'retained request changed',
  );
  expect(fetcher.mock.calls[0]![1].body).toBe(JSON.stringify(value.request));
  expect(fetcher.mock.calls[0]![1].headers['X-Expected-Actor-Id']).toBe(actorId);
  fetcher.mockResolvedValue({ status: 201, json: async () => ({ ...receipt, actorId: tenantId }) });
  await expect(submitReviewAdoption(value)).rejects.toThrow('could not be verified');
});
it('preserves original durable body after lost response and server refusal', async () => {
  const value = journal();
  retainReviewAdoptionJournal(localStorage, value);
  const fetcher = vi.fn().mockRejectedValue(new Error('transport lost'));
  vi.stubGlobal('fetch', fetcher);
  await expect(submitReviewAdoption(value)).rejects.toThrow('same request');
  expect(readReviewAdoptionJournal(localStorage, tenantId, actorId)).toEqual(value);
  fetcher.mockResolvedValue({ status: 409, json: async () => ({}) });
  await expect(submitReviewAdoption(value)).rejects.toThrow('same request');
  expect(readReviewAdoptionJournal(localStorage, tenantId, actorId)).toEqual(value);
});
