import { describe, expect, it } from 'vitest';
import {
  publicCoverageClarificationRequestSchema as requestSchema,
  publicCoverageClarificationSnapshotSchema as snapshotSchema,
  publicCoverageClarificationRecordSchema as recordSchema,
} from './public-coverage-clarifications';

const id = 'ABCDEFAB-CDEF-4ABC-8DEF-ABCDEFABCDEF';
const digest = 'a'.repeat(64);
const entry = {
  page: 'contact',
  sourceState: 'unavailable',
  sourceTruncated: false,
  reasonCategory: 'needs_investigation',
  reason: '  Owner requests examination of the missing contact and grievance page.  ',
  proposedPublicUrl: null,
};
const intent = {
  version: 1,
  operationKey: id,
  engagementId: id,
  checkId: id,
  payloadSha256: digest,
  expectedPreviousRevisionId: null,
  clarifications: [entry],
};
const snapshot = {
  version: 1,
  disposition: 'owner_declarations_unverified',
  tenantId: id,
  actorId: id,
  revisionId: id,
  previousRevisionId: null,
  recordedAt: '2026-10-21T00:00:00Z',
  request: intent,
};

describe('untrusted owner coverage contract', () => {
  it('normalizes UUID case and reason whitespace without inventing examined evidence', () => {
    const value = requestSchema.parse(intent);
    expect(value.operationKey).toBe(id.toLowerCase());
    expect(value.checkId).toBe(id.toLowerCase());
    expect(value.clarifications[0]).toEqual({ ...entry, reason: entry.reason.trim() });
    expect(value.clarifications[0]!.sourceState).toBe('unavailable');
    expect(snapshotSchema.parse(snapshot).disposition).toBe('owner_declarations_unverified');
  });
  it('refuses duplicate page declarations instead of letting one reason shadow another', () => {
    expect(
      requestSchema.safeParse({
        ...intent,
        clarifications: [
          entry,
          { ...entry, reason: 'A different owner explanation that must not shadow the first.' },
        ],
      }).success,
    ).toBe(false);
  });
  it.each(['\u0000', '\n', '\u007f', '\ud800'])('refuses unsafe reason scalar %j', (control) => {
    expect(
      requestSchema.safeParse({
        ...intent,
        clarifications: [
          {
            ...entry,
            reason: `Owner explains critical missing page ${control} and requests inspection.`,
          },
        ],
      }).success,
    ).toBe(false);
  });
  it('refuses fabricated dispositions, unknown authority fields and incomplete reasons', () => {
    expect(
      snapshotSchema.safeParse({ ...snapshot, disposition: 'owner_evidence_verified' }).success,
    ).toBe(false);
    expect(requestSchema.safeParse({ ...intent, approved: true }).success).toBe(false);
    for (const reason of [' ', 'too short', 'x'.repeat(2001)])
      expect(
        requestSchema.safeParse({ ...intent, clarifications: [{ ...entry, reason }] }).success,
      ).toBe(false);
    expect(
      requestSchema.safeParse({
        ...intent,
        clarifications: [{ ...entry, sourceState: 'compliant' }],
      }).success,
    ).toBe(false);
  });
  it('retains large decimal ledger receipts without lossy number conversion', () => {
    const receipt = '900719925474099312345678';
    const value = {
      id,
      tenantId: id,
      actorId: id,
      engagementId: id,
      checkId: id,
      payloadSha256: digest,
      operationKey: id,
      requestText: '{}',
      requestSha256: digest,
      snapshotText: '{}',
      snapshotSha256: digest,
      receiptId: receipt,
    };
    expect(recordSchema.parse(value).receiptId).toBe(receipt);
    for (const receiptId of [0, 9007199254740992, '0', '-1', '1.5', id])
      expect(recordSchema.safeParse({ ...value, receiptId }).success).toBe(false);
  });
});
