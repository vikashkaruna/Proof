import { describe, it, expect } from 'vitest';
import {
  sudhaarReviewAdoptionRequestSchema,
  sudhaarReviewAdoptionReceiptSchema,
  persistedSudhaarReviewTasksSchema,
} from './sudhaar-review-adoption';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const fixture = JSON.parse(
  readFileSync(resolve(process.cwd(), '../../tests/contracts/sudhaar-source.v1.json'), 'utf8'),
);
const uuid = '77777777-7777-4777-8777-777777777777';
function receipt() {
  return {
    tenantId: uuid,
    actorId: uuid,
    proposalOperationKey: uuid,
    adoptionKey: uuid,
    planId: uuid,
    requestHash: 'a'.repeat(64),
    adoptionReceipt: '5',
    purpose: 'source_review',
    status: 'review',
    taskCount: 1,
    actionCount: 0,
    executionAllowed: false,
    source: fixture.input.source,
    outputProof: {
      runId: uuid,
      inputHash: 'b'.repeat(64),
      outputHash: 'c'.repeat(64),
      requestedReceipt: '1',
      startedReceipt: '2',
      completedReceipt: '3',
      settledReceipt: '4',
    },
  };
}
describe('human review adoption contract', () => {
  it('requires explicit acknowledgment, reason and key without supplied tasks', () => {
    const body = {
      adoptionKey: uuid,
      acknowledgeReviewOnly: true,
      reason: 'Review declarations with supporting evidence',
    };
    expect(sudhaarReviewAdoptionRequestSchema.parse(body)).toEqual(body);
    for (const wrong of [
      { ...body, acknowledgeReviewOnly: false },
      { ...body, reason: 'short' },
      { ...body, tasks: [] },
      { ...body, actions: [] },
      { ...body, title: 'Caller title' },
    ])
      expect(sudhaarReviewAdoptionRequestSchema.safeParse(wrong).success).toBe(false);
  });
  it('forbids execution authority and inconsistent receipt order', () => {
    expect(sudhaarReviewAdoptionReceiptSchema.safeParse(receipt()).success).toBe(true);
    for (const wrong of [
      { ...receipt(), actionCount: 1 },
      { ...receipt(), executionAllowed: true },
      { ...receipt(), status: 'approved' },
      { ...receipt(), purpose: 'remediation' },
      { ...receipt(), adoptionReceipt: '4' },
      { ...receipt(), adoptionReceipt: 'invalid' },
      { ...receipt(), outputProof: { ...receipt().outputProof, completedReceipt: '2' } },
    ])
      expect(sudhaarReviewAdoptionReceiptSchema.safeParse(wrong).success).toBe(false);
  });
  it('requires complete unique task sequences and findings', () => {
    const tasks = fixture.expectedOutput.review_tasks;
    expect(persistedSudhaarReviewTasksSchema.safeParse(tasks).success).toBe(true);
    expect(persistedSudhaarReviewTasksSchema.safeParse([...tasks, tasks[0]]).success).toBe(false);
    expect(
      persistedSudhaarReviewTasksSchema.safeParse([{ ...tasks[0], sequence: 2 }]).success,
    ).toBe(false);
  });
});
