import { z } from 'zod';
import {
  EvidenceError,
  uuidSchema,
  type EvidenceDatabase,
} from '../services/evidence-ingestion.js';

/** Protected designation, never a selected tenant role or a browser claim. */
export async function isLivePlatformFounder(
  db: EvidenceDatabase,
  actorId: string,
  signal?: AbortSignal,
): Promise<boolean> {
  let designation = db
    .from('platform_founders')
    .select('user_id,revoked_at')
    .eq('user_id', actorId);
  if (signal) designation = designation.abortSignal(signal);
  const result = await designation.maybeSingle();
  if (result.error) throw new EvidenceError('founder_authority_unavailable', 503);
  const founder = z.object({ user_id: uuidSchema, revoked_at: z.null() }).safeParse(result.data);
  if (!founder.success || founder.data.user_id !== actorId) return false;
  let profile = db.from('users').select('is_axiom_internal').eq('id', actorId);
  if (signal) profile = profile.abortSignal(signal);
  const user = await profile.maybeSingle();
  if (user.error) throw new EvidenceError('founder_authority_unavailable', 503);
  return user.data?.is_axiom_internal === true;
}
