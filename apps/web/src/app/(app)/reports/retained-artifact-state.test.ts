import { describe, expect, it } from 'vitest';
import {
  RECEIPT_REFRESH_DELAYS_MS,
  applyRetainedBuild,
  awaitsReceipt,
  mergeRetainedRequests,
  nextReceiptRefreshDelay,
  retainedBuildResultSchema,
} from './retained-artifact-state';

const reportId = '11111111-1111-4111-8111-111111111111';
const otherReportId = '22222222-2222-4222-8222-222222222222';
const operationKey = '33333333-3333-4333-8333-333333333333';
const pdf = {
  sha256: 'a'.repeat(64),
  byteSize: 42,
  retainUntil: '2027-10-01T00:00:00Z',
};

function request(id: string, status: 'not_started' | 'pending' | 'settled') {
  return {
    reportId: id,
    reportStatus: 'approved',
    artifact: {
      reportStatus: 'approved',
      status,
      operationKey: status === 'not_started' ? null : operationKey,
      lastErrorCode: null,
      pdf: status === 'settled' ? pdf : null,
    },
  };
}

describe('retained artifact UI state', () => {
  it('projects the verified build response and does not let a delayed list read regress it', () => {
    const initial = [request(reportId, 'not_started'), request(otherReportId, 'not_started')];
    const build = retainedBuildResultSchema.parse({
      reportId,
      reportStatus: 'approved',
      status: 'settled',
      operationKey,
      lastErrorCode: null,
      pdf,
    });
    const projected = applyRetainedBuild(initial, build);
    expect(projected[0]?.artifact?.status).toBe('settled');
    expect(projected[1]).toEqual(initial[1]);

    const delayed = mergeRetainedRequests(projected, initial);
    expect(delayed[0]?.artifact?.status).toBe('settled');
    expect(delayed[0]?.artifact?.pdf).toEqual(pdf);
    expect(delayed[1]).toEqual(initial[1]);
  });

  it('keeps an uncertain pending build visible across an older list read', () => {
    const current = [request(reportId, 'pending')];
    expect(
      mergeRetainedRequests(current, [request(reportId, 'not_started')])[0]?.artifact?.status,
    ).toBe('pending');
  });

  it('accepts a later settled read and never carries status into a different report', () => {
    const current = [request(reportId, 'pending')];
    expect(
      mergeRetainedRequests(current, [request(reportId, 'settled')])[0]?.artifact?.status,
    ).toBe('settled');
    expect(
      mergeRetainedRequests(current, [request(otherReportId, 'not_started')])[0]?.artifact?.status,
    ).toBe('not_started');
  });

  it('keeps a newer release status while preserving the exact settled PDF', () => {
    const incoming = request(reportId, 'not_started');
    incoming.reportStatus = 'published';
    const result = mergeRetainedRequests([request(reportId, 'settled')], [incoming]);
    expect(result[0]?.artifact?.status).toBe('settled');
    expect(result[0]?.artifact?.reportStatus).toBe('published');
    expect(result[0]?.artifact?.pdf).toEqual(pdf);
  });
  it('parses the BFF settled answer, which carries only identifiers, and projects settled', () => {
    // Exactly what POST /reports/{technical,dpb}/:id/artifacts returns on 200.
    const build = retainedBuildResultSchema.parse({
      reportId,
      buildId: '44444444-4444-4444-8444-444444444444',
      status: 'settled',
      operationKey,
      replayed: false,
    });
    const projected = applyRetainedBuild([request(reportId, 'not_started')], build);
    expect(projected[0]?.artifact?.status).toBe('settled');
    expect(projected[0]?.artifact?.operationKey).toBe(operationKey);
    // No receipt was supplied, so none is claimed; the list read supplies it.
    expect(projected[0]?.artifact?.pdf).toBeNull();
    expect(projected[0]?.artifact?.reportStatus).toBe('approved');
  });

  it('keeps a known PDF receipt when a later build answer omits it, and never invents a status', () => {
    const settled = [request(reportId, 'settled')];
    const again = retainedBuildResultSchema.parse({ reportId, status: 'settled', operationKey });
    expect(applyRetainedBuild(settled, again)[0]?.artifact?.pdf).toEqual(pdf);
    const bare: Array<{
      reportId: string | null;
      reportStatus: string | null;
      artifact: ReturnType<typeof request>['artifact'] | null;
    }> = [{ reportId, reportStatus: null, artifact: null }];
    expect(applyRetainedBuild(bare, again)[0]?.artifact?.reportStatus).toBe('unknown');
  });

  it('rejects a build answer for a different shape of status', () => {
    expect(() =>
      retainedBuildResultSchema.parse({ reportId, status: 'not_started', operationKey }),
    ).toThrow();
  });
  it('keeps re-reading while a settled card has no receipt, then stops and resets', () => {
    const projected = applyRetainedBuild(
      [request(reportId, 'not_started')],
      retainedBuildResultSchema.parse({ reportId, status: 'settled', operationKey }),
    );
    expect(awaitsReceipt(projected)).toBe(true);
    // A stale list read cannot supply the receipt, so the card must stay waiting.
    expect(
      awaitsReceipt(mergeRetainedRequests(projected, [request(reportId, 'not_started')])),
    ).toBe(true);
    // The first read that carries the receipt ends the wait.
    expect(awaitsReceipt(mergeRetainedRequests(projected, [request(reportId, 'settled')]))).toBe(
      false,
    );
    expect(
      awaitsReceipt([request(reportId, 'pending'), request(otherReportId, 'not_started')]),
    ).toBe(false);
    expect(awaitsReceipt([{ reportId, reportStatus: 'approved', artifact: null }])).toBe(false);
  });

  it('bounds the re-reads and never schedules one when nothing is waiting', () => {
    expect(nextReceiptRefreshDelay(0, false)).toBeNull();
    expect(nextReceiptRefreshDelay(0, true)).toBe(RECEIPT_REFRESH_DELAYS_MS[0]);
    const last = RECEIPT_REFRESH_DELAYS_MS.length - 1;
    expect(nextReceiptRefreshDelay(last, true)).toBe(RECEIPT_REFRESH_DELAYS_MS[last]);
    expect(nextReceiptRefreshDelay(last + 1, true)).toBeNull();
  });
});
