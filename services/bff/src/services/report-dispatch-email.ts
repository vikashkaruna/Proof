import { BRAND } from '@axiom/config';
import { z } from 'zod';
import { randomUUID } from 'crypto';

export interface ReportDispatchEmailParams {
  recipientEmail: string;
  title: string;
  kind: string;
  summary: string;
  reportId?: string;
  dossierId?: string;
  reportUrl?: string;
  downloadUrl?: string;
  proofSealHash?: string;
  merkleRoot?: string;
  tenantName?: string;
  sealedAt?: string;
  notes?: string;
}

export interface ReportDispatchEmailResult {
  status: 'sent' | 'simulated' | 'failed';
  providerMessageId?: string;
  error?: string;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

export async function sendReportDispatchEmail(
  params: ReportDispatchEmailParams,
): Promise<ReportDispatchEmailResult> {
  const {
    recipientEmail,
    title,
    kind,
    summary,
    reportId,
    dossierId,
    reportUrl = 'https://app.axiomproof.ai/reports',
    downloadUrl,
    proofSealHash,
    merkleRoot,
    tenantName = 'Axiom Proof Client',
    sealedAt = new Date().toISOString(),
    notes,
  } = params;

  const resendApiKey = process.env.RESEND_API_KEY?.trim();
  const fromEmail =
    process.env.AXIOM_FROM_EMAIL?.trim() ||
    process.env.RESEND_FROM_EMAIL?.trim() ||
    'Axiom Proof <platform@axiomproof.ai>';
  const salesEmail = process.env.AXIOM_SALES_EMAIL?.trim() || 'sales@axiomproof.ai';
  const founderEmail = process.env.AXIOM_FOUNDER_EMAIL?.trim() || 'founder@axiomminds.ai';

  const subject = `[Axiom Proof] ${proofSealHash ? 'Sealed Statutory Closure Dossier' : 'Compliance Report'}: ${title}`;

  const plainText = [
    `Axiom Proof — ${BRAND.tagline}`,
    `----------------------------------------------------`,
    `Report: ${title}`,
    `Kind:   ${kind.toUpperCase()}`,
    `Tenant: ${tenantName}`,
    `Date:   ${sealedAt}`,
    proofSealHash ? `Proof Seal:  ${proofSealHash}` : '',
    merkleRoot ? `Merkle Root: ${merkleRoot}` : '',
    reportId ? `Report ID:   ${reportId}` : '',
    dossierId ? `Dossier ID:  ${dossierId}` : '',
    ``,
    `Summary:`,
    summary,
    notes ? `\nReviewer Notes:\n${notes}` : '',
    ``,
    `View Online: ${reportUrl}`,
    downloadUrl ? `Download Package: ${downloadUrl}` : '',
    ``,
    `----------------------------------------------------`,
    `Company: ${BRAND.company}`,
    `Website: ${BRAND.companyDomain}`,
    `Platform: https://${BRAND.primaryDomain}`,
    BRAND.copyright,
  ]
    .filter((l) => l !== '')
    .join('\n');

  const htmlContent = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(subject)}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #F4F6F8; margin: 0; padding: 24px; color: #2F3542; }
    .card { max-width: 600px; margin: 0 auto; background: #FFFFFF; border-radius: 8px; border: 1px solid #D8DCE4; overflow: hidden; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.05); }
    .header { background: #1E2A4A; padding: 28px 32px; color: #FFFFFF; }
    .header h1 { margin: 0; font-size: 20px; font-weight: 700; letter-spacing: -0.01em; color: #FFFFFF; }
    .header p { margin: 6px 0 0; font-size: 13px; color: #BFF1EB; }
    .content { padding: 32px; }
    .badge { display: inline-block; padding: 4px 10px; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; border-radius: 4px; background: #E5FAF7; color: #0FB5A5; margin-bottom: 16px; }
    .badge-gold { background: #FBF6E7; color: #A0821F; border: 1px solid #C9A227; }
    .seal-box { background: #FBF6E7; border: 1px solid #C9A227; border-radius: 6px; padding: 16px; margin: 20px 0; }
    .seal-title { font-size: 12px; font-weight: 700; color: #776217; text-transform: uppercase; letter-spacing: 0.05em; margin: 0 0 6px; }
    .seal-hash { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 11px; color: #4F410F; word-break: break-all; }
    .button { display: inline-block; background: #0FB5A5; color: #FFFFFF; text-decoration: none; padding: 12px 24px; border-radius: 6px; font-weight: 600; font-size: 14px; margin-top: 16px; }
    .footer { padding: 24px 32px; background: #F7F8FA; border-top: 1px solid #EDEFF3; font-size: 12px; color: #7E879A; line-height: 1.6; }
    .footer a { color: #0FB5A5; text-decoration: none; }
  </style>
</head>
<body>
  <div class="card">
    <div class="header">
      <h1>Axiom Proof</h1>
      <p>Automated DPDPA Compliance Assurance & Sealed Proof</p>
    </div>
    <div class="content">
      ${
        proofSealHash
          ? '<span class="badge badge-gold">Sealed Statutory Proof Dossier</span>'
          : '<span class="badge">Official Compliance Report</span>'
      }
      <h2 style="margin: 0 0 12px; font-size: 18px; color: #1E2A4A;">${escapeHtml(title)}</h2>
      <p style="font-size: 14px; line-height: 1.5; color: #525B71; margin-bottom: 20px;">
        ${escapeHtml(summary)}
      </p>

      ${
        proofSealHash
          ? `<div class="seal-box">
        <div class="seal-title">Cryptographic Proof Seal (WORM Verified)</div>
        <div class="seal-hash">Hash: ${escapeHtml(proofSealHash)}</div>
        ${merkleRoot ? `<div class="seal-hash" style="margin-top: 4px;">Merkle Root: ${escapeHtml(merkleRoot)}</div>` : ''}
        <div style="font-size: 11px; color: #776217; margin-top: 6px;">Sealed At: ${escapeHtml(sealedAt)}</div>
      </div>`
          : ''
      }

      ${
        notes
          ? `<div style="background: #F7F8FA; border-left: 3px solid #0FB5A5; padding: 12px 16px; margin: 16px 0; font-size: 13px; color: #525B71;">
        <strong>Reviewer Notes:</strong> ${escapeHtml(notes)}
      </div>`
          : ''
      }

      <div style="margin-top: 24px;">
        <a href="${escapeHtml(reportUrl)}" class="button">View Online in Workbench</a>
        ${
          downloadUrl
            ? `<a href="${escapeHtml(downloadUrl)}" class="button" style="background: #1E2A4A; margin-left: 10px;">Download Offline Pack</a>`
            : ''
        }
      </div>
    </div>
    <div class="footer">
      <p style="margin: 0 0 8px;">
        Issued for <strong>${escapeHtml(tenantName)}</strong> under Indian DPDPA compliance frameworks.
      </p>
      <p style="margin: 0 0 8px;">
        Platform: <a href="https://${BRAND.primaryDomain}">https://${BRAND.primaryDomain}</a> · Company: <a href="${BRAND.companyDomain}">${BRAND.company}</a>
      </p>
      <p style="margin: 0; font-size: 11px; color: #B0B7C5;">
        ${BRAND.copyright} · Bangalore, India
      </p>
    </div>
  </div>
</body>
</html>`;

  // Simulation mode when no API key is configured or non-delivery mode
  if (!resendApiKey || process.env.AXIOM_REPORT_EMAIL_MODE !== 'delivery') {
    return {
      status: 'simulated',
      providerMessageId: `simulated_dispatch_${randomUUID().slice(0, 8)}`,
    };
  }

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${resendApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: fromEmail,
        to: [recipientEmail],
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
      console.error('[report-dispatch-email] Resend API dispatch failed:', {
        status: res.status,
        resData,
      });
      return { status: 'failed', error: 'Email provider refused delivery.' };
    }

    const receipt = z.object({ id: z.string().min(1) }).safeParse(resData);
    return receipt.success
      ? { status: 'sent', providerMessageId: receipt.data.id }
      : { status: 'failed', error: 'Email provider returned no receipt.' };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown provider error';
    console.error('[report-dispatch-email] Email provider unavailable:', message);
    return { status: 'failed', error: 'Email provider unavailable.' };
  }
}
