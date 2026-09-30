import { createSupabaseAdmin } from '@axiom/supabase';
import { createHash } from 'node:crypto';

const admin = createSupabaseAdmin();

async function main() {
  console.log('Seeding platform baseline data...');
  const tenantId = '00000000-0000-0000-0000-000000000001';
  const libVersion = '0.1.0';

  // 1. Check/Insert Engagement
  const { data: existingEngagements } = await admin
    .from('engagements')
    .select('id')
    .eq('tenant_id', tenantId)
    .limit(1);

  let engagementId = existingEngagements?.[0]?.id;

  if (!engagementId) {
    const { data: newEngagement, error: engErr } = await admin
      .from('engagements')
      .insert({
        tenant_id: tenantId,
        library_version: libVersion,
        title: 'DPDPA 2023 Statutory Compliance Assessment',
        status: 'assessment',
        posture_score: 74.0,
        estimated_exposure_inr: 320000000, // ₹32 Cr
        started_at: new Date(Date.now() - 7 * 86400000).toISOString(),
      })
      .select('id')
      .single();

    if (engErr) {
      console.error('Engagement insert error:', engErr);
      return;
    }
    engagementId = newEngagement.id;
    console.log('✓ Created baseline engagement:', engagementId);
  } else {
    console.log('✓ Existing engagement found:', engagementId);
  }

  // 2. Query controls to seed findings
  const { data: controls } = await admin
    .from('controls')
    .select('id, title, domain, severity, scoring')
    .eq('library_version', libVersion);

  if (controls && controls.length > 0) {
    const { count: findingsCount } = await admin
      .from('findings')
      .select('*', { count: 'exact', head: true })
      .eq('engagement_id', engagementId);

    if (!findingsCount || findingsCount === 0) {
      const findingsToInsert = controls.map((c, idx) => {
        let status: 'open' | 'planned' | 'closed' = 'closed';
        let score = 100;
        if (idx % 4 === 1) {
          status = 'open';
          score = 25;
        } else if (idx % 4 === 2) {
          status = 'planned';
          score = 60;
        }

        const penaltyPoints = c.scoring?.penaltyPoints || 25;
        const riskPoints = Number((penaltyPoints * (1 - score / 100)).toFixed(2));

        return {
          tenant_id: tenantId,
          engagement_id: engagementId,
          control_id: c.id,
          library_version: libVersion,
          status,
          score,
          risk_points: riskPoints,
          rationale: `Automated baseline evaluation by Parikshan for ${c.title}. Statutory check under DPDPA.`,
        };
      });

      const { error: fErr } = await admin.from('findings').insert(findingsToInsert);
      if (fErr) console.error('Findings error:', fErr);
      else console.log(`✓ Seeded ${findingsToInsert.length} findings for controls`);
    } else {
      console.log(`✓ Findings already present (${findingsCount})`);
    }
  }

  // 3. Evidence Artifacts
  const { count: evCount } = await admin
    .from('evidence')
    .select('*', { count: 'exact', head: true })
    .eq('tenant_id', tenantId);

  if (!evCount || evCount === 0) {
    const makeHash = (str: string) => createHash('sha256').update(str).digest('hex');
    const evidenceItems = [
      {
        tenant_id: tenantId,
        engagement_id: engagementId,
        content_hash: makeHash('artifact-notice-multilingual-v2'),
        storage_uri: 's3://axiom-evidence-ap-south-1/meridian/notice-v2-bilingual.pdf',
        filename: 'notice-v2-bilingual.pdf',
        mime_type: 'application/pdf',
        byte_size: 419200,
        evidence_type: 'document',
        description:
          'Multi-lingual itemised consent notice deployed at collection endpoint (English + Hindi)',
        collected_by_agent: 'saakshi',
        demonstrates_control_ids: ['NOT-01', 'NOT-04'],
        worm_lock_until: new Date(Date.now() + 7 * 365 * 86400000).toISOString(),
      },
      {
        tenant_id: tenantId,
        engagement_id: engagementId,
        content_hash: makeHash('artifact-kms-ap-south-1-policy'),
        storage_uri: 's3://axiom-evidence-ap-south-1/meridian/aws-kms-mumbai-cmek.json',
        filename: 'aws-kms-mumbai-cmek.json',
        mime_type: 'application/json',
        byte_size: 14200,
        evidence_type: 'config',
        description:
          'AWS KMS CMEK Key Policy restricting cryptographic operations strictly to ap-south-1 Mumbai',
        collected_by_agent: 'saakshi',
        demonstrates_control_ids: ['SEC-09'],
        worm_lock_until: new Date(Date.now() + 7 * 365 * 86400000).toISOString(),
      },
      {
        tenant_id: tenantId,
        engagement_id: engagementId,
        content_hash: makeHash('artifact-dsar-sla-log'),
        storage_uri: 's3://axiom-evidence-ap-south-1/meridian/dsar-portal-sla-audit.log',
        filename: 'dsar-portal-sla-audit.log',
        mime_type: 'text/plain',
        byte_size: 894000,
        evidence_type: 'log',
        description: 'Immutable ledger extract of completed DSAR erasures within 72hr SLA window',
        collected_by_agent: 'saakshi',
        demonstrates_control_ids: ['RTS-01', 'RTS-04'],
        worm_lock_until: new Date(Date.now() + 7 * 365 * 86400000).toISOString(),
      },
      {
        tenant_id: tenantId,
        engagement_id: engagementId,
        content_hash: makeHash('artifact-dpo-gazette-board-res'),
        storage_uri: 's3://axiom-evidence-ap-south-1/meridian/board-resolution-dpo-appointment.pdf',
        filename: 'board-resolution-dpo-appointment.pdf',
        mime_type: 'application/pdf',
        byte_size: 1240000,
        evidence_type: 'attestation',
        description: 'Board resolution designating resident DPO in India under DPDPA Section 8(4)',
        collected_by_agent: 'saakshi',
        demonstrates_control_ids: ['GOV-01', 'RTS-06'],
        worm_lock_until: new Date(Date.now() + 7 * 365 * 86400000).toISOString(),
      },
      {
        tenant_id: tenantId,
        engagement_id: engagementId,
        content_hash: makeHash('artifact-breach-cert-in-drill'),
        storage_uri: 's3://axiom-evidence-ap-south-1/meridian/cert-in-dpb-tabletop-drill.json',
        filename: 'cert-in-dpb-tabletop-drill.json',
        mime_type: 'application/json',
        byte_size: 68400,
        evidence_type: 'report',
        description:
          'Certified 6-hour CERT-In / 72-hour DPB incident notification tabletop exercise report',
        collected_by_agent: 'saakshi',
        demonstrates_control_ids: ['BRC-02'],
        worm_lock_until: new Date(Date.now() + 7 * 365 * 86400000).toISOString(),
      },
    ];

    const { error: evErr } = await admin.from('evidence').insert(evidenceItems);
    if (evErr) console.error('Evidence error:', evErr);
    else console.log(`✓ Seeded ${evidenceItems.length} sealed evidence artifacts`);
  } else {
    console.log(`✓ Evidence already present (${evCount})`);
  }

  // 4. Remediation Plans and Actions
  const { count: plansCount } = await admin
    .from('remediation_plans')
    .select('*', { count: 'exact', head: true })
    .eq('tenant_id', tenantId);

  if (!plansCount || plansCount === 0) {
    const { data: newPlan, error: pErr } = await admin
      .from('remediation_plans')
      .insert({
        tenant_id: tenantId,
        engagement_id: engagementId,
        library_version: libVersion,
        title: 'Retention & Erasure Remediation Plan (PLAN-118)',
        description:
          'Deterministic rollbackable pipeline to purge expired telemetry and mask orphan PII in compliance with DPDPA §8(7)',
        status: 'review',
        version: 3,
        aggregate_blast_radius: {
          max_records: 41262,
          affected_tables: 3,
          services: ['postgres-prod', 'analytics-lake', 'auth-service'],
        },
      })
      .select('id')
      .single();

    if (pErr) {
      console.error('Plan insert error:', pErr);
    } else if (newPlan) {
      console.log('✓ Created Plan PLAN-118:', newPlan.id);
      const actions = [
        {
          plan_id: newPlan.id,
          sequence: 1,
          action_type: 'data.retention_purge',
          risk_class: 'medium',
          status: 'awaiting_approval',
          description:
            'Purge soft-deleted user records exceeding statutory 180-day retention window in analytics-lake',
          blast_radius: { rows: 14200, table: 'user_events_archive' },
          dry_run_result: {
            rows_affected: 14200,
            execution_simulated_at: new Date().toISOString(),
            status: 'validated_clean',
            safety_checks_passed: true,
          },
          rollback_definition: {
            strategy: 'point_in_time_snapshot_restore',
            snapshot_ref: 'snap-db-mumbai-20260913-0400',
            estimated_rollback_seconds: 45,
          },
        },
        {
          plan_id: newPlan.id,
          sequence: 2,
          action_type: 'notice.update',
          risk_class: 'low',
          status: 'awaiting_approval',
          description:
            'Deploy version 2.4 bilingual consent notice (English + Hindi) to production registration gateways',
          blast_radius: { configs: 1, endpoints: 4 },
          dry_run_result: {
            validation: 'schema_and_translation_verified',
            languages_supported: ['en', 'hi'],
            safety_checks_passed: true,
          },
          rollback_definition: {
            strategy: 'revert_git_commit_and_config',
            previous_version: '2.3.1',
          },
        },
        {
          plan_id: newPlan.id,
          sequence: 3,
          action_type: 'config.rbac_update',
          risk_class: 'low',
          status: 'awaiting_approval',
          description:
            'Enforce dynamic column-level masking on Aadhaar & PAN columns for non-privileged read roles',
          blast_radius: { roles: 3, columns: 2 },
          dry_run_result: {
            masked_columns: ['aadhaar_num', 'pan_num'],
            policy_enforced: true,
            safety_checks_passed: true,
          },
          rollback_definition: {
            strategy: 'drop_masking_policy',
            policy_name: 'pol_mask_pii_replica',
          },
        },
        {
          plan_id: newPlan.id,
          sequence: 4,
          action_type: 'data.mask',
          risk_class: 'low',
          status: 'awaiting_approval',
          description:
            'Mask orphaned contact numbers in unindexed application telemetry older than 90 days',
          blast_radius: { rows: 27062, index: 'app-logs-2026' },
          dry_run_result: {
            lines_scanned: 27062,
            matches_redacted: 1840,
            safety_checks_passed: true,
          },
          rollback_definition: {
            strategy: 'restore_log_segment',
            backup_location: 's3://axiom-backups-ap-south-1/logs/pre-mask/',
          },
        },
      ];

      const { error: aErr } = await admin.from('remediation_actions').insert(actions);
      if (aErr) console.error('Actions error:', aErr);
      else
        console.log(`✓ Seeded ${actions.length} remediation actions with dry runs and rollbacks`);
    }
  } else {
    console.log(`✓ Plans already present (${plansCount})`);
  }

  // 5. DSARs
  const { count: dsarCount } = await admin
    .from('dsars')
    .select('*', { count: 'exact', head: true })
    .eq('tenant_id', tenantId);

  if (!dsarCount || dsarCount === 0) {
    const dsarItems = [
      {
        tenant_id: tenantId,
        kind: 'erasure',
        status: 'in_fulfilment',
        data_principal_name: 'Ananya Sharma',
        data_principal_email: 'ananya.s@example.in',
        data_principal_phone: '+91 98765 43210',
        identity_verified: true,
        identity_verification_method: 'Aadhaar OTP via DigiLocker e-KYC',
        received_at: new Date(Date.now() - 3 * 86400000).toISOString(),
        due_by: new Date(Date.now() + 27 * 86400000).toISOString(),
        notes:
          'Requested complete erasure of historical transaction analytics upon account termination.',
      },
      {
        tenant_id: tenantId,
        kind: 'access',
        status: 'identity_verification',
        data_principal_name: 'Rahul K. Varma',
        data_principal_email: 'rahul.varma@example.in',
        data_principal_phone: '+91 98111 22334',
        identity_verified: false,
        identity_verification_method: 'Pending SMS verification token',
        received_at: new Date(Date.now() - 1 * 86400000).toISOString(),
        due_by: new Date(Date.now() + 29 * 86400000).toISOString(),
        notes:
          'Requested summary of all personal data processed and third parties disclosed to under DPDPA §11.',
      },
      {
        tenant_id: tenantId,
        kind: 'correction',
        status: 'received',
        data_principal_name: 'Pooja Iyer',
        data_principal_email: 'pooja.iyer@example.in',
        data_principal_phone: '+91 97444 55667',
        identity_verified: false,
        received_at: new Date().toISOString(),
        due_by: new Date(Date.now() + 30 * 86400000).toISOString(),
        notes: 'Updated communication address and mobile number update request.',
      },
      {
        tenant_id: tenantId,
        kind: 'portability',
        status: 'completed',
        data_principal_name: 'Vikramaditya Sen',
        data_principal_email: 'vikram.sen@example.in',
        identity_verified: true,
        identity_verification_method: 'PAN + Mobile OTP',
        received_at: new Date(Date.now() - 12 * 86400000).toISOString(),
        completed_at: new Date(Date.now() - 2 * 86400000).toISOString(),
        due_by: new Date(Date.now() + 18 * 86400000).toISOString(),
        notes:
          'Machine-readable JSON export delivered to verified recipient via encrypted vault link.',
      },
    ];

    const { error: dErr } = await admin.from('dsars').insert(dsarItems);
    if (dErr) console.error('DSAR error:', dErr);
    else console.log(`✓ Seeded ${dsarItems.length} DSAR records`);
  } else {
    console.log(`✓ DSARs already present (${dsarCount})`);
  }

  // Reports are created only from real assessment sources through the BFF.

  console.log('🎉 Platform baseline data seeding complete!');
}

main().catch(console.error);
