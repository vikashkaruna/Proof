import { describe, expect, it } from 'vitest';
import { EstateScanSchema } from './estate';
const scan = {
  id: '00000000-0000-4000-8000-000000000001',
  tenantId: '00000000-0000-4000-8000-000000000002',
  estateId: '00000000-0000-4000-8000-000000000003',
  createdAt: '2026-09-21T00:00:00Z',
  summary: {},
};
describe('scan lifecycle contract', () => {
  it('does not call a queued scan successful without a completed interval', () => {
    expect(
      EstateScanSchema.safeParse({ ...scan, status: 'queued', startedAt: null, completedAt: null })
        .success,
    ).toBe(true);
    expect(
      EstateScanSchema.safeParse({
        ...scan,
        status: 'succeeded',
        startedAt: null,
        completedAt: null,
      }).success,
    ).toBe(false);
  });
  it('allows cancellation before starting but rejects reversed intervals', () => {
    expect(
      EstateScanSchema.safeParse({
        ...scan,
        status: 'cancelled',
        startedAt: null,
        completedAt: null,
      }).success,
    ).toBe(true);
    expect(
      EstateScanSchema.safeParse({
        ...scan,
        status: 'succeeded',
        startedAt: '2026-09-21T01:00:00Z',
        completedAt: '2026-09-21T00:00:00Z',
      }).success,
    ).toBe(false);
  });
});
