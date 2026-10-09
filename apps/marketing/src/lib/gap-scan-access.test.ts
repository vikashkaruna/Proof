import { beforeEach, expect, it, vi } from 'vitest';

const cookieJar = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('next/headers', () => ({ cookies: async () => cookieJar }));
import { encodeGapScanSession, readGapScanAccess } from './gap-scan-access';

beforeEach(() => cookieJar.get.mockReset());

it('encodes only a valid ownership token into a marked Firebase session', () => {
  expect(encodeGapScanSession('a'.repeat(64))).toBe(`gap-scan.${'a'.repeat(64)}`);
  expect(() => encodeGapScanSession('product-session')).toThrow('Invalid gap-scan ownership token');
});

it('reads a marked Firebase cookie but never accepts an unmarked product session', async () => {
  cookieJar.get.mockImplementation((name: string) =>
    name === '__session' ? { value: `gap-scan.${'b'.repeat(64)}` } : undefined,
  );
  expect(await readGapScanAccess()).toBe('b'.repeat(64));
  cookieJar.get.mockImplementation((name: string) =>
    name === '__session' ? { value: 'b'.repeat(64) } : undefined,
  );
  expect(await readGapScanAccess()).toBeUndefined();
});

it('retains direct Cloud Run reports through the validated legacy cookie', async () => {
  cookieJar.get.mockImplementation((name: string) =>
    name === 'gap_scan_access' ? { value: 'c'.repeat(64) } : undefined,
  );
  expect(await readGapScanAccess()).toBe('c'.repeat(64));
});

it('does not let a malformed marked session fall back to a legacy token', async () => {
  cookieJar.get.mockImplementation((name: string) =>
    name === '__session' ? { value: 'gap-scan.product-session' } : { value: 'c'.repeat(64) },
  );
  expect(await readGapScanAccess()).toBeUndefined();
});
