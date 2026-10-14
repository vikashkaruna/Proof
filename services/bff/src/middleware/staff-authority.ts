import { createMiddleware } from 'hono/factory';
import { z } from 'zod';
import { createSupabaseAdmin } from '@axiom/supabase';
import type { Variables } from '../types.js';

const ProfileRows = z
  .array(z.object({ id: z.uuid(), is_axiom_internal: z.boolean() }).strict())
  .max(1);

/** Admission only: SQL must separately guard the mutation transaction. Existing
 * signed approvals retain their expiry/revocation rules; this grants no token.
 */
export const requireLiveStaffAuthority = createMiddleware<{ Variables: Variables }>(
  async (c, next) => {
    const role = c.get('role');
    if (
      ['GET', 'HEAD', 'OPTIONS'].includes(c.req.method) ||
      (role !== 'founder' && role !== 'axiom_analyst')
    )
      return next();

    const actor = z.uuid().safeParse(c.get('user')?.id);
    if (!actor.success) return c.json({ error: { code: 'staff_authority_unavailable' } }, 503);
    try {
      const { data, error } = await createSupabaseAdmin()
        .from('users')
        .select('id,is_axiom_internal')
        .eq('id', actor.data)
        .abortSignal(AbortSignal.timeout(10_000));
      const profiles = ProfileRows.safeParse(data);
      if (
        error ||
        !profiles.success ||
        (profiles.data.length === 1 &&
          profiles.data[0]?.id.toLowerCase() !== actor.data.toLowerCase())
      )
        return c.json({ error: { code: 'staff_authority_unavailable' } }, 503);
      if (profiles.data.length !== 1 || !profiles.data[0]?.is_axiom_internal)
        return c.json({ error: { code: 'staff_authority_required' } }, 403);
    } catch {
      return c.json({ error: { code: 'staff_authority_unavailable' } }, 503);
    }
    await next();
  },
);
