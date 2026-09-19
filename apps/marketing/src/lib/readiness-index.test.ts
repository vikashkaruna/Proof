import { describe, it, expect } from 'vitest';
import { computeQuarterlyReadinessIndex } from './readiness-index';
import { sendGapScanReportEmail } from './gap-scan-email';
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

  it('simulates email dispatch safely when RESEND_API_KEY is not set', async () => {
    const originalKey = process.env.RESEND_API_KEY;
    delete process.env.RESEND_API_KEY;

    const result = await sendGapScanReportEmail({
      report: mockReport,
      readinessIndex: computeQuarterlyReadinessIndex('BFSI', 78),
      contactName: 'Test Contact',
      contactEmail: 'client@example.com',
      contactPhone: '+91 98765 43210',
      contactCompany: 'Fintech Corp',
      reportId: 'test-uuid-1234',
    });

    expect(result.success).toBe(true);
    expect(result.simulated).toBe(true);

    if (originalKey) {
      process.env.RESEND_API_KEY = originalKey;
    }
  });
});
