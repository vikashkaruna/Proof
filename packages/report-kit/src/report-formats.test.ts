import { describe, expect, it } from 'vitest';
import {
  AuditorPackContentV1,
  AuditorPackContentV1Schema,
  renderAuditorPackHtml,
} from './auditor-pack';
import {
  DpbSubmissionContentV1,
  DpbSubmissionContentV1Schema,
  renderDpbSubmissionHtml,
} from './dpb-submission';
import {
  TechnicalRemediationRegisterContentV1,
  TechnicalRemediationRegisterContentV1Schema,
  renderTechnicalRemediationRegisterHtml,
} from './technical-remediation';
import {
  ApprovalHistoryExportContentV1,
  ApprovalHistoryExportContentV1Schema,
  renderApprovalHistoryHtml,
} from './approval-history';
import {
  DsarResponseContentV1,
  DsarResponseContentV1Schema,
  renderDsarResponseHtml,
  BreachNotificationContentV1,
  BreachNotificationContentV1Schema,
  renderBreachNotificationHtml,
  GapScanReportContentV1,
  GapScanReportContentV1Schema,
  renderGapScanReportHtml,
} from './consumer-reports';

describe('Report Kit — Statutory Formats & Consumer Reports', () => {
  const TENANT = '00000000-0000-0000-0000-000000000001';
  const ENGAGEMENT = '00000000-0000-0000-0000-000000000002';
  const RUN_ID = '00000000-0000-0000-0000-000000000003';
  const HASH = '1111111111111111111111111111111111111111111111111111111111111111';

  it('validates and renders Auditor Pack', () => {
    const auditorPack: AuditorPackContentV1 = {
      schema_version: 1,
      kind: 'auditor_pack',
      title: 'Annual Statutory DPDPA Audit Pack 2026',
      tenant_id: TENANT,
      engagement_id: ENGAGEMENT,
      assessment_run_id: RUN_ID,
      assessment_result_digest: HASH,
      library_version: '2023.1',
      library_digest: HASH,
      generated_at: '2026-09-28T00:00:00.000Z',
      branding: {
        product: 'Axiom Proof',
        company: 'Axiom Minds Private Limited',
        company_url: 'https://axiomminds.ai',
      },
      audit_metadata: {
        audit_firm_or_internal: 'Deloitte & Touche LLP / Axiom Assurance',
        lead_auditor_name: 'Ananya Sharma, CISA',
        period_start: '2026-01-01T00:00:00.000Z',
        period_end: '2026-09-28T00:00:00.000Z',
        scope_description: 'Full statutory assessment of customer personal data pipelines, consent registries, and encryption controls.',
      },
      compliance_metrics: {
        posture_score: 91,
        total_controls_audited: 40,
        compliant_controls: 36,
        partially_compliant_controls: 3,
        non_compliant_controls: 1,
        not_applicable_controls: 0,
        evidence_items_reviewed: 128,
      },
      control_evaluations: [
        {
          control_id: 'DPDPA-SEC-01',
          title: 'Reasonable Security Safeguards under Section 8(5)',
          domain: 'Security & Encryption',
          statutory_reference: 'DPDPA 2023 Sec 8(5)',
          status: 'compliant',
          score: 95,
          auditor_notes: 'AES-256 GCM enforced on primary database storage. Verified key rotation policy.',
          evidence_references: [
            {
              evidence_id: '00000000-0000-0000-0000-000000000010',
              receipt_id: '00000000-0000-0000-0000-000000000011',
              content_hash: HASH,
              collected_by: 'saakshi',
              collected_at: '2026-09-28T00:00:00.000Z',
              provenance: 'production',
            },
          ],
        },
      ],
      signatures: {
        prepared_by: {
          name: 'Prativedan (Axiom Reporting Agent)',
          role: 'Autonomous Compliance Synthesizer',
          agent: 'prativedan',
        },
        auditor_attestation: {
          auditor_name: 'Ananya Sharma',
          firm: 'Deloitte & Touche LLP',
          designation: 'Lead Privacy Auditor',
          attestation_statement: 'I hereby attest that the controls and linked evidence were reviewed in accordance with DPDPA 2023 rules.',
          timestamp: '2026-09-28T00:30:00.000Z',
        },
        approved_by: null,
      },
    };

    const parsed = AuditorPackContentV1Schema.parse(auditorPack);
    expect(parsed.compliance_metrics.posture_score).toBe(91);

    const html = renderAuditorPackHtml(auditorPack);
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('Annual Statutory DPDPA Audit Pack 2026');
    expect(html).toContain('AUDITOR PACK');
    expect(html).toContain('Ananya Sharma, CISA');
    expect(html).toContain('DPDPA-SEC-01');
    expect(html).toContain('Axiom Proof');
    expect(html).toContain('Axiom Minds Private Limited');
  });

  it('validates and renders DPB Statutory Submission', () => {
    const dpbSubmission: DpbSubmissionContentV1 = {
      schema_version: 1,
      kind: 'dpb_submission',
      title: 'Formal Breach Notification to the Data Protection Board of India',
      tenant_id: TENANT,
      submission_type: 'breach_notification',
      dpb_reference_number: 'DPB-IN-2026-0042',
      generated_at: '2026-09-28T00:00:00.000Z',
      branding: {
        product: 'Axiom Proof',
        company: 'Axiom Minds Private Limited',
        company_url: 'https://axiomminds.ai',
      },
      data_fiduciary: {
        legal_name: 'Meridian Pay Technologies Private Limited',
        registration_number: 'U72900KA2021PTC148892',
        principal_office: '42 MG Road, Bengaluru, Karnataka 560001',
        dpo_name: 'Rajesh Nair',
        dpo_email: 'dpo@meridianpay.in',
        dpo_phone: '+91 80 4455 6677',
      },
      incident_details: {
        incident_type: 'Unauthorized Credential Access in Legacy Integration Gateway',
        detected_at: '2026-09-27T14:00:00.000Z',
        estimated_principals_affected: 1250,
        categories_of_personal_data: ['Email Address', 'Phone Number', 'Masked Card Tokens'],
        root_cause_summary: 'Deprecating v1 partner endpoint leaked token validation telemetry.',
        potential_consequences: 'Low risk of financial fraud due to token masking, but contact info exposed.',
      },
      statutory_sections_invoked: ['Section 8(6) - Intimation of Personal Data Breach', 'Section 8(5) - Technical Safeguards'],
      remedial_measures: [
        {
          step: 1,
          measure: 'Revoked and rotated all integration gateway tokens across partner nodes.',
          status: 'completed',
          verification_evidence_hash: HASH,
        },
        {
          step: 2,
          measure: 'Dispatched notification emails to all 1,250 impacted data principals.',
          status: 'completed',
          verification_evidence_hash: HASH,
        },
      ],
      communication_status: {
        board_notified_at: '2026-09-27T18:00:00.000Z',
        affected_principals_notified: true,
        notification_channels: ['Email', 'SMS Alert'],
      },
      signatures: {
        prepared_by: {
          name: 'Prativedan (Axiom Reporting Agent)',
          role: 'Autonomous Compliance Synthesizer',
          agent: 'prativedan',
        },
        dpo_attestation: {
          dpo_name: 'Rajesh Nair',
          dpo_designation: 'Head of Privacy & Data Protection Officer',
          statement: 'I confirm that the facts stated herein are true and accurate to the best of my knowledge.',
          timestamp: '2026-09-28T00:30:00.000Z',
        },
        authorized_signatory: {
          user_id: '00000000-0000-0000-0000-000000000099',
          name: 'Vikram Mehta',
          designation: 'Managing Director & CEO',
          timestamp: '2026-09-28T01:00:00.000Z',
        },
      },
    };

    const parsed = DpbSubmissionContentV1Schema.parse(dpbSubmission);
    expect(parsed.data_fiduciary.dpo_name).toBe('Rajesh Nair');

    const html = renderDpbSubmissionHtml(dpbSubmission);
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('DPB FORM SUBMISSION');
    expect(html).toContain('Meridian Pay Technologies Private Limited');
    expect(html).toContain('DPB-IN-2026-0042');
    expect(html).toContain('STATUTORY DPB SEAL');
  });

  it('validates and renders Technical Remediation Register', () => {
    const register: TechnicalRemediationRegisterContentV1 = {
      schema_version: 1,
      kind: 'technical_remediation_register',
      title: 'Q3 Technical Remediation & Rollback Register',
      tenant_id: TENANT,
      plan_id: '00000000-0000-0000-0000-000000000050',
      plan_version: 3,
      generated_at: '2026-09-28T00:00:00.000Z',
      branding: {
        product: 'Axiom Proof',
        company: 'Axiom Minds Private Limited',
        company_url: 'https://axiomminds.ai',
      },
      register_summary: {
        total_actions: 5,
        approved_actions: 5,
        dry_run_passed_actions: 5,
        rollback_validated_actions: 5,
        executed_actions: 4,
        estimated_total_rollback_time_seconds: 120,
      },
      actions: [
        {
          action_id: '00000000-0000-0000-0000-000000000051',
          sequence: 1,
          action_type: 'sql.postgres.apply_encryption',
          description: 'Enable pgcrypto and column encryption on customers.national_id',
          risk_class: 'high',
          risk_score: 75,
          target_systems: ['prod-db-primary'],
          blast_radius_records: 45000,
          dry_run_status: 'passed',
          dry_run_completed_at: '2026-09-27T22:00:00.000Z',
          rollback_validated: true,
          rollback_time_seconds: 30,
          approval_status: 'approved',
          approved_by: '00000000-0000-0000-0000-0000000000aa',
          execution_outcome: 'completed_success',
          idempotency_key: 'idem-act-51',
        },
      ],
      signatures: {
        prepared_by: {
          name: 'Prativedan (Axiom Reporting Agent)',
          role: 'Autonomous Compliance Synthesizer',
          agent: 'prativedan',
        },
        reviewed_by: null,
      },
    };

    const parsed = TechnicalRemediationRegisterContentV1Schema.parse(register);
    expect(parsed.register_summary.total_actions).toBe(5);

    const html = renderTechnicalRemediationRegisterHtml(register);
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('TECHNICAL REGISTER');
    expect(html).toContain('sql.postgres.apply_encryption');
    expect(html).toContain('Rollbacks Validated');
  });

  it('validates and renders Approval History Export', () => {
    const approvalExport: ApprovalHistoryExportContentV1 = {
      schema_version: 1,
      kind: 'approval_history_export',
      title: 'Tenant Approval Audit Ledger & Reconciliation Export',
      tenant_id: TENANT,
      tenant_name: 'Acme Financial Services',
      generated_at: '2026-09-28T00:00:00.000Z',
      branding: {
        product: 'Axiom Proof',
        company: 'Axiom Minds Private Limited',
        company_url: 'https://axiomminds.ai',
      },
      summary: {
        total_records: 12,
        active_approvals: 2,
        consumed_approvals: 9,
        revoked_approvals: 1,
        standing_policy_approvals: 4,
        batch_approvals: 8,
        individual_approvals: 4,
      },
      approvals: [
        {
          token_id: '00000000-0000-0000-0000-000000000070',
          plan_id: '00000000-0000-0000-0000-000000000050',
          plan_title: 'Database Security Hardening Plan',
          plan_version: 2,
          approver_id: '00000000-0000-0000-0000-0000000000aa',
          approver_name: 'Suresh Patel',
          approver_role: 'Founder / Security Approver',
          approval_scopes: ['data-deletion', 'schema-alter'],
          mode: 'batch',
          action_count: 3,
          action_types: ['sql.postgres.alter_column', 'sql.postgres.create_index'],
          dry_run_verified: true,
          dry_run_status: 'passed',
          rollback_validated: true,
          reconciliation_statement: 'All 3 remediation actions dispatched and verified via Postgres connection health checks.',
          status: 'consumed',
          issued_at: '2026-09-27T10:00:00.000Z',
          expires_at: '2026-09-27T11:00:00.000Z',
          consumed_at: '2026-09-27T10:25:00.000Z',
          revoked_at: null,
          signature_preview: 'hmac-sha256:7f3a8b...9c',
        },
      ],
    };

    const parsed = ApprovalHistoryExportContentV1Schema.parse(approvalExport);
    expect(parsed.summary.total_records).toBe(12);

    const html = renderApprovalHistoryHtml(approvalExport);
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('APPROVAL AUDIT EXPORT');
    expect(html).toContain('Suresh Patel');
    expect(html).toContain('CONSUMED');
    expect(html).toContain('Reconciliation Statement:');
  });

  it('validates and renders DSAR, Breach, and Gap-scan consumer reports', () => {
    const dsar: DsarResponseContentV1 = {
      schema_version: 1,
      kind: 'dsar_response',
      dsar_id: '00000000-0000-0000-0000-000000000080',
      tenant_id: TENANT,
      request_kind: 'access',
      data_principal_name: 'Priya Sundaram',
      data_principal_identifier: 'priya.s@example.com',
      identity_verification_method: 'Aadhaar OTP via DigiLocker / Governed Gateway',
      identity_verified_at: '2026-09-25T10:00:00.000Z',
      status: 'fulfilled',
      fulfilment_summary: 'All personal data entries held in active and archive databases were exported in portable JSON and delivered via secure portal.',
      data_categories_processed: ['Identity Data', 'Transaction Records', 'Login Logs'],
      generated_at: '2026-09-28T00:00:00.000Z',
      branding: {
        product: 'Axiom Proof',
        company: 'Axiom Minds Private Limited',
        company_url: 'https://axiomminds.ai',
      },
      dpo_officer: {
        name: 'Rajesh Nair',
        title: 'Data Protection Officer',
        email: 'dpo@meridianpay.in',
      },
      signatures: {
        prepared_by: {
          name: 'Prativedan (Axiom Reporting Agent)',
          role: 'Autonomous Compliance Synthesizer',
          agent: 'prativedan',
        },
        approved_by: {
          user_id: '00000000-0000-0000-0000-0000000000aa',
          name: 'Rajesh Nair',
          role: 'Data Protection Officer',
          timestamp: '2026-09-28T01:00:00.000Z',
        },
      },
    };

    const dsarHtml = renderDsarResponseHtml(dsar);
    expect(dsarHtml).toContain('Data Principal Rights Request Fulfilment');
    expect(dsarHtml).toContain('ACCESS FULFILLED');
    expect(dsarHtml).toContain('Priya Sundaram');

    const breach: BreachNotificationContentV1 = {
      schema_version: 1,
      kind: 'breach_notification',
      breach_id: '00000000-0000-0000-0000-000000000085',
      tenant_id: TENANT,
      incident_title: 'S3 Log Ingestion Bucket Misconfiguration',
      severity: 'medium',
      discovered_at: '2026-09-26T12:00:00.000Z',
      affected_principals_count: 50,
      data_categories: ['IP Addresses', 'User Agent Strings'],
      technical_summary: 'Debug logs were briefly emitted to an unencrypted development bucket during cluster migration.',
      containment_actions: ['Revoked bucket public policy', 'Purged unencrypted debug objects', 'Enforced KMS key check'],
      dpb_notified: true,
      dpb_notified_at: '2026-09-26T18:00:00.000Z',
      generated_at: '2026-09-28T00:00:00.000Z',
      branding: {
        product: 'Axiom Proof',
        company: 'Axiom Minds Private Limited',
        company_url: 'https://axiomminds.ai',
      },
      signatures: {
        prepared_by: {
          name: 'Prativedan (Axiom Reporting Agent)',
          role: 'Autonomous Compliance Synthesizer',
          agent: 'prativedan',
        },
        incident_lead: {
          name: 'SecOps Incident Manager',
          role: 'Security Engineering Lead',
          timestamp: '2026-09-26T20:00:00.000Z',
        },
      },
    };

    const breachHtml = renderBreachNotificationHtml(breach);
    expect(breachHtml).toContain('S3 Log Ingestion Bucket Misconfiguration');
    expect(breachHtml).toContain('MEDIUM SEVERITY');

    const gapScan: GapScanReportContentV1 = {
      schema_version: 1,
      kind: 'gap_scan_report',
      scan_id: '00000000-0000-0000-0000-000000000090',
      target_url: 'https://example-fintech.in',
      overall_score: 78,
      scanned_at: '2026-09-28T00:00:00.000Z',
      branding: {
        product: 'Axiom Proof',
        company: 'Axiom Minds Private Limited',
        company_url: 'https://axiomminds.ai',
      },
      checklist_results: [
        {
          category: 'Consent Notice',
          score: 85,
          findings_count: 1,
          summary: 'Notice contains all required bilingual details but lacks direct DPO grievance phone number.',
        },
      ],
      critical_findings: [
        {
          domain: 'Grievance Redressal',
          title: 'Missing DPO contact telephone on public notice',
          recommendation: 'Update public notice to include telephone number as mandated under DPDPA Rule 3(2).',
        },
      ],
    };

    const gapHtml = renderGapScanReportHtml(gapScan);
    expect(gapHtml).toContain('DPDPA 2023 Gap Scan Report');
    expect(gapHtml).toContain('78% SCORE');
  });
});
