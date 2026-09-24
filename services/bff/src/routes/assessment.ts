import { Hono } from 'hono';
import { z } from 'zod';
import { createSupabaseAdmin } from '@axiom/supabase';
import { AssessmentSnapshotSchema, Capability, type AssessmentControl } from '@axiom/types';
import { requireCapability } from '../middleware/authorize.js';
import type { Variables } from '../types.js';

const nullableNumber = z
  .union([z.number(), z.string().min(1)])
  .transform(Number)
  .pipe(z.number().finite().nonnegative())
  .nullable();
const engagementSchema = z.object({
  id: z.uuid(),
  title: z.string(),
  library_version: z.string(),
  status: z.string(),
  estimated_exposure_inr: nullableNumber.pipe(
    z.number().int().max(Number.MAX_SAFE_INTEGER).nullable(),
  ),
});
const controlSchema = z.object({
  id: z.string(),
  title: z.string(),
  domain: z.string(),
  citations: z.array(z.object({ instrument: z.string(), reference: z.string() })),
});
const findingSchema = z.object({
  control_id: z.string(),
  score: nullableNumber.pipe(z.number().min(0).max(100)),
  evidence_ids: z.array(z.uuid()),
});
const evidenceSchema = z.object({ id: z.uuid() });
const unavailable = {
  error: {
    code: 'assessment_unavailable',
    message: 'Saved assessment results are unavailable. Try again.',
  },
};

/** Read projection only: never starts an assessment, recomputes scores or seals evidence. */
export function assessmentRoutes() {
  const app = new Hono<{ Variables: Variables }>();
  app.get('/assessment', async (c) => {
    c.header('Cache-Control', 'private, no-store');
    const denied = requireCapability(c, Capability.POSTURE_READ);
    if (denied) return denied;
    const wanted = c.req.query('engagementId');
    if (wanted !== undefined && !z.uuid().safeParse(wanted).success)
      return c.json({ error: { code: 'invalid_engagement' } }, 400);
    const tenantId = c.get('tenantId');
    try {
      const db = createSupabaseAdmin();
      let engagementQuery = db
        .from('engagements')
        .select('id, title, library_version, status, estimated_exposure_inr')
        .eq('tenant_id', tenantId);
      if (wanted) engagementQuery = engagementQuery.eq('id', wanted);
      const [engagementResult, tenantResult] = await Promise.all([
        engagementQuery.order('created_at', { ascending: false }).limit(1).maybeSingle(),
        db.from('tenants').select('is_sdf').eq('id', tenantId).single(),
      ]);
      if (engagementResult.error || tenantResult.error) return c.json(unavailable, 503);
      const tenant = z.object({ is_sdf: z.boolean() }).parse(tenantResult.data);
      if (!engagementResult.data) {
        if (wanted) return c.json({ error: { code: 'engagement_not_found' } }, 404);
        return c.json(
          AssessmentSnapshotSchema.parse({
            tenantId,
            engagement: null,
            isSdf: tenant.is_sdf,
            exposureInr: null,
            controls: [],
            summary: { pass: 0, partial: 0, fail: 0, unassessed: 0 },
          }),
        );
      }
      const engagement = engagementSchema.parse(engagementResult.data);
      const [libraryResult, controlResult, findingResult, evidenceResult] = await Promise.all([
        db
          .from('control_libraries')
          .select('control_count, status')
          .eq('version', engagement.library_version)
          .single(),
        db
          .from('controls')
          .select('id, title, domain, citations', { count: 'exact' })
          .eq('library_version', engagement.library_version)
          .order('id')
          .limit(1000),
        db
          .from('findings')
          .select('control_id, score, evidence_ids', { count: 'exact' })
          .eq('tenant_id', tenantId)
          .eq('engagement_id', engagement.id)
          .eq('library_version', engagement.library_version)
          .limit(1000),
        db
          .from('evidence')
          .select('id', { count: 'exact' })
          .eq('tenant_id', tenantId)
          .eq('engagement_id', engagement.id)
          .limit(1000),
      ]);
      if (libraryResult.error || controlResult.error || findingResult.error || evidenceResult.error)
        return c.json(unavailable, 503);
      if (
        [controlResult, findingResult, evidenceResult].some(
          (result) => result.count !== result.data?.length,
        )
      )
        return c.json(unavailable, 503);
      const library = z
        .object({
          control_count: z.number().int().positive(),
          status: z.enum(['published', 'deprecated']),
        })
        .parse(libraryResult.data);
      if (library.control_count !== controlResult.data?.length) return c.json(unavailable, 503);
      const definitions = z.array(controlSchema).min(1).max(999).parse(controlResult.data);
      const findings = z.array(findingSchema).max(999).parse(findingResult.data);
      const evidence = new Set(
        z
          .array(evidenceSchema)
          .max(999)
          .parse(evidenceResult.data)
          .map((row) => row.id),
      );
      // Refuse ambiguous/corrupt snapshots instead of presenting one arbitrary row.
      if (
        new Set(definitions.map((row) => row.id)).size !== definitions.length ||
        new Set(findings.map((row) => row.control_id)).size !== findings.length
      )
        return c.json(unavailable, 503);
      const byControl = new Map(findings.map((row) => [row.control_id, row]));
      if (findings.some((row) => !definitions.some((control) => control.id === row.control_id)))
        return c.json(unavailable, 503);
      const controls: AssessmentControl[] = definitions.map((control) => {
        const finding = byControl.get(control.id);
        const score = finding?.score ?? null;
        return {
          id: control.id,
          name: control.title,
          domain: control.domain,
          cite: control.citations.map((cite) => `${cite.instrument} ${cite.reference}`).join(' · '),
          score,
          // Preserve the existing presentation bands; these are not a legal determination.
          status:
            score === null ? 'unassessed' : score >= 80 ? 'pass' : score >= 40 ? 'partial' : 'fail',
          evidenceIds: [...new Set(finding?.evidence_ids ?? [])].filter((id) => evidence.has(id)),
        };
      });
      const summary = { pass: 0, partial: 0, fail: 0, unassessed: 0 };
      for (const control of controls) summary[control.status] += 1;
      return c.json(
        AssessmentSnapshotSchema.parse({
          tenantId,
          engagement: {
            id: engagement.id,
            title: engagement.title,
            libraryVersion: engagement.library_version,
            status: engagement.status,
          },
          isSdf: tenant.is_sdf,
          exposureInr: engagement.estimated_exposure_inr,
          controls,
          summary,
        }),
      );
    } catch {
      return c.json(unavailable, 503);
    }
  });
  return app;
}
