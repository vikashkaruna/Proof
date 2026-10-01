import { describe, expect, it } from 'vitest';
import {
  applyRetainedBuild,
  mergeRetainedRequests,
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
});
