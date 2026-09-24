import type { GapScanReport, ReadinessIndex } from '@axiom/types';
import { BRAND } from '@axiom/config';
import { z } from 'zod';

export interface SendGapScanEmailParams {
  report: GapScanReport;
  readinessIndex?: ReadinessIndex;
  contactName?: string;
  contactEmail: string;
  contactPhone?: string;
  contactCompany?: string;
  reportId: string;
  reportUrl?: string;
}

export interface SendEmailResult {
  success: boolean;
  simulated?: boolean;
  id?: string;
  error?: string;
}

function formatInr(amount: number): string {
  if (amount >= 10000000) {
    return `₹${(amount / 10000000).toFixed(1)} Cr`;
  }
  if (amount >= 100000) {
    return `₹${(amount / 100000).toFixed(1)} L`;
  }
  return `₹${amount.toLocaleString('en-IN')}`;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

export async function sendGapScanReportEmail(
  params: SendGapScanEmailParams,
): Promise<SendEmailResult> {
  const {
    report,
    readinessIndex,
    contactName,
    contactEmail,
    contactPhone,
    contactCompany,
    reportId,
    reportUrl,
  } = params;

  const resendApiKey = process.env.RESEND_API_KEY?.trim();
  const fromEmail =
    process.env.AXIOM_FROM_EMAIL?.trim() ||
    process.env.RESEND_FROM_EMAIL?.trim() ||
    'Axiom Proof <platform@axiomproof.ai>';
  const salesEmail = process.env.AXIOM_SALES_EMAIL?.trim() || 'sales@axiomproof.ai';
  const founderEmail = process.env.AXIOM_FOUNDER_EMAIL?.trim() || 'founder@axiomminds.ai';

  const viewUrl = reportUrl || `https://${BRAND.primaryDomain}/gap-scan/report/${reportId}`;
  const subject = `Axiom Proof — DPDPA Statutory Gap-Scan Report${
    contactCompany ? ` for ${contactCompany}` : ''
  }`;

  // Explicit opt-in only. Missing configuration never claims a delivered email.
  if (process.env.AXIOM_REPORT_EMAIL_MODE !== 'delivery' || !resendApiKey) {
    return { success: false, error: 'Report email delivery is not configured.' };
  }

  // Build Plain Text Content
  const textLines: string[] = [
    `AXIOM PROOF — STATUTORY DPDPA GAP-SCAN REPORT`,
    `====================================================`,
    ``,
    `Recipient: ${contactName || 'Lead'} <${contactEmail}>`,
    contactPhone ? `Phone:     ${contactPhone}` : '',
    contactCompany ? `Company:   ${contactCompany}` : '',
    `Report ID: ${reportId}`,
    `View Online: ${viewUrl}`,
    ``,
    `OVERALL POSTURE SCORE: ${report.postureScore}/100`,
    `ESTIMATED STATUTORY EXPOSURE: ${formatInr(report.estimatedExposureInr)}`,
    ``,
    `TOP PRIORITIZED REMEDIATIONS:`,
    ...report.recommendations.map(
      (r) => ` [Priority ${r.priority}] ${r.title} (Est. effort: ${r.effort})`,
    ),
    ``,
  ];

  if (readinessIndex) {
    textLines.push(
      `QUARTERLY DPDPA READINESS INDEX (${readinessIndex.sector})`,
      `----------------------------------------------------`,
      `Company Score:       ${readinessIndex.companyScore}/100`,
      `Indicative Sector Benchmark: ${readinessIndex.sectorBenchmarkScore}/100`,
      `Indicative Standing: Top ${100 - readinessIndex.percentileRank}% (estimate)`,
      `Benchmarks are Axiom editorial estimates, not measured peer data.`,
      `Readiness Status:    ${readinessIndex.status.toUpperCase()}`,
      ``,
      `Quarterly Progression Roadmap:`,
      ...readinessIndex.quarterlyRoadmap.map(
        (q) => ` ${q.quarter}: Target ${q.targetScore}/100 — ${q.milestone}`,
      ),
      ``,
    );
  }

  textLines.push(
    `Questions or need a walkthrough? Reply directly to this email or book at https://${BRAND.primaryDomain}/contact`,
    ``,
    BRAND.copyright,
  );

  const plainText = textLines.filter((l) => l !== '').join('\n');

  // Build Branded HTML Content
  const findingsRows = report.findings
    .slice(0, 8)
    .map((f) => {
      const isCompliant = f.score >= 80;
      const statusBg = isCompliant ? '#ecfdf5' : f.score >= 40 ? '#fefce8' : '#fef2f2';
      const statusColor = isCompliant ? '#065f46' : f.score >= 40 ? '#854d0e' : '#991b1b';
      const statusLabel = isCompliant ? 'Compliant' : f.score >= 40 ? 'Partial' : 'Gap';
      return `
        <tr>
          <td style="padding: 10px 12px; border-bottom: 1px solid #e2e8f0; font-family: monospace; font-size: 12px; color: #1E2A4A;">${escapeHtml(f.controlId)}</td>
          <td style="padding: 10px 12px; border-bottom: 1px solid #e2e8f0; font-size: 13px; color: #334155;">${escapeHtml(f.title)}</td>
          <td style="padding: 10px 12px; border-bottom: 1px solid #e2e8f0; font-size: 12px; text-transform: capitalize; color: #64748b;">${escapeHtml(f.severity)}</td>
          <td style="padding: 10px 12px; border-bottom: 1px solid #e2e8f0;">
            <span style="background-color: ${statusBg}; color: ${statusColor}; padding: 3px 8px; border-radius: 4px; font-size: 11px; font-weight: 600;">${statusLabel}</span>
          </td>
        </tr>`;
    })
    .join('');

  const recommendationsHtml = report.recommendations
    .map(
      (r) => `
      <li style="margin-bottom: 8px; font-size: 14px; color: #334155;">
        <strong>Priority ${r.priority}:</strong> ${escapeHtml(r.title)}
        <span style="color: #64748b; font-size: 12px;">(Effort: ${escapeHtml(r.effort)})</span>
      </li>`,
    )
    .join('');

  const readinessIndexHtml = readinessIndex
    ? `
      <div style="background-color: #f8fafc; border: 1px solid #cbd5e1; border-radius: 8px; padding: 20px; margin: 24px 0;">
        <div style="display: flex; align-items: center; margin-bottom: 12px;">
          <h3 style="margin: 0; color: #1E2A4A; font-size: 16px; font-weight: 700;">
            Quarterly DPDPA Readiness Index — ${escapeHtml(readinessIndex.sector)}
          </h3>
        </div>
        <table style="width: 100%; border-collapse: collapse; margin-bottom: 16px;">
          <tr>
            <td style="padding: 6px 0; font-size: 13px; color: #64748b;">Your Score:</td>
            <td style="padding: 6px 0; font-size: 14px; font-weight: 700; color: #0FB5A5;">${readinessIndex.companyScore} / 100</td>
            <td style="padding: 6px 0; font-size: 13px; color: #64748b;">Indicative Sector Benchmark:</td>
            <td style="padding: 6px 0; font-size: 14px; font-weight: 600; color: #1E2A4A;">${readinessIndex.sectorBenchmarkScore} / 100</td>
          </tr>
          <tr>
            <td style="padding: 6px 0; font-size: 13px; color: #64748b;">Indicative Standing:</td>
            <td style="padding: 6px 0; font-size: 14px; font-weight: 700; color: #1E2A4A;">Top ${100 - readinessIndex.percentileRank}%</td>
            <td style="padding: 6px 0; font-size: 13px; color: #64748b;">Readiness Status:</td>
            <td style="padding: 6px 0; font-size: 13px; font-weight: 600; color: #0FB5A5; text-transform: uppercase;">${readinessIndex.status.replace('_', ' ')}</td>
          </tr>
        </table>
        <p style="margin: 0 0 12px 0; font-size: 12px; color: #64748b;">Sector benchmarks and standing are Axiom editorial estimates, not measured data from peer organisations.</p>
        <h4 style="margin: 12px 0 8px 0; font-size: 13px; color: #475569; text-transform: uppercase; letter-spacing: 0.5px;">Quarterly Compliance Roadmap</h4>
        <ol style="margin: 0; padding-left: 20px;">
          ${readinessIndex.quarterlyRoadmap
            .map(
              (q) => `
            <li style="margin-bottom: 6px; font-size: 13px; color: #334155;">
              <strong>${escapeHtml(q.quarter)}:</strong> Target ${q.targetScore}/100 — ${escapeHtml(q.milestone)}
            </li>`,
            )
            .join('')}
        </ol>
      </div>`
    : '';

  const htmlContent = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f1f5f9; color: #1e293b; margin: 0; padding: 24px; }
    .container { max-width: 650px; margin: 0 auto; background: #ffffff; border-radius: 8px; overflow: hidden; border: 1px solid #e2e8f0; }
    .header { background-color: #1E2A4A; padding: 28px 32px; border-bottom: 4px solid #0FB5A5; text-align: center; }
    .header h1 { color: #ffffff; margin: 0; font-size: 22px; font-weight: 700; }
    .header p { color: #cbd5e1; margin: 6px 0 0 0; font-size: 13px; }
    .content { padding: 32px; }
    .score-banner { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 20px; text-align: center; margin-bottom: 24px; }
    .score-val { font-size: 42px; font-weight: 800; color: #0FB5A5; line-height: 1; }
    .exposure-val { font-size: 18px; font-weight: 700; color: #D9534F; margin-top: 6px; }
    .btn { display: inline-block; background-color: #0FB5A5; color: #ffffff; text-decoration: none; padding: 12px 24px; border-radius: 6px; font-weight: 600; font-size: 14px; margin-top: 20px; }
    .footer { background-color: #f8fafc; padding: 20px 32px; border-top: 1px solid #e2e8f0; font-size: 12px; color: #94a3b8; text-align: center; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>${BRAND.name}</h1>
      <p>Statutory DPDPA Compliance Gap-Scan Assessment</p>
    </div>
    <div class="content">
      <div style="margin-bottom: 20px; padding: 12px; background-color: #f8fafc; border-radius: 6px; font-size: 13px; color: #475569;">
        <strong>Recipient:</strong> ${escapeHtml(contactName || 'Valued Partner')} ${contactCompany ? `(${escapeHtml(contactCompany)})` : ''}<br/>
        <strong>Email:</strong> ${escapeHtml(contactEmail)}<br/>
        ${contactPhone ? `<strong>Phone:</strong> ${escapeHtml(contactPhone)}<br/>` : ''}
        <strong>Report ID:</strong> <span style="font-family: monospace;">${escapeHtml(reportId)}</span>
      </div>

      <div class="score-banner">
        <div style="font-size: 12px; font-weight: 600; text-transform: uppercase; color: #64748b; letter-spacing: 0.5px;">Statutory Posture Score</div>
        <div class="score-val">${report.postureScore}<span style="font-size: 20px; color: #94a3b8;">/100</span></div>
        <div class="exposure-val">Estimated Exposure: ${formatInr(report.estimatedExposureInr)}</div>
      </div>

      <h3 style="color: #1E2A4A; font-size: 16px; margin: 24px 0 12px 0;">Top Priority Remediations</h3>
      <ol style="margin: 0; padding-left: 20px; margin-bottom: 24px;">
        ${recommendationsHtml}
      </ol>

      ${readinessIndexHtml}

      <h3 style="color: #1E2A4A; font-size: 16px; margin: 24px 0 12px 0;">Findings Summary (${report.findings.length} controls assessed)</h3>
      <table style="width: 100%; border-collapse: collapse; margin-bottom: 24px;">
        <thead>
          <tr style="background-color: #f8fafc; text-align: left; font-size: 11px; text-transform: uppercase; color: #64748b;">
            <th style="padding: 8px 12px; border-bottom: 2px solid #cbd5e1;">Control</th>
            <th style="padding: 8px 12px; border-bottom: 2px solid #cbd5e1;">Title</th>
            <th style="padding: 8px 12px; border-bottom: 2px solid #cbd5e1;">Severity</th>
            <th style="padding: 8px 12px; border-bottom: 2px solid #cbd5e1;">Status</th>
          </tr>
        </thead>
        <tbody>
          ${findingsRows}
        </tbody>
      </table>

      <div style="text-align: center;">
        <a href="${viewUrl}" class="btn" style="color: #ffffff;">View Full Interactive Scorecard &amp; PDF</a>
      </div>
    </div>
    <div class="footer">
      ${BRAND.copyright} · ${BRAND.tagline}<br/>
      Need to speak with our compliance engineers? Contact us at <a href="mailto:${BRAND.contactEmail}" style="color: #0FB5A5;">${BRAND.contactEmail}</a>
    </div>
  </div>
</body>
</html>`;

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
      headers: {
        Authorization: `Bearer ${resendApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: fromEmail,
        to: [contactEmail],
        cc: [salesEmail],
        bcc: [founderEmail],
        reply_to: BRAND.contactEmail,
        subject,
        text: plainText,
        html: htmlContent,
      }),
    });

    const resData = await res.json().catch(() => ({}));

    if (!res.ok) {
      console.error('[gap-scan-email] Resend API dispatch failed:', {
        status: res.status,
        code: 'provider_refused',
      });
      return {
        success: false,
        error: 'Email provider refused delivery.',
      };
    }

    const receipt = z.object({ id: z.string().min(1) }).safeParse(resData);
    return receipt.success
      ? { success: true, id: receipt.data.id }
      : { success: false, error: 'Email provider returned no receipt.' };
  } catch (err) {
    console.error('[gap-scan-email] Email provider unavailable');
    return {
      success: false,
      error: 'Email provider unavailable.',
    };
  }
}
