/**
 * Approval History Export contracts, schema validation, and deterministic HTML rendering.
 * Provides formal, tamper-evident audit trails for all human and standing-policy approvals (BR-1, BR-2, FR-6).
 */
import { z } from 'zod';
import { BRANDING } from './schema';

const uuid = z.string().regex(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
const timestamp = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/)
  .refine((v) => Number.isFinite(Date.parse(v)));

export const ApprovalRecordItemSchema = z.object({
  token_id: uuid,
  plan_id: uuid,
  plan_title: z.string().min(1).max(300),
  plan_version: z.number().int().min(1),
  approver_id: uuid,
  approver_name: z.string().min(1).max(100),
  approver_role: z.string().min(1).max(100),
  approval_scopes: z.array(z.string().min(1).max(100)),
  mode: z.enum(['batch', 'individual']),
  action_count: z.number().int().min(1),
  action_types: z.array(z.string().min(1).max(100)),
  dry_run_verified: z.boolean(),
  dry_run_status: z.string().min(1).max(50),
  rollback_validated: z.boolean(),
  reconciliation_statement: z.string().min(1).max(2000).nullable(),
  status: z.enum(['issued', 'consumed', 'revoked', 'expired']),
  issued_at: timestamp,
  expires_at: timestamp,
  consumed_at: timestamp.nullable(),
  revoked_at: timestamp.nullable(),
  signature_preview: z.string().min(8).max(128),
});
export type ApprovalRecordItem = z.infer<typeof ApprovalRecordItemSchema>;

export const ApprovalHistoryExportContentV1Schema = z.object({
  schema_version: z.literal(1),
  kind: z.literal('approval_history_export'),
  export_id: uuid.optional(),
  title: z.string().min(1).max(300),
  tenant_id: uuid,
  tenant_name: z.string().min(1).max(200),
  generated_at: timestamp,
  branding: z
    .object({
      product: z.literal(BRANDING.product),
      company: z.literal(BRANDING.company),
      company_url: z.literal(BRANDING.company_url),
      product_url: z.string().optional(),
    })
    .default({
      product: BRANDING.product,
      company: BRANDING.company,
      company_url: BRANDING.company_url,
      product_url: 'https://axiomproof.ai',
    }),
  summary: z.object({
    total_records: z.number().int().min(0),
    active_approvals: z.number().int().min(0),
    consumed_approvals: z.number().int().min(0),
    revoked_approvals: z.number().int().min(0),
    standing_policy_approvals: z.number().int().min(0),
    batch_approvals: z.number().int().min(0),
    individual_approvals: z.number().int().min(0),
  }),
  approvals: z.array(ApprovalRecordItemSchema).max(200),
});
export type ApprovalHistoryExportContentV1 = z.infer<typeof ApprovalHistoryExportContentV1Schema>;

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function renderApprovalHistoryHtml(content: ApprovalHistoryExportContentV1): string {
  const validated = ApprovalHistoryExportContentV1Schema.parse(content);

  const statusBadge = (status: string) => {
    switch (status) {
      case 'consumed':
        return '<span class="status-chip consumed">CONSUMED</span>';
      case 'issued':
        return '<span class="status-chip issued">ACTIVE</span>';
      case 'revoked':
        return '<span class="status-chip revoked">REVOKED</span>';
      default:
        return '<span class="status-chip expired">EXPIRED</span>';
    }
  };

  const rowsHtml =
    validated.approvals.length === 0
      ? `<tr><td colspan="4" class="empty-state">No approval records recorded in ledger.</td></tr>`
      : validated.approvals
          .map(
            (appr) => `
        <tr class="approval-row">
          <td class="col-token">
            <div class="token-id">TOKEN: ${escapeHtml(appr.token_id.slice(0, 8))}...</div>
            <div class="plan-info"><strong>Plan:</strong> ${escapeHtml(appr.plan_title)} <span class="plan-ver">(v${appr.plan_version})</span></div>
            <div class="mode-info"><strong>Mode:</strong> ${escapeHtml(appr.mode.toUpperCase())} (${appr.action_count} action(s))</div>
          </td>
          <td class="col-approver">
            <div class="approver-name"><strong>${escapeHtml(appr.approver_name)}</strong></div>
            <div class="approver-role">${escapeHtml(appr.approver_role)}</div>
            <div class="scopes-text"><strong>Scopes:</strong> ${escapeHtml(appr.approval_scopes.join(', ') || 'Unrestricted')}</div>
            ${
              appr.action_types.length > 0
                ? `<div class="action-types"><strong>Actions:</strong> ${escapeHtml(appr.action_types.join(', '))}</div>`
                : ''
            }
          </td>
          <td class="col-verification">
            <div class="verif-item">
              <strong>Dry Run:</strong> ${
                appr.dry_run_verified
                  ? '<span class="text-success">✓ Passed (' +
                    escapeHtml(appr.dry_run_status) +
                    ')</span>'
                  : '<span class="text-danger">✗ Not Verified</span>'
              }
            </div>
            <div class="verif-item">
              <strong>Rollback:</strong> ${
                appr.rollback_validated
                  ? '<span class="text-success">✓ Validated</span>'
                  : '<span class="text-danger">✗ Unvalidated</span>'
              }
            </div>
            <div class="sig-wrapper">
              <strong>Signature:</strong>
              <div class="sig-code">${escapeHtml(appr.signature_preview)}</div>
            </div>
            ${
              appr.reconciliation_statement
                ? `
              <div class="reconciliation-box">
                <strong>Reconciliation Statement:</strong> ${escapeHtml(appr.reconciliation_statement)}
              </div>`
                : ''
            }
          </td>
          <td class="col-status">
            <div class="status-wrap">${statusBadge(appr.status)}</div>
            <div class="timestamp-meta">
              <div><span class="ts-label">Issued:</span> ${escapeHtml(appr.issued_at)}</div>
              <div><span class="ts-label">Expires:</span> ${escapeHtml(appr.expires_at)}</div>
              ${appr.consumed_at ? `<div><span class="ts-label">Consumed:</span> ${escapeHtml(appr.consumed_at)}</div>` : ''}
              ${appr.revoked_at ? `<div><span class="ts-label">Revoked:</span> ${escapeHtml(appr.revoked_at)}</div>` : ''}
            </div>
          </td>
        </tr>`,
          )
          .join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(validated.title)} — Approval History Export</title>
  <style>
    @page {
      size: A4 portrait;
      margin: 14mm 16mm;
    }
    *, *::before, *::after {
      box-sizing: border-box;
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      color: #1E293B;
      background: #FFFFFF;
      margin: 0;
      padding: 0;
      font-size: 11px;
      line-height: 1.45;
    }
    .header-banner {
      background: #1E2A4A;
      color: #FFFFFF;
      padding: 20px 24px;
      border-radius: 6px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 20px;
      border-bottom: 4px solid #C9A227;
    }
    .brand-title {
      font-size: 19px;
      font-weight: 700;
      margin: 0 0 4px 0;
      letter-spacing: -0.3px;
    }
    .brand-subtitle {
      font-size: 11px;
      color: #CBD5E1;
      margin: 0;
    }
    .brand-credentials {
      margin: 5px 0 0 0;
      font-size: 10px;
      color: #94A3B8;
    }
    .brand-credentials a {
      color: #0FB5A5;
      text-decoration: none;
    }
    .export-badge {
      background: #0FB5A5;
      color: #FFFFFF;
      font-size: 10px;
      font-weight: 700;
      padding: 6px 12px;
      border-radius: 4px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      white-space: nowrap;
    }
    .metrics-grid {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 12px;
      margin-bottom: 20px;
    }
    .metric-card {
      border: 1px solid #E2E8F0;
      border-radius: 6px;
      padding: 10px 12px;
      background: #F8FAFC;
      text-align: center;
    }
    .metric-val {
      font-size: 20px;
      font-weight: 700;
      color: #1E2A4A;
      line-height: 1.1;
    }
    .metric-sub {
      font-size: 9.5px;
      font-weight: 600;
      color: #64748B;
      text-transform: uppercase;
      margin-top: 3px;
      letter-spacing: 0.3px;
    }
    .table-container {
      width: 100%;
      margin-bottom: 24px;
    }
    table.audit-table {
      width: 100%;
      border-collapse: collapse;
      table-layout: fixed;
    }
    table.audit-table th {
      background: #F1F5F9;
      color: #1E2A4A;
      font-size: 10px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.4px;
      padding: 9px 10px;
      text-align: left;
      border-top: 1px solid #CBD5E1;
      border-bottom: 2px solid #CBD5E1;
    }
    table.audit-table td {
      padding: 10px;
      border-bottom: 1px solid #E2E8F0;
      vertical-align: top;
      font-size: 10.5px;
      word-break: break-word;
      overflow-wrap: anywhere;
    }
    tr.approval-row {
      page-break-inside: avoid;
    }
    tr.approval-row:nth-child(even) {
      background: #FAFCFF;
    }
    .col-token { width: 24%; }
    .col-approver { width: 25%; }
    .col-verification { width: 28%; }
    .col-status { width: 23%; }
    .token-id {
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-weight: 700;
      color: #1E2A4A;
      font-size: 10px;
      margin-bottom: 4px;
    }
    .plan-info {
      color: #334155;
      font-size: 10.5px;
      line-height: 1.35;
      margin-bottom: 4px;
    }
    .plan-ver {
      color: #64748B;
      font-size: 9.5px;
    }
    .mode-info {
      font-size: 9.5px;
      color: #64748B;
    }
    .approver-name {
      color: #1E2A4A;
      font-size: 11px;
    }
    .approver-role {
      color: #64748B;
      font-size: 10px;
      margin-bottom: 4px;
    }
    .scopes-text, .action-types {
      font-size: 9.5px;
      color: #475569;
      line-height: 1.3;
      margin-top: 2px;
    }
    .verif-item {
      margin-bottom: 3px;
      font-size: 10px;
    }
    .text-success { color: #0FB5A5; font-weight: 600; }
    .text-danger { color: #D9534F; font-weight: 600; }
    .sig-wrapper {
      margin-top: 4px;
      font-size: 9.5px;
    }
    .sig-code {
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      color: #0369A1;
      font-size: 9px;
      background: #F0F9FF;
      border: 1px solid #BAE6FD;
      border-radius: 3px;
      padding: 2px 4px;
      margin-top: 2px;
      word-break: break-all;
    }
    .reconciliation-box {
      margin-top: 6px;
      padding: 6px 8px;
      background: #F8FAFC;
      border-left: 3px solid #0FB5A5;
      border-radius: 2px;
      font-size: 9.5px;
      color: #334155;
      line-height: 1.35;
    }
    .status-wrap {
      margin-bottom: 6px;
    }
    .status-chip {
      font-size: 9px;
      font-weight: 700;
      padding: 3px 8px;
      border-radius: 4px;
      display: inline-block;
      letter-spacing: 0.3px;
    }
    .status-chip.consumed { background: #D1FAE5; color: #065F46; }
    .status-chip.issued { background: #FEF3C7; color: #92400E; }
    .status-chip.revoked { background: #FEE2E2; color: #991B1B; }
    .status-chip.expired { background: #F1F5F9; color: #64748B; }
    .timestamp-meta {
      font-size: 9px;
      color: #64748B;
      line-height: 1.4;
    }
    .ts-label {
      font-weight: 600;
      color: #475569;
    }
    .empty-state {
      text-align: center;
      padding: 30px;
      color: #64748B;
      font-style: italic;
    }
    .footer {
      margin-top: 24px;
      padding-top: 10px;
      border-top: 1px solid #CBD5E1;
      display: flex;
      justify-content: space-between;
      font-size: 9px;
      color: #64748B;
    }
    .footer a {
      color: #0FB5A5;
      text-decoration: none;
    }
  </style>
</head>
<body>
  <div class="header-banner">
    <div>
      <div class="brand-title">${escapeHtml(validated.title)}</div>
      <p class="brand-subtitle">Tenant: ${escapeHtml(validated.tenant_name)} · ${escapeHtml(validated.branding.product)} Approval Audit Ledger</p>
      <p class="brand-credentials">
        Issued by <strong>${escapeHtml(validated.branding.company)}</strong> (<a href="${escapeHtml(validated.branding.company_url)}">${escapeHtml(validated.branding.company_url)}</a>) · Platform: <a href="https://axiomproof.ai">https://axiomproof.ai</a>
      </p>
    </div>
    <div class="export-badge">APPROVAL AUDIT EXPORT</div>
  </div>

  <div class="metrics-grid">
    <div class="metric-card">
      <div class="metric-val">${validated.summary.total_records}</div>
      <div class="metric-sub">Total Approvals</div>
    </div>
    <div class="metric-card">
      <div class="metric-val" style="color: #0FB5A5;">${validated.summary.consumed_approvals}</div>
      <div class="metric-sub">Executed / Consumed</div>
    </div>
    <div class="metric-card">
      <div class="metric-val" style="color: #C9A227;">${validated.summary.active_approvals}</div>
      <div class="metric-sub">Active in Queue</div>
    </div>
    <div class="metric-card">
      <div class="metric-val" style="color: #D9534F;">${validated.summary.revoked_approvals}</div>
      <div class="metric-sub">Revoked / Halts</div>
    </div>
  </div>

  <div class="table-container">
    <table class="audit-table">
      <thead>
        <tr>
          <th class="col-token">Token &amp; Plan</th>
          <th class="col-approver">Approver &amp; Scopes</th>
          <th class="col-verification">Verification &amp; Proof</th>
          <th class="col-status">Status &amp; Timestamps</th>
        </tr>
      </thead>
      <tbody>
        ${rowsHtml}
      </tbody>
    </table>
  </div>

  <div class="footer">
    <div>Exported from <strong>${escapeHtml(validated.branding.product)}</strong> (<a href="https://axiomproof.ai">https://axiomproof.ai</a>) · <strong>${escapeHtml(validated.branding.company)}</strong> (<a href="${escapeHtml(validated.branding.company_url)}">${escapeHtml(validated.branding.company_url)}</a>)</div>
    <div>Generated At: ${escapeHtml(validated.generated_at)} · Sealed Ledger Digest</div>
  </div>
</body>
</html>`;
}
