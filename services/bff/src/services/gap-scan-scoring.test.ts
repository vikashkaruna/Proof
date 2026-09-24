import { describe, expect, it } from 'vitest';
import { GAP_SCAN_QUESTIONS, GAP_SCAN_QUESTION_SET_VERSION } from '@axiom/control-library';
import { GapScanReportSchema, GapScanStoredReportSchema } from '@axiom/types';
import { computeGapScanReport } from './gap-scan-scoring.js';
import { computeQuarterlyReadinessIndex } from './readiness-index.js';

const all = (value: boolean) => Object.fromEntries(GAP_SCAN_QUESTIONS.map((q) => [q.id, value]));

describe('gap-scan scoring semantics (C-W0-7)', () => {
  it('scores exactly the shared question set and stamps its version', async () => {
    const report = await computeGapScanReport(all(true));
    expect(report.questionSetVersion).toBe(GAP_SCAN_QUESTION_SET_VERSION);
    expect(report.findings.map((f) => f.controlId).sort()).toEqual(
      GAP_SCAN_QUESTIONS.map((q) => q.controlId).sort(),
    );
    expect(GapScanReportSchema.parse(report)).toBeTruthy();
  });

  it('treats only a yes on the compliant-phrased q11 as meeting the transfer control', async () => {
    const yes = await computeGapScanReport({ ...all(true) });
    const no = await computeGapScanReport({ ...all(true), q11: false });
    const xbr = (r: typeof yes) => r.findings.find((f) => f.controlId === 'DPDPA-XBR-001')!;
    expect(xbr(yes).score).toBe(100);
    expect(xbr(no).score).toBe(0);
    expect(no.postureScore).toBeLessThan(yes.postureScore);
  });

  it('maps q7 to least privilege and q12 to DPIA-before-processing', async () => {
    const report = await computeGapScanReport({ ...all(true), q7: false, q12: false });
    const failing = report.findings.filter((f) => f.score === 0).map((f) => f.controlId);
    expect(failing.sort()).toEqual(['DPDPA-DPIA-001', 'DPDPA-SEC-002']);
  });

  it('treats unanswered and non-boolean answers as not met', async () => {
    const report = await computeGapScanReport({ q1: 'yes', q2: 1 });
    expect(report.findings.every((f) => f.score === 0)).toBe(true);
  });
});

describe('readiness benchmark provenance (C-W0-7)', () => {
  it('labels every generated index as an editorial estimate', () => {
    for (const sector of ['BFSI', 'Healthcare', 'Other', ''])
      expect(computeQuarterlyReadinessIndex(sector, 50).benchmarkBasis).toBe('editorial_estimate');
  });

  it('still reads snapshots stored before question-set and provenance fields existed', () => {
    const legacy = {
      id: '00000000-0000-4000-8000-000000000001',
      report_snapshot: {
        postureScore: 40,
        estimatedExposureInr: 1000,
        findings: [],
        recommendations: [],
        libraryVersion: '0.1.0',
        readinessIndex: {
          sector: 'BFSI',
          companyScore: 40,
          sectorBenchmarkScore: 76,
          percentileRank: 25,
          status: 'lagging',
          exposureMultiplier: 2.2,
          sectorTopRisks: [],
          quarterlyRoadmap: [],
          generatedAt: '2026-09-01T00:00:00.000Z',
        },
      },
      library_version: '0.1.0',
      posture_score: 40,
      estimated_exposure_inr: 1000,
      contact_name: null,
      contact_email: null,
      contact_phone: null,
      contact_company: null,
      follow_up_requested: false,
      created_at: '2026-09-01T00:00:00.000Z',
    };
    const parsed = GapScanStoredReportSchema.parse(legacy);
    expect(parsed.report_snapshot.questionSetVersion).toBeUndefined();
    expect(parsed.report_snapshot.readinessIndex?.benchmarkBasis).toBeUndefined();
  });
});
