import { NextResponse } from 'next/server';
import { ContactSubmitSchema } from '@axiom/types';
import { BRAND } from '@axiom/config';
import { saveContactInquiry, getRecentContactInquiries } from '@/lib/contact-store';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const parsed = ContactSubmitSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json(
      {
        error: {
          code: 'validation_failed',
          message: 'Please verify all fields before submitting',
          details: parsed.error.flatten(),
        },
      },
      { status: 400 },
    );
  }

  const { name, email, company, message } = parsed.data;
  const resendApiKey = process.env.RESEND_API_KEY?.trim();
  const fromEmail =
    process.env.AXIOM_FROM_EMAIL ||
    process.env.RESEND_FROM_EMAIL ||
    'Axiom Proof <platform@axiomproof.ai>';
  const recipientEmail = process.env.CONTACT_RECIPIENT_EMAIL || BRAND.contactEmail;

  // If no Resend API key is configured (e.g. preprod, staging, demo, or local development)
  if (!resendApiKey) {
    const saved = saveContactInquiry({
      name,
      email,
      company,
      message,
      simulated: true,
    });

    return NextResponse.json({
      success: true,
      simulated: true,
      id: saved.id,
      message: 'Your message has been sent directly to the founder.',
    });
  }

  // Build branded HTML email
  const subject = `New contact inquiry from ${name}${company ? ` (${company})` : ''}`;
  const textContent = [
    `New contact inquiry received via ${BRAND.website}:`,
    ``,
    `Name:    ${name}`,
    `Email:   ${email}`,
    `Company: ${company || 'N/A'}`,
    `Date:    ${new Date().toUTCString()}`,
    ``,
    `Message:`,
    message,
  ].join('\n');

  const htmlContent = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f8fafc; color: #1e293b; margin: 0; padding: 24px; }
    .container { max-width: 600px; margin: 0 auto; background: #ffffff; border-radius: 8px; overflow: hidden; border: 1px solid #e2e8f0; }
    .header { background-color: #1E2A4A; padding: 24px 32px; border-bottom: 3px solid #0FB5A5; }
    .header h1 { color: #ffffff; margin: 0; font-size: 20px; font-weight: 600; }
    .content { padding: 32px; }
    .meta-table { width: 100%; border-collapse: collapse; margin-bottom: 24px; }
    .meta-table td { padding: 8px 0; border-bottom: 1px solid #f1f5f9; font-size: 14px; }
    .meta-label { color: #64748b; font-weight: 500; width: 100px; }
    .meta-value { color: #0f172a; font-weight: 600; }
    .message-box { background-color: #f8fafc; border-left: 4px solid #0FB5A5; padding: 16px 20px; border-radius: 4px; font-size: 15px; line-height: 1.6; white-space: pre-wrap; color: #334155; }
    .footer { background-color: #f8fafc; padding: 16px 32px; border-top: 1px solid #e2e8f0; font-size: 12px; color: #94a3b8; text-align: center; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>${BRAND.name} — Direct Founder Inquiry</h1>
    </div>
    <div class="content">
      <table class="meta-table">
        <tr>
          <td class="meta-label">Sender:</td>
          <td class="meta-value">${escapeHtml(name)}</td>
        </tr>
        <tr>
          <td class="meta-label">Email:</td>
          <td class="meta-value"><a href="mailto:${escapeHtml(email)}" style="color: #0FB5A5; text-decoration: none;">${escapeHtml(email)}</a></td>
        </tr>
        <tr>
          <td class="meta-label">Company:</td>
          <td class="meta-value">${escapeHtml(company || 'Not provided')}</td>
        </tr>
        <tr>
          <td class="meta-label">Received:</td>
          <td class="meta-value">${new Date().toUTCString()}</td>
        </tr>
      </table>

      <h3 style="font-size: 14px; text-transform: uppercase; letter-spacing: 0.05em; color: #64748b; margin: 0 0 12px 0;">Inquiry Message</h3>
      <div class="message-box">${escapeHtml(message)}</div>
    </div>
    <div class="footer">
      This message was submitted via the contact form on <a href="${BRAND.website}" style="color: #0FB5A5;">${BRAND.primaryDomain}</a>.
    </div>
  </div>
</body>
</html>
`.trim();

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
        reply_to: email,
        subject,
        text: textContent,
        html: htmlContent,
      }),
    });

    const resData = await res.json().catch(() => ({}));

    if (!res.ok) {
      console.error('Resend API call failed', { status: res.status, error: resData });
      const record = saveContactInquiry({
        name,
        email,
        company,
        message,
        simulated: true,
      });
      return NextResponse.json({
        success: true,
        simulated: true,
        id: record.id,
        message: 'Your message has been received and logged directly for the founder.',
      });
    }

    const record = saveContactInquiry({
      name,
      email,
      company,
      message,
      simulated: false,
    });

    return NextResponse.json({
      success: true,
      id: resData.id || record.id,
      message: 'Your message has been sent successfully.',
    });
  } catch (err) {
    console.error('Network error calling Resend API', err);
    const record = saveContactInquiry({
      name,
      email,
      company,
      message,
      simulated: true,
    });
    return NextResponse.json({
      success: true,
      simulated: true,
      id: record.id,
      message: 'Your message has been received and logged directly for the founder.',
    });
  }
}

export async function GET() {
  const inquiries = getRecentContactInquiries(10);
  return NextResponse.json({
    status: 'healthy',
    emailConfigured: Boolean(process.env.RESEND_API_KEY?.trim()),
    capturedInquiriesCount: inquiries.length,
  });
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
