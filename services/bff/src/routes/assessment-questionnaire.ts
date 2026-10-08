import { createHash } from 'node:crypto';
import { Hono } from 'hono';
import { z } from 'zod';
import { createSupabaseAdmin } from '@axiom/supabase';
import { AssessmentQuestionnaireSchema, Capability } from '@axiom/types';
import { canonicalJson } from '@axiom/ledger';
import { requireCapability } from '../middleware/authorize.js';
import type { Variables } from '../types.js';

/** Published metadata only. This digest covers the displayed questionnaire;
 * it is not the PostgreSQL controller snapshot digest or verified answers. */
export function assessmentQuestionnaireRoutes() {
  const app = new Hono<{ Variables: Variables }>();
  app.get('/assessment/questionnaire', async (c) => {
    c.header('Cache-Control', 'private, no-store');
    const denied = requireCapability(c, Capability.POSTURE_READ);
    if (denied) return denied;
    const params = [...new URL(c.req.url).searchParams];
    const wanted = z.uuid().safeParse(c.req.query('engagementId'));
    if (!wanted.success || params.length !== 1 || params[0]?.[0] !== 'engagementId')
      return c.json({ error: { code: 'invalid_assessment_questionnaire' } }, 400);
    const tenantId = c.get('tenantId').toLowerCase();
    const unavailable = { error: { code: 'assessment_questionnaire_unavailable' } };
    try {
      const db = createSupabaseAdmin();
      const signal = AbortSignal.timeout(10000);
      const engagementRead = await db
        .from('engagements')
        .select('id,tenant_id,library_version,status')
        .eq('tenant_id', tenantId)
        .eq('id', wanted.data.toLowerCase())
        .abortSignal(signal)
        .maybeSingle();
      if (engagementRead.error) return c.json(unavailable, 503);
      if (!engagementRead.data) return c.json({ error: { code: 'engagement_not_found' } }, 404);
      const engagement = z
        .object({
          id: z.uuid(),
          tenant_id: z.uuid(),
          library_version: z.string().min(1).max(200),
          status: z.string(),
        })
        .parse(engagementRead.data);
      if (
        engagement.tenant_id !== tenantId ||
        engagement.id !== wanted.data.toLowerCase() ||
        engagement.status === 'cancelled'
      )
        return c.json(unavailable, 503);
      const [libraryRead, controlsRead] = await Promise.all([
        db
          .from('control_libraries')
          .select('version,status,control_count')
          .eq('version', engagement.library_version)
          .abortSignal(signal)
          .single(),
        db
          .from('controls')
          .select('id,title,library_version,assessment_questions', { count: 'exact' })
          .eq('library_version', engagement.library_version)
          .order('id')
          .limit(501)
          .abortSignal(signal),
      ]);
      if (libraryRead.error || controlsRead.error) return c.json(unavailable, 503);
      const library = z
        .object({
          version: z.literal(engagement.library_version),
          status: z.enum(['published', 'deprecated']),
          control_count: z.number().int().min(1).max(500),
        })
        .parse(libraryRead.data);
      const question = z.object({
        id: z.string().min(1).max(200),
        prompt: z.string().min(1).max(10000),
        type: z.enum(['boolean', 'scale', 'text', 'multi', 'evidence']),
      });
      const controls = z
        .array(
          z.object({
            id: z.string().min(1).max(200),
            title: z.string().min(1).max(2000),
            library_version: z.literal(engagement.library_version),
            assessment_questions: z.array(question).max(5000),
          }),
        )
        .min(1)
        .max(500)
        .parse(controlsRead.data);
      if (controlsRead.count !== controls.length || library.control_count !== controls.length)
        return c.json(unavailable, 503);
      const projection = {
        libraryVersion: engagement.library_version,
        controls: controls.map((row) => ({
          id: row.id,
          title: row.title,
          questions: row.assessment_questions,
        })),
      };
      return c.json(
        AssessmentQuestionnaireSchema.parse({
          tenantId,
          engagementId: engagement.id,
          ...projection,
          questionnaireDigest: createHash('sha256')
            .update(canonicalJson(projection), 'utf8')
            .digest('hex'),
          digestScope: 'ordered_questionnaire_projection_v1',
          declarationsVerified: false,
        }),
      );
    } catch {
      return c.json(unavailable, 503);
    }
  });
  return app;
}
