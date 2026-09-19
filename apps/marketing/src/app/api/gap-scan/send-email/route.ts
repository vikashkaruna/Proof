import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getGapScanReport } from '@/lib/gap-scan-store';
import { sendGapScanReportEmail } from '@/lib/gap-scan-email';
import { GapScanReportSchema } from '@axiom/types';

export const runtime = 'nodejs';

const SendEmailRequestSchema = z.object({
  id: z.string().uuid(),
  email: z.string().trim().email('Please enter a valid email address'),
  name: z.string().trim().optional(),
  phone: z.string().trim().optional(),
  company: z.string().trim().optional(),
});

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: { code: 'invalid_json', message: 'Request body must be valid JSON' } },
      { status: 400 },
    );
  }

  const parsed = SendEmailRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: {
          code: 'validation_failed',
          message: parsed.error.issues[0]?.message || 'Invalid email dispatch parameters',
        },
      },
      { status: 400 },
    );
  }

  const { id, email, name, phone, company } = parsed.data;

  // Retrieve scan record (bypass session restriction for direct report ID on verified email send)
  const scan = await getGapScanReport(id, undefined, true);
  if (!scan) {
    return NextResponse.json(
      { error: { code: 'not_found', message: 'Gap-scan report not found' } },
      { status: 404 },
    );
  }

  const reportParsed = GapScanReportSchema.safeParse(scan.report_snapshot);
  if (!reportParsed.success) {
    return NextResponse.json(
      { error: { code: 'corrupt_report', message: 'Report data could not be parsed' } },
      { status: 500 },
    );
  }

  const report = reportParsed.data;

  const result = await sendGapScanReportEmail({
    report,
    readinessIndex: report.readinessIndex,
    contactName: name || scan.contact_name,
    contactEmail: email,
    contactPhone: phone || scan.contact_phone,
    contactCompany: company || scan.contact_company,
    reportId: scan.id,
  });

  if (!result.success) {
    return NextResponse.json(
      {
        error: {
          code: 'delivery_failed',
          message: result.error || 'Failed to dispatch report email',
        },
      },
      { status: 502 },
    );
  }

  return NextResponse.json({
    success: true,
    simulated: result.simulated ?? false,
    message: `Report successfully dispatched to ${email}`,
  });
}
