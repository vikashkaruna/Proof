import { BRAND } from '@axiom/config';
import { z } from 'zod';

export interface ContactInquiryMail {
  id: string;
  name: string;
  email: string;
  company?: string;
  message: string;
  receivedAt: string;
}

export type ContactDeliveryResult =
  | { status: 'sent'; providerMessageId: string }
  | {
      status: 'failed';
      errorCode: 'provider_refused' | 'provider_unavailable' | 'provider_no_receipt';
    };

/** Contact mail is an explicit opt-in, separate from report mail. */
export const contactEmailEnabled = () =>
  process.env.AXIOM_CONTACT_EMAIL_MODE === 'delivery' &&
  Boolean(process.env.RESEND_API_KEY?.trim());

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * One provider attempt. Callers must only invoke this when contactEmailEnabled()
 * holds; the result is the sole basis for any delivery claim.
 */
export async function sendContactInquiryEmail(
  inquiry: ContactInquiryMail,
): Promise<ContactDeliveryResult> {
  const resendApiKey = process.env.RESEND_API_KEY?.trim();
  if (!resendApiKey) return { status: 'failed', errorCode: 'provider_unavailable' };
  const fromEmail =
    process.env.AXIOM_FROM_EMAIL?.trim() ||
    process.env.RESEND_FROM_EMAIL?.trim() ||
    'Axiom Proof <platform@axiomproof.ai>';
  const recipientEmail = process.env.CONTACT_RECIPIENT_EMAIL?.trim() || BRAND.contactEmail;
  const { name, email, company, message, receivedAt, id } = inquiry;
  const subject = `New contact inquiry from ${name}${company ? ` (${company})` : ''}`;
  const text = [
    `New contact inquiry received via ${BRAND.website}:`,
    ``,
    `Inquiry: ${id}`,
    `Name:    ${name}`,
    `Email:   ${email}`,
    `Company: ${company || 'N/A'}`,
    `Date:    ${receivedAt}`,
    ``,
    `Message:`,
    message,
  ].join('\n');
  const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;background:#f8fafc;color:#1e293b;margin:0;padding:24px;">
  <div style="max-width:600px;margin:0 auto;background:#fff;border-radius:8px;overflow:hidden;border:1px solid #e2e8f0;">
    <div style="background:#1E2A4A;padding:24px 32px;border-bottom:3px solid #0FB5A5;">
      <h1 style="color:#fff;margin:0;font-size:20px;font-weight:600;">${BRAND.name} — Direct Founder Inquiry</h1>
    </div>
    <div style="padding:32px;">
      <p style="font-size:14px;margin:0 0 6px;"><strong>Sender:</strong> ${escapeHtml(name)}</p>
      <p style="font-size:14px;margin:0 0 6px;"><strong>Email:</strong> ${escapeHtml(email)}</p>
      <p style="font-size:14px;margin:0 0 6px;"><strong>Company:</strong> ${escapeHtml(company || 'Not provided')}</p>
      <p style="font-size:14px;margin:0 0 6px;"><strong>Received:</strong> ${escapeHtml(receivedAt)}</p>
      <p style="font-size:12px;margin:0 0 18px;color:#64748b;">Inquiry ${escapeHtml(id)}</p>
      <div style="background:#f8fafc;border-left:4px solid #0FB5A5;padding:16px 20px;border-radius:4px;font-size:15px;line-height:1.6;white-space:pre-wrap;color:#334155;">${escapeHtml(message)}</div>
    </div>
  </div>
</body></html>`;
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
      headers: { Authorization: `Bearer ${resendApiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: fromEmail,
        to: [recipientEmail],
        reply_to: email,
        subject,
        text,
        html,
      }),
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
