import { createHash } from 'node:crypto';
import { Hono } from 'hono';
import { z } from 'zod';
import { createSupabaseAdmin } from '@axiom/supabase';
import { canonicalJson } from '@axiom/ledger';
import { Capability } from '@axiom/types';
import {
  buildLibrarySeed,
  PUBLIC_CONTROL_CATALOGUE_V2_MANIFEST_TEXT,
} from '@axiom/control-library';
import { readPublicEvidenceV2 } from '../connectors/public-evidence-codec-v2.js';
import { evaluatePublicEvidenceV2 } from '../connectors/public-evidence-evaluator-v2.js';
import { requireCapability } from '../middleware/authorize.js';
import type { Variables } from '../types.js';

const uuid = z.uuid().transform((v) => v.toLowerCase());
const hash = (v: string) => createHash('sha256').update(v, 'utf8').digest('hex');
const retained = z
  .object({
    tenantId: uuid,
    engagementId: uuid,
    checkId: uuid,
    checkedAt: z.iso.datetime({ offset: true }),
    rootContentSha256: z.string().regex(/^[a-f0-9]{64}$/),
    codec: z.literal('axiom-public-evidence-v2-canonical-json-1'),
    payloadText: z.string().min(2).max(524288),
    payloadSha256: z.string().regex(/^[a-f0-9]{64}$/),
    captureReceipt: z.string().regex(/^[1-9][0-9]*$/),
    libraryVersion: z.literal('0.1.1'),
    library: z
      .object({
        version: z.literal('0.1.1'),
        published_at: z.iso.datetime({ offset: true }),
        published_by: z.string(),
        change_log: z.string(),
        control_count: z.literal(46),
        status: z.enum(['published', 'deprecated']),
      })
      .passthrough(),
    controls: z.array(z.record(z.string(), z.unknown())).length(46),
    pageSources: z
      .array(
        z
          .object({
            page: z.enum(['root', 'privacy', 'contact', 'terms', 'consent']),
            requestedUrl: z.string().nullable(),
            finalUrl: z.string().nullable(),
            state: z.enum(['examined', 'unavailable', 'unexamined']),
            contentSha256: z.string().nullable(),
          })
          .strict(),
      )
      .length(5),
  })
  .strict();

/** Read-only, deterministic evidence disposition. Does not issue an agent result,
 * persist an assessment decision, change scores, or release a client report. */
export function publicWebsiteControlReviewRoutes() {
  const app = new Hono<{ Variables: Variables }>();
  app.get('/public-website-checks/:checkId/control-review', async (c) => {
    c.header('Cache-Control', 'private, no-store');
    const denied = requireCapability(c, Capability.POSTURE_READ);
    if (denied) return denied;
    const check = uuid.safeParse(c.req.param('checkId'));
    const engagement = uuid.safeParse(c.req.query('engagementId'));
    if (!check.success || !engagement.success)
      return c.json({ error: { code: 'invalid_request' } }, 400);
    try {
      const result = await createSupabaseAdmin()
        .rpc('read_public_website_control_review', {
          p_tenant_id: c.get('tenantId'),
          p_actor_id: c.get('user').id,
          p_engagement_id: engagement.data,
          p_check_id: check.data,
        })
        .abortSignal(AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(10_000)]));
      if (result.error) throw new Error('unavailable');
      if (result.data?.error === 'website_recapture_required')
        return c.json({ error: { code: 'website_recapture_required' } }, 409);
      if (['forbidden', 'context_refused', 'source_refused'].includes(result.data?.error))
        return c.json({ error: { code: 'website_review_context_refused' } }, 404);
      const data = retained.parse(result.data);
      if (
        data.tenantId !== c.get('tenantId').toLowerCase() ||
        data.engagementId !== engagement.data ||
        data.checkId !== check.data
      )
        throw new Error('scope');
      const seed = buildLibrarySeed();
      if (
        data.libraryVersion !== seed.version ||
        data.library.published_by !== seed.publishedBy ||
        data.library.change_log !== seed.changeLog ||
        Date.parse(data.library.published_at) !== Date.parse(seed.publishedAt) ||
        canonicalJson(
          [...data.controls].sort((a, b) => String(a.id).localeCompare(String(b.id))),
        ) !== canonicalJson([...seed.controls].sort((a, b) => a.id.localeCompare(b.id)))
      )
        throw new Error('catalogue');
      const source = readPublicEvidenceV2(
        {
          codec: data.codec,
          payloadBytes: new TextEncoder().encode(data.payloadText),
          payloadSha256: data.payloadSha256,
        },
        {
          tenantId: data.tenantId,
          engagementId: data.engagementId,
          checkId: data.checkId,
          assessmentDate: new Date(data.checkedAt).toISOString().slice(0, 10),
        },
      ).source;
      if (
        source.pages[0]?.contentSha256 !== data.rootContentSha256 ||
        new Set(data.pageSources.map((p) => p.page)).size !== 5
      )
        throw new Error('source');
      for (const p of source.pages) {
        const provenance = data.pageSources.find((v) => v.page === p.page);
        if (
          !provenance ||
          provenance.state !== p.state ||
          (provenance.contentSha256 ?? undefined) !== p.contentSha256
        )
          throw new Error('source');
      }
      const text = PUBLIC_CONTROL_CATALOGUE_V2_MANIFEST_TEXT;
      const sha256 = hash(text);
      const assessment = evaluatePublicEvidenceV2(
        { source, catalogueManifestText: text, catalogueManifestSha256: sha256 },
        { text, sha256 },
      );
      return c.json({
        data: { assessment, catalogueManifestText: text, captureReceipt: data.captureReceipt },
      });
    } catch {
      return c.json({ error: { code: 'website_control_review_unavailable' } }, 503);
    }
  });
  return app;
}
