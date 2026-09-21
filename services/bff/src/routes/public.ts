import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createSupabaseAdmin } from '@axiom/supabase';
import {
  GapScanSubmitSchema,
  GapScanStoredReportSchema,
  GapScanEmailRequestSchema,
} from '@axiom/types';
import { LIBRARY_VERSION } from '@axiom/control-library';
import { computeGapScanReport } from '../services/gap-scan-scoring.js';
import { computeQuarterlyReadinessIndex } from '../services/readiness-index.js';
import { sendGapScanReportEmail } from '../services/gap-scan-email.js';

const proofPattern = /^[a-f0-9]{64}$/;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const selectedFields =
  'id,report_snapshot,library_version,posture_score,estimated_exposure_inr,contact_name,contact_email,contact_phone,contact_company,follow_up_requested,created_at';
const errorBody = (code: string, message: string) => ({ error: { code, message } });
const emailEnabled = () =>
  process.env.AXIOM_REPORT_EMAIL_MODE === 'delivery' && Boolean(process.env.RESEND_API_KEY?.trim());

export function publicRoutes(
  deps: {
    client?: typeof createSupabaseAdmin;
    sendEmail?: typeof sendGapScanReportEmail;
  } = {},
) {
  const app = new Hono();
  const client = deps.client ?? createSupabaseAdmin;
  const sendEmail = deps.sendEmail ?? sendGapScanReportEmail;
  app.use('*', bodyLimit({ maxSize: 32 * 1024 }));
  app.use('*', async (c, next) => {
    c.header('Cache-Control', 'private, no-store');
    await next();
  });

  async function budget(bucket: string, subject: string, limit: number, window = 60) {
    const { data, error } = await client().rpc('take_rate_limit', {
      p_bucket: bucket,
      p_subject: subject,
      p_limit: limit,
      p_window_seconds: window,
    });
    const parsed = z
      .object({ allowed: z.boolean(), retry_after: z.number().int().positive() })
      .safeParse(data);
    if (error || !parsed.success) throw new Error('Public request budget unavailable');
    return parsed.data;
  }
  // Bound anonymous storage/provider traffic even without trusted proxy headers.
  app.use('*', async (c, next) => {
    if (c.req.path.endsWith('/config')) return next();
    const rate = await budget('gap-scan-public', 'global', 1000);
    if (!rate.allowed) {
      c.header('Retry-After', String(rate.retry_after));
      return c.json(errorBody('rate_limited', 'Please try again later.'), 429);
    }
    await next();
  });

  async function readOwned(id: string, proof: string | undefined) {
    if (!z.uuid().safeParse(id).success || !proof || !proofPattern.test(proof)) return null;
    const { data, error } = await client()
      .from('gap_scan_responses')
      .select(selectedFields)
      .eq('id', id)
      .eq('access_token_hash', digest(proof))
      .maybeSingle();
    if (error) throw new Error('Report storage unavailable');
    if (!data) return null;
    return GapScanStoredReportSchema.parse(data);
  }

  app.get('/gap-scan/config', (c) => c.json({ emailDeliveryEnabled: emailEnabled() }));

  app.post('/gap-scan', async (c) => {
    const parsed = GapScanSubmitSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json(errorBody('validation_failed', 'Invalid gap-scan submission'), 400);
    const supplied = c.req.header('X-Gap-Scan-Access');
    if (supplied && !proofPattern.test(supplied))
      return c.json(errorBody('invalid_access', 'Invalid report access token'), 400);
    // Reuse the browser's opaque capability across its reports. A caller's
    // sessionId/IP/User-Agent is analytics input, never proof of ownership.
    const accessToken = supplied ?? randomBytes(32).toString('hex');
    const accessHash = digest(accessToken);
    const rate = await budget('gap-scan-create', accessHash, 20, 3600);
    if (!rate.allowed) {
      c.header('Retry-After', String(rate.retry_after));
      return c.json(errorBody('rate_limited', 'Please try again later.'), 429);
    }
    const input = parsed.data;
    const report = await computeGapScanReport(input.answers);
    if (input.marketingConsent)
      report.readinessIndex = computeQuarterlyReadinessIndex(
        input.sector || 'Other',
        report.postureScore,
      );
    const id = randomUUID();
    const { error } = await client()
      .from('gap_scan_responses')
      .insert({
        id,
        session_id: digest(input.sessionId),
        access_token_hash: accessHash,
        sector: input.sector,
        employee_band: input.employeeBand,
        processes_children_data: input.processesChildrenData,
        is_sdf: input.isSdf,
        answers: input.answers,
        report_snapshot: report,
        library_version: LIBRARY_VERSION,
        posture_score: report.postureScore,
        estimated_exposure_inr: report.estimatedExposureInr,
        contact_name: input.contactName,
        contact_email: input.contactEmail,
        contact_phone: input.contactPhone,
        contact_company: input.contactCompany,
        follow_up_requested: input.followUpRequested,
        marketing_consent: input.marketingConsent,
        source: input.source,
      });
    if (error)
      return c.json(errorBody('persistence_failed', 'Could not save scan. Please try again.'), 503);
    // Submission durably succeeds regardless of a later optional mail failure.
    let emailSent = false;
    try {
      if (input.contactEmail && emailEnabled()) {
        const emailRate = await budget(
          'gap-scan-email-recipient',
          digest(input.contactEmail.toLowerCase()),
          5,
          3600,
        );
        if (emailRate.allowed)
          emailSent = (
            await sendEmail({
              report,
              readinessIndex: report.readinessIndex,
              contactName: input.contactName,
              contactEmail: input.contactEmail,
              contactPhone: input.contactPhone,
              contactCompany: input.contactCompany,
              reportId: id,
            })
          ).success;
      }
    } catch {
      // Persistence already committed. Optional mail must not hide its ownership proof.
      emailSent = false;
    }
    return c.json(
      {
        id,
        accessToken,
        postureScore: report.postureScore,
        estimatedExposureInr: report.estimatedExposureInr,
        findingsCount: report.findings.length,
        readinessIndexGenerated: Boolean(report.readinessIndex),
        emailSent,
      },
      201,
    );
  });

  app.get('/gap-scan/:id', async (c) => {
    const report = await readOwned(c.req.param('id'), c.req.header('X-Gap-Scan-Access'));
    if (!report) return c.json(errorBody('not_found', 'Gap-scan report not found'), 404);
    return c.json(report);
  });

  app.post('/gap-scan/send-email', async (c) => {
    const parsed = GapScanEmailRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json(errorBody('validation_failed', 'Invalid email request'), 400);
    const scan = await readOwned(parsed.data.id, c.req.header('X-Gap-Scan-Access'));
    if (!scan) return c.json(errorBody('not_found', 'Gap-scan report not found'), 404);
    if (!emailEnabled())
      return c.json(
        errorBody('delivery_unavailable', 'Report email delivery is not configured.'),
        503,
      );
    for (const [bucket, subject] of [
      ['gap-scan-email-report', scan.id],
      ['gap-scan-email-recipient', digest(parsed.data.email.toLowerCase())],
    ]) {
      const rate = await budget(bucket!, subject!, 5, 3600);
      if (!rate.allowed) {
        c.header('Retry-After', String(rate.retry_after));
        return c.json(errorBody('rate_limited', 'Please try again later.'), 429);
      }
    }
    const sent = await sendEmail({
      report: scan.report_snapshot,
      readinessIndex: scan.report_snapshot.readinessIndex,
      contactName: scan.contact_name ?? undefined,
      contactEmail: parsed.data.email,
      contactPhone: scan.contact_phone ?? undefined,
      contactCompany: scan.contact_company ?? undefined,
      reportId: scan.id,
    });
    if (!sent.success)
      return c.json(
        errorBody('delivery_failed', 'Email delivery failed. Please try again later.'),
        502,
      );
    return c.json({ success: true });
  });
  app.onError((_error, c) =>
    c.json(errorBody('service_unavailable', 'Report service unavailable. Please try again.'), 503),
  );
  return app;
}
