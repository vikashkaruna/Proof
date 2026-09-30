import { beforeEach, expect, it, vi } from 'vitest';

const backend = vi.hoisted(() => vi.fn());
vi.mock('./gap-scan-backend', () => ({ gapScanBackend: backend }));
import { getGapScanReport, SAMPLE_GAP_SCAN_RECORD } from './gap-scan-store';

const id = 'c9910225-81b2-4ef9-84c9-29b14beafc14';
const access = 'a'.repeat(64);

beforeEach(() => backend.mockReset());

it('refuses a missing or malformed ownership capability without contacting the BFF', async () => {
  expect(await getGapScanReport(id, undefined)).toBeNull();
  expect(await getGapScanReport(id, 'bad')).toBeNull();
  expect(await getGapScanReport('../other', access)).toBeNull();
  expect(backend).not.toHaveBeenCalled();
});

it('reads the exact report through the scoped BFF endpoint', async () => {
  backend.mockResolvedValue(Response.json(SAMPLE_GAP_SCAN_RECORD));
  const result = await getGapScanReport(id, access);
  expect(result?.report_snapshot.postureScore).toBe(68);
  expect(backend).toHaveBeenCalledWith(`/public/gap-scan/${id}`, {
    headers: { 'X-Gap-Scan-Access': access },
  });
});

it('returns null only for not found and refuses invalid or unavailable responses', async () => {
  backend.mockResolvedValueOnce(new Response(null, { status: 404 }));
  expect(await getGapScanReport(id, access)).toBeNull();
  backend.mockResolvedValueOnce(Response.json({ error: 'outage' }, { status: 503 }));
  await expect(getGapScanReport(id, access)).rejects.toThrow('unavailable');
  backend.mockResolvedValueOnce(Response.json({ id, report_snapshot: {} }));
  await expect(getGapScanReport(id, access)).rejects.toThrow();
});
