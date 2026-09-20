import { Hono } from 'hono';
import { z } from 'zod';
import { createSupabaseAdmin } from '@axiom/supabase';
import { logger } from '../lib/logger.js';
import type { LedgerService } from '../services/ledger.js';
import { GapScanSubmitSchema } from '@axiom/types';
import { LIBRARY_VERSION } from '@axiom/control-library';
import { createHash } from 'node:crypto';

interface Deps {
  ledger: LedgerService;
}

export function publicRoutes(deps: Deps) {
  const app = new Hono();

  // Public gap-scan — same logic as the marketing site's endpoint
  // for redundancy; both call into the same Supabase table.
  app.post('/gap-scan', async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = GapScanSubmitSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        {
          error: {
            code: 'validation_failed',
            message: 'Invalid gap-scan submission',
            details: parsed.error.flatten(),
          },
        },
        400,
      );
    }
    const input = parsed.data;
    const ip = c.req.header('x-forwarded-for') ?? 'unknown';
    const ua = c.req.header('user-agent') ?? 'unknown';
    const sessionHash = createHash('sha256').update(`${input.sessionId}|${ip}|${ua}`).digest('hex');

    const admin = createSupabaseAdmin();
    const { data, error } = await admin
      .from('gap_scan_responses')
      .insert({
        session_id: sessionHash,
        sector: input.sector,
        employee_band: input.employeeBand,
        processes_children_data: input.processesChildrenData,
        is_sdf: input.isSdf,
        answers: input.answers,
        library_version: LIBRARY_VERSION,
        contact_name: input.contactName,
        contact_email: input.contactEmail,
        contact_company: input.contactCompany,
        follow_up_requested: input.followUpRequested,
        marketing_consent: input.marketingConsent,
        source: input.source,
      })
      .select('id')
      .single();

    if (error) {
      logger.error({ err: error.message }, 'gap scan insert failed');
      return c.json({ error: { code: 'persistence_failed', message: 'Could not save scan' } }, 500);
    }
    return c.json({ id: data.id }, 201);
  });

  return app;
}
