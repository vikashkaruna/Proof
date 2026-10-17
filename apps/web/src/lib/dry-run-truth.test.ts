import { describe, expect, it } from 'vitest';
import type { ActionReadiness } from '@axiom/types';
import {
  approvedWithoutRecordedRun,
  blockerReasons,
  cacheContradictsRecord,
  dryRunBadge,
  recordedDryRunState,
} from './dry-run-truth';

const base: ActionReadiness = {
  actionId: '99816474-5185-42da-886f-3356008f9810',
  sequence: 1,
  actionType: 'data.mask',
  approvalStatus: 'awaiting_approval',
  executionStatus: null,
  ready: true,
  blockers: [],
  rollbackValidated: true,
  rollbackValidatedAt: null,
  dryRun: {
    id: '0c0f25ca-e7eb-473e-af96-7e6d5ff0887f',
    status: 'succeeded',
    refusalReason: null,
    createdAt: '2026-10-17T04:30:00Z',
    expiresAt: '2026-10-18T04:30:00Z',
  },
};

describe('recorded dry-run state', () => {
  it('is derived from the recorded run', () => {
    expect(recordedDryRunState(base)).toBe('succeeded');
    expect(recordedDryRunState({ ...base, ready: false, blockers: ['dry_run_expired'] })).toBe(
      'expired',
    );
    expect(recordedDryRunState({ ...base, dryRun: { ...base.dryRun!, status: 'refused' } })).toBe(
      'refused',
    );
    expect(recordedDryRunState({ ...base, dryRun: { ...base.dryRun!, status: 'failed' } })).toBe(
      'failed',
    );
    expect(recordedDryRunState({ ...base, dryRun: null })).toBe('not_recorded');
    expect(recordedDryRunState(null)).toBe('unknown');
  });

  it('never labels an expired or missing run as a success', () => {
    expect(dryRunBadge('expired').variant).toBe('warning');
    expect(dryRunBadge('not_recorded')).toEqual({ label: 'Not recorded', variant: 'danger' });
  });

  it('flags the cache-only contradiction and the approval it allowed', () => {
    const unrecorded = {
      ...base,
      dryRun: null,
      ready: false,
      blockers: ['no_recorded_dry_run' as const],
    };
    expect(cacheContradictsRecord('dry_run_complete', unrecorded)).toBe(true);
    expect(cacheContradictsRecord('awaiting_dry_run', unrecorded)).toBe(false);
    expect(cacheContradictsRecord('dry_run_complete', base)).toBe(false);
    expect(approvedWithoutRecordedRun('approved', unrecorded)).toBe(true);
    expect(approvedWithoutRecordedRun('approved', base)).toBe(false);
  });

  it('fails closed with a reason when readiness is unknown', () => {
    expect(blockerReasons(null)).toEqual([
      'Readiness could not be read, so approval is not offered.',
    ]);
    expect(blockerReasons(base)).toEqual([]);
  });
});
