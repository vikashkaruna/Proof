import { BRAND } from '@axiom/config';
import { z } from 'zod';
import type { ContactDeliveryResult } from './contact-email.js';

/** Invitation mail is its own explicit opt-in (C-W1-3). */
export const invitationEmailEnabled = () =>
  process.env.AXIOM_INVITATION_EMAIL_MODE === 'delivery' &&
  Boolean(process.env.RESEND_API_KEY?.trim());

/** The token rides in the URL fragment, which browsers never send to a server. */
export function invitationAcceptUrl(token: string): string {
  const origin = process.env.AXIOM_WEB_APP_URL?.trim() || `https://${BRAND.productDomain}`;
  return `${new URL('/invite', origin).toString()}#token=${token}`;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

export interface InvitationMail {
  email: string;
  tenantName: string;
  role: string;
  acceptUrl: string;
  expiresAt: string;
}

/** One provider attempt; `sent` only with a provider receipt. */
export async function sendInvitationEmail(mail: InvitationMail): Promise<ContactDeliveryResult> {
  const key = process.env.RESEND_API_KEY?.trim();
  if (!key) return { status: 'failed', errorCode: 'provider_unavailable' };
  const from =
    process.env.AXIOM_FROM_EMAIL?.trim() ||
    process.env.RESEND_FROM_EMAIL?.trim() ||
    'Axiom Proof <platform@axiomproof.ai>';
  const subject = `You have been invited to ${mail.tenantName} on ${BRAND.name}`;
  const text = [
    `You have been invited to join ${mail.tenantName} on ${BRAND.name} as ${mail.role}.`,
    ``,
    `Sign in with this email address, then open:`,
    mail.acceptUrl,
    ``,
    `The invitation expires at ${mail.expiresAt}. If you did not expect it, ignore this email.`,
  ].join('\n');
  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;background:#f8fafc;color:#1e293b;padding:24px;">
<div style="max-width:560px;margin:0 auto;background:#fff;border:1px solid #e2e8f0;border-radius:8px;padding:28px;">
<h1 style="font-size:18px;color:#1E2A4A;margin:0 0 12px;">Invitation to ${escapeHtml(mail.tenantName)}</h1>
<p style="font-size:14px;">You have been invited to join as <strong>${escapeHtml(mail.role)}</strong>. Sign in with this email address, then accept:</p>
<p><a href="${escapeHtml(mail.acceptUrl)}" style="display:inline-block;background:#0FB5A5;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;font-weight:600;">Accept invitation</a></p>
<p style="font-size:12px;color:#64748b;">Expires ${escapeHtml(mail.expiresAt)}. If you did not expect this, ignore it.</p>
</div></body></html>`;
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to: [mail.email], subject, text, html }),
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) return { status: 'failed', errorCode: 'provider_refused' };
    const receipt = z.object({ id: z.string().min(1).max(200) }).safeParse(payload);
    return receipt.success
      ? { status: 'sent', providerMessageId: receipt.data.id }
      : { status: 'failed', errorCode: 'provider_no_receipt' };
  } catch {
    return { status: 'failed', errorCode: 'provider_unavailable' };
  }
}
