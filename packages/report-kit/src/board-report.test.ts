import { describe, expect, it } from 'vitest';
import {
  BoardReportContentV1,
  BoardReportContentV1Schema,
  renderBoardReportHtml,
} from './board-report';
import { renderHtmlToPdf } from './renderer';

describe('Board Report Contracts & Renderer', () => {
  const sampleReport: BoardReportContentV1 = {
    schema_version: 1,
    kind: 'board_report',
    title: 'Meridian Pay DPDPA Board Compliance Report Q3',
    tenant_id: '00000000-0000-0000-0000-000000000001',
    engagement_id: '00000000-0000-0000-0000-000000000002',
    assessment_run_id: '00000000-0000-0000-0000-000000000003',
    assessment_result_digest: '1111111111111111111111111111111111111111111111111111111111111111',
    library_version: '2023.1',
    library_digest: '2222222222222222222222222222222222222222222222222222222222222222',
    generated_at: '2026-09-27T18:00:00.000Z',
    branding: {
      product: 'Axiom Proof',
      company: 'Axiom Minds Private Limited',
      company_url: 'https://axiomminds.ai',
    },
    executive_summary: {
      posture_score: 82,
      total_controls: 42,
      passed_controls: 35,
      failed_controls: 7,
      critical_gaps: 1,
      high_gaps: 2,
      medium_gaps: 3,
      low_gaps: 1,
      estimated_exposure_inr: 250000000,
      narrative:
        'Meridian Pay demonstrates strong foundational security controls across authentication and encryption. Immediate remediation is required for cross-border data transfer logging under Section 16 of DPDPA.',
    },
    key_findings: [
      {
        control_id: 'DPDPA-SEC-01',
        domain: 'Data Protection & Security',
        severity: 'critical',
        title: 'Unencrypted Personal Data at Rest in Secondary Data Store',
        score: 0,
        gap_summary:
          'Postgres read replica contains customer identifier hashes without field-level salt.',
        remediation_recommendation:
          'Enable AES-256 GCM encryption on replica storage volumes and salt all HMAC pipelines.',
      },
    ],
    action_plan: [
      {
        step: 1,
        title: 'Deploy KMS-managed encryption to secondary DB replica',
        owner: 'SecOps Team',
        timeline_days: 14,
        priority: 'p0',
      },
    ],
    signatures: {
      prepared_by: {
        name: 'Prativedan (Axiom Reporting Agent)',
        role: 'Autonomous Compliance Synthesizer',
        agent: 'prativedan',
      },
      approved_by: null,
    },
  };

  it('validates a well-formed board report content payload', () => {
    const parsed = BoardReportContentV1Schema.parse(sampleReport);
    expect(parsed.executive_summary.posture_score).toBe(82);
    expect(parsed.key_findings).toHaveLength(1);
    expect(parsed.action_plan).toHaveLength(1);
  });

  it('renders valid, deterministic HTML matching Axiom brand and DPDPA requirements', () => {
    const html = renderBoardReportHtml(sampleReport);
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('Meridian Pay DPDPA Board Compliance Report Q3');
    expect(html).toContain('Axiom Proof');
    expect(html).toContain('82%');
    expect(html).toContain('DPDPA-SEC-01');
    expect(html).toContain('DRAFT · PENDING FOUNDER APPROVAL');
    expect(html).toContain('1111111111111111111111111111111111111111111111111111111111111111');
  });

  it('labels a deterministic board draft without claiming agent authority', () => {
    const report: BoardReportContentV1 = {
      ...sampleReport,
      signatures: {
        prepared_by: {
          name: 'Axiom Proof board report builder',
          role: 'Deterministic assessment renderer',
          agent: 'board-report-builder',
        },
        approved_by: null,
      },
    };
    const html = renderBoardReportHtml(report);
    expect(html).toContain('AUTOMATED DRAFT');
    expect(html).toContain('Requires founder review before release');
    expect(html).not.toContain('PREPARED BY AGENT');
    expect(html).not.toContain('Agent: board-report-builder');
  });

  it('renders approved signature block when approved_by is present', () => {
    const approvedReport: BoardReportContentV1 = {
      ...sampleReport,
      signatures: {
        prepared_by: sampleReport.signatures.prepared_by,
        approved_by: {
          user_id: '00000000-0000-0000-0000-000000000001',
          name: 'Axiom Founder',
          role: 'Super Admin / Founder',
          timestamp: '2026-09-27T18:30:00.000Z',
        },
      },
    };
    const html = renderBoardReportHtml(approvedReport);
    expect(html).toContain('REVIEWER APPROVAL RECORDED');
    expect(html).toContain('Axiom Founder');
    expect(html).toContain('REVIEWED');
  });

  it('retains findings beyond the previous 50-control ceiling', () => {
    const report: BoardReportContentV1 = {
      ...sampleReport,
      key_findings: Array.from({ length: 51 }, (_, index) => ({
        ...sampleReport.key_findings[0]!,
        control_id: `CONTROL-${index + 1}`,
      })),
    };
    const html = renderBoardReportHtml(report);
    expect(html).toContain('CONTROL-51');
    expect(BoardReportContentV1Schema.parse(report).key_findings).toHaveLength(51);
  });

  it('renders compliant PDF bytes using deterministic engine', async () => {
    const html = renderBoardReportHtml(sampleReport);
    const res = await renderHtmlToPdf(html, { preferChromium: false });
    expect(res.renderer).toBe('deterministic-fallback');
    expect(res.byteLength).toBeGreaterThan(500);
    expect(res.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(res.pdfBuffer.toString('utf-8', 0, 8)).toContain('%PDF-1.4');
  });

  it('renders compliant PDF bytes using headless Chromium when available', async () => {
    const html = renderBoardReportHtml(sampleReport);
    const res = await renderHtmlToPdf(html, { preferChromium: true });
    // If Chromium is not available, the renderer falls back to the deterministic engine.
    // Both paths produce valid PDF output — only the renderer label differs.
    expect(res.byteLength).toBeGreaterThan(500);
    expect(res.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(res.pdfBuffer.toString('utf-8', 0, 8)).toContain('%PDF');
  }, 60_000);
});
