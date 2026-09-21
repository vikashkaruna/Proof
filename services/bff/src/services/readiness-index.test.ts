import { describe, it, expect, vi, afterEach } from 'vitest';
import { computeQuarterlyReadinessIndex } from './readiness-index.js';
import { sendGapScanReportEmail } from './gap-scan-email.js';
import type { GapScanReport } from '@axiom/types';

describe('Quarterly Readiness Index', () => {
  it('computes index for BFSI sector with leading score', () => {
    const index = computeQuarterlyReadinessIndex('BFSI', 85);
    expect(index.sector).toBe('BFSI');
    expect(index.companyScore).toBe(85);
    expect(index.sectorBenchmarkScore).toBe(76);
    expect(index.percentileRank).toBeGreaterThan(50);
    expect(index.status).toBe('leading');
    expect(index.quarterlyRoadmap).toHaveLength(4);
    expect(index.sectorTopRisks.length).toBeGreaterThan(0);
  });

  it('computes index for Healthcare sector with lagging score', () => {
    const index = computeQuarterlyReadinessIndex('Healthcare', 40);
    expect(index.sector).toBe('Healthcare');
    expect(index.companyScore).toBe(40);
    expect(index.sectorBenchmarkScore).toBe(72);
    expect(index.percentileRank).toBeLessThan(50);
    expect(index.status).toBe('lagging');
    expect(index.quarterlyRoadmap[0]?.quarter).toContain('Q1');
  });

  it('handles unknown or empty sector gracefully', () => {
    const index = computeQuarterlyReadinessIndex('', 70);
    expect(index.companyScore).toBe(70);
    expect(index.quarterlyRoadmap).toHaveLength(4);
  });
});

describe('Gap-Scan Email Service', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });
  const mockReport: GapScanReport = {
    postureScore: 78,
    estimatedExposureInr: 25000000,
    findings: [
      {
        controlId: 'DPDPA-SEC-001',
        title: 'Encryption of Personal Data',
        domain: 'Data Security',
        severity: 'high',
        score: 40,
        riskPoints: 18,
        rationale: 'Unencrypted storage of KYC tokens.',
      },
    ],
    recommendations: [
      {
        priority: 1,
        title: 'Deploy KMS encryption for databases',
        effort: '2 weeks',
      },
    ],
    libraryVersion: '0.1.0',
  };

  const params = {
    report: mockReport,
    contactEmail: 'fixture@example.invalid',
    reportId: 'test-id',
  };
  it('refuses missing credentials and requires explicit opt-in even with a key', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    vi.stubEnv('AXIOM_REPORT_EMAIL_MODE', 'delivery');
    vi.stubEnv('RESEND_API_KEY', '');
    expect((await sendGapScanReportEmail(params)).success).toBe(false);
    vi.stubEnv('RESEND_API_KEY', 'fake-test-key');
    vi.stubEnv('AXIOM_REPORT_EMAIL_MODE', 'disabled');
    expect((await sendGapScanReportEmail(params)).success).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('requires a provider receipt and returns generic failures without logging payloads', async () => {
    vi.stubEnv('AXIOM_REPORT_EMAIL_MODE', 'delivery');
    vi.stubEnv('RESEND_API_KEY', 'fake-test-key');
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ id: 'provider-receipt' }))
      .mockResolvedValueOnce(Response.json({}))
      .mockResolvedValueOnce(
        Response.json({ message: 'private-provider-payload' }, { status: 400 }),
      )
      .mockRejectedValueOnce(new Error('private-network-payload'));
    vi.stubGlobal('fetch', fetch);
    expect(await sendGapScanReportEmail(params)).toEqual({ success: true, id: 'provider-receipt' });
    expect((await sendGapScanReportEmail(params)).success).toBe(false);
    expect((await sendGapScanReportEmail(params)).success).toBe(false);
    expect((await sendGapScanReportEmail(params)).success).toBe(false);
    expect(JSON.stringify(log.mock.calls)).not.toContain('private-');
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({ redirect: 'error' });
  });
});
