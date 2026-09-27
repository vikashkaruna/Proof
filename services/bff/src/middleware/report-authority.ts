import { createMiddleware } from 'hono/factory';
import { createSupabaseAdmin } from '@axiom/supabase';
import { z } from 'zod';
import { EvidenceError, type EvidenceDatabase } from '../services/evidence-ingestion.js';
import { EvidencePackService } from '../services/evidence-packs.js';
import { canManagePack } from '../services/evidence-pack-records.js';
import type { Variables } from '../types.js';

/** Revalidate report-specific authority before cached responses can be replayed. */
export function reportAuthority(db?: EvidenceDatabase) {
  return createMiddleware<{ Variables: Variables }>(async (c, next) => {
    if (c.req.method !== 'POST') return next();
    const report = /^\/v1\/reports\/([^/]+)\/(?:review|release)$/.exec(c.req.path);
    const pack = /^\/v1\/evidence-packs(?:\/([^/]+)\/(?:build|builds\/[^/]+\/reconcile))?$/.exec(
      c.req.path,
    );
    if (!report && !pack) return next();
    try {
      const api = new EvidencePackService(db ?? createSupabaseAdmin());
      const access = await api.access(c.get('tenantId'), c.get('user').id);
      if (report && !access.founder) throw new EvidenceError('founder_authority_required', 403);
      if (pack) {
        if (!access.manager) throw new EvidenceError('forbidden', 403);
        if (pack[1]) {
          if (!z.uuid().safeParse(pack[1]).success)
            throw new EvidenceError('validation_failed', 400);
          const bundle = await api.detail(access, pack[1]);
          if (!canManagePack(access, bundle.pack)) throw new EvidenceError('forbidden', 403);
        }
      }
      return next();
    } catch (cause) {
      if (cause instanceof EvidenceError)
        return c.json({ error: { code: cause.code } }, cause.status);
      return c.json({ error: { code: 'report_authority_unavailable' } }, 503);
    }
  });
}
