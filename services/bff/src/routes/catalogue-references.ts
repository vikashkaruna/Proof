import { createHash } from 'node:crypto';
import { Hono } from 'hono';
import { z } from 'zod';
import { createSupabaseAdmin } from '@axiom/supabase';
import { Capability } from '@axiom/types';
import {
  mappingContextPacketSchema,
  mappingContextReferenceProofSchema,
} from '@axiom/control-library';
import { requireCapability } from '../middleware/authorize.js';
import { parsePrativedanAssessmentJson } from '../services/prativedan-assessment-json.js';
import type { Variables } from '../types.js';

const versionSchema = z.string().regex(/^[a-z0-9][a-z0-9.-]{2,79}$/);

/** Read global reference bytes only; never provenance, adoption or write credentials. */
export function catalogueReferenceRoutes() {
  const app = new Hono<{ Variables: Variables }>();
  app.get('/control-catalogue/publications/:version', async (c) => {
    c.header('Cache-Control', 'private, no-store');
    const refused = requireCapability(c, Capability.POSTURE_READ);
    if (refused) return refused;
    const version = versionSchema.safeParse(c.req.param('version'));
    if (!version.success) return c.json({ error: { code: 'invalid_catalogue_version' } }, 400);
    try {
      const result = await createSupabaseAdmin()
        .rpc('read_mapping_context_publication', { p_publication_version: version.data })
        .abortSignal(AbortSignal.timeout(10_000));
      if (result.error) {
        if (
          result.error.code === 'P0001' &&
          result.error.message === 'catalogue context unavailable'
        )
          return c.json({ error: { code: 'catalogue_not_found' } }, 404);
        return c.json({ error: { code: 'catalogue_unavailable' } }, 503);
      }
      const proof = mappingContextReferenceProofSchema.parse(result.data);
      if (Buffer.byteLength(proof.packetText, 'utf8') > 1048576) throw new Error('invalid_packet');
      const packet = mappingContextPacketSchema.parse(
        parsePrativedanAssessmentJson(proof.packetText),
      );
      if (
        proof.publicationVersion !== version.data ||
        proof.publicationVersion !== packet.publicationVersion ||
        proof.libraryVersion !== packet.libraryVersion ||
        proof.contextCount !== packet.contexts.length ||
        proof.packetSha256 !== createHash('sha256').update(proof.packetText, 'utf8').digest('hex')
      )
        throw new Error('invalid_packet');
      return c.json({ data: proof, referenceOnly: true });
    } catch {
      return c.json({ error: { code: 'catalogue_unavailable' } }, 503);
    }
  });
  return app;
}
