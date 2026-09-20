import { NextResponse } from 'next/server';
import { GapScanSubmitSchema } from '@axiom/types';
import { computeGapScanReport } from '@/lib/gap-scan-scoring';
import { computeQuarterlyReadinessIndex } from '@/lib/readiness-index';
import { saveGapScanSubmission } from '@/lib/gap-scan-store';
import { sendGapScanReportEmail } from '@/lib/gap-scan-email';
import { createHash, randomUUID } from 'node:crypto';

export const runtime = 'nodejs';

/**
 * Public gap-scan endpoint — anonymous, no auth required.
 * Computes a posture score + estimated exposure against the v0.1.0 control
 * library, computes quarterly readiness index if requested, persists to database,
 * sends transactional notification email, and returns report ID.
 */
export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: { code: 'invalid_body', message: 'Request body must be JSON' } },
      { status: 400 },
    );
  }

  const parsed = GapScanSubmitSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: {
          code: 'validation_failed',
          message: 'Invalid gap-scan submission',
          details: parsed.error.flatten(),
        },
      },
      { status: 400 },
    );
  }

  const input = parsed.data;
  const ip = request.headers.get('x-forwarded-for') ?? 'unknown';
  const ua = request.headers.get('user-agent') ?? 'unknown';
  const sessionHash = createHash('sha256').update(`${input.sessionId}|${ip}|${ua}`).digest('hex');

  const report = await computeGapScanReport(input.answers);
  const scanId = randomUUID();

  // If user selected "Send me the quarterly readiness index (optional)", generate index
  if (input.marketingConsent) {
    report.readinessIndex = computeQuarterlyReadinessIndex(
      input.sector || 'Other',
      report.postureScore,
    );
  }

  const savedId = await saveGapScanSubmission({
    id: scanId,
    session_id: sessionHash,
    sector: input.sector,
    employee_band: input.employeeBand,
    processes_children_data: input.processesChildrenData,
    is_sdf: input.isSdf,
    answers: input.answers,
    report_snapshot: report,
    library_version: '0.1.0',
    posture_score: report.postureScore,
    estimated_exposure_inr: report.estimatedExposureInr,
    contact_name: input.contactName,
    contact_email: input.contactEmail,
    contact_phone: input.contactPhone,
    contact_company: input.contactCompany,
    follow_up_requested: input.followUpRequested,
    marketing_consent: input.marketingConsent,
    created_at: new Date().toISOString(),
  });

  // Automatically send report email if contactEmail was provided
  let emailSent = false;
  if (input.contactEmail?.trim()) {
    const emailResult = await sendGapScanReportEmail({
      report,
      readinessIndex: report.readinessIndex,
      contactName: input.contactName,
      contactEmail: input.contactEmail.trim(),
      contactPhone: input.contactPhone,
      contactCompany: input.contactCompany,
      reportId: savedId,
    });
    emailSent = emailResult.success;
  }

  const response = NextResponse.json({
    id: savedId,
    postureScore: report.postureScore,
    estimatedExposureInr: report.estimatedExposureInr,
    findingsCount: report.findings.length,
    readinessIndexGenerated: Boolean(report.readinessIndex),
    emailSent,
  });

  // The Secure flag was dropped in local, development, staging and any
  // container without NODE_ENV. Only one of those clauses was ever load-bearing
  // — a cookie with Secure cannot be set over plain HTTP — and the protocol
  // check expresses it directly. An HTTPS staging deployment now gets a Secure
  // cookie, as it should.
  const isInsecureTransport = !request.url.startsWith('https:');

  response.cookies.set('gap_scan_access', sessionHash, {
    httpOnly: true,
    sameSite: 'lax',
    secure: !isInsecureTransport,
    maxAge: 60 * 60 * 24 * 7,
    path: '/',
  });
  return response;
}
