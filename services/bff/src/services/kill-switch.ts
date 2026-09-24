import type { SupabaseClient } from '@supabase/supabase-js';
import { createSupabaseAdmin } from '@axiom/supabase';
import { logger } from '../lib/logger.js';

export interface KillSwitchState {
  engaged: boolean;
  reason: string;
  engagedBy: string;
  engagedAt: string;
  scope: 'global' | 'tenant';
  tenantId?: string;
}

export interface EngageOptions {
  tenantId?: string;
  userId: string;
  reason: string;
  scope: 'global' | 'tenant';
}

export interface ReleaseOptions {
  /** The scope being released. A tenant release must not clear a global halt. */
  scope: 'global' | 'tenant';
  tenantId?: string;
  userId: string;
}

export type ReleaseResult =
  | { released: true; scope: 'global' | 'tenant' }
  | { released: false; reason: 'not_engaged' | 'global_halt_active' };

/**
 * Kill switch — per Doc 04 §5.4, halts all in-flight execution immediately,
 * globally or scoped to a tenant. FR-8.6 requires "immediately effective".
 *
 * SEC-4, defect 1: this was a process-local object. The deployment target is
 * Cloud Run / EKS with multiple replicas, so engaging it halted one instance
 * while every other replica carried on executing against a client estate. It
 * said so in its own docstring and was shipped anyway.
 *
 * State now lives in `kill_switch_state` (migration 0009) and every replica
 * reads the same row. Reads are served from a short TTL cache so the execute
 * path does not take a round-trip per action; the TTL is the propagation
 * bound, and it is deliberately short because this is the emergency stop.
 *
 * SEC-4, defect 2: `release()` took no arguments and cleared everything, so a
 * tenant owner could release a founder-engaged GLOBAL halt. Release is now
 * scope-aware and refuses to clear a scope the caller did not name.
 */
export interface KillSwitchService {
  /**
   * Whether execution is halted for this tenant. Reads through the cache, so
   * it is cheap enough to call per action. Returns the fail-safe answer
   * (halted) if the shared state cannot be read — an emergency stop that
   * cannot be verified must be assumed engaged.
   */
  isActive(tenantId?: string): Promise<boolean>;
  engage(opts: EngageOptions): Promise<void>;
  release(opts: ReleaseOptions): Promise<ReleaseResult>;
  state(tenantId?: string): Promise<KillSwitchState>;
  /** Drops the local cache. Used by tests and after a write. */
  invalidate(): void;
}

/** How long a replica may serve a cached answer. */
const CACHE_TTL_MS = 2_000;

const GLOBAL_SCOPE_KEY = 'global';

interface CachedRow {
  scope_key: string;
  scope: 'global' | 'tenant';
  tenant_id: string | null;
  engaged: boolean;
  reason: string;
  engaged_by: string | null;
  engaged_at: string | null;
}

export function createKillSwitchService(
  clientFactory: () => SupabaseClient = createSupabaseAdmin,
): KillSwitchService {
  let cache: { rows: CachedRow[]; readAt: number } | null = null;
  // Set when the shared state could not be read. Treated as engaged.
  let lastReadFailed = false;

  async function loadEngagedRows(): Promise<CachedRow[]> {
    const now = Date.now();
    if (cache && now - cache.readAt < CACHE_TTL_MS) return cache.rows;

    const supabase = clientFactory();
    const { data, error } = await supabase
      .from('kill_switch_state')
      .select('scope_key, scope, tenant_id, engaged, reason, engaged_by, engaged_at')
      .eq('engaged', true);

    if (error) {
      // Fail safe, not fail open. If we cannot confirm the emergency stop is
      // clear, we must not let execution proceed. This is the opposite of the
      // SEC-1 family, and deliberately so: there, failing open granted
      // authority; here, failing closed withholds it.
      lastReadFailed = true;
      logger.error({ error: error.message }, 'kill switch state unreadable; assuming engaged');
      return cache?.rows ?? [];
    }

    lastReadFailed = false;
    cache = { rows: (data ?? []) as CachedRow[], readAt: now };
    return cache.rows;
  }

  return {
    async isActive(tenantId?: string) {
      const rows = await loadEngagedRows();
      if (lastReadFailed) return true;
      if (rows.some((r) => r.scope === 'global')) return true;
      return Boolean(
        tenantId && rows.some((r) => r.scope === 'tenant' && r.tenant_id === tenantId),
      );
    },

    async engage({ tenantId, userId, reason, scope }) {
      if (scope === 'tenant' && !tenantId) {
        throw new Error('A tenant-scoped kill switch requires a tenantId');
      }
      const scopeKey = scope === 'global' ? GLOBAL_SCOPE_KEY : tenantId!;
      const supabase = clientFactory();

      const { error } = await supabase.from('kill_switch_state').upsert(
        {
          scope_key: scopeKey,
          scope,
          tenant_id: scope === 'global' ? null : tenantId,
          engaged: true,
          reason,
          engaged_by: userId,
          engaged_at: new Date().toISOString(),
          released_by: null,
          released_at: null,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'scope_key' },
      );

      if (error) {
        // An emergency stop that silently failed to persist is worse than no
        // emergency stop, because the operator believes they are safe.
        logger.error({ error: error.message, scope, tenantId }, 'KILL SWITCH ENGAGE FAILED');
        throw new Error(`Failed to engage kill switch: ${error.message}`);
      }

      this.invalidate();
      logger.warn({ userId, reason, scope, tenantId }, 'KILL SWITCH ENGAGED');
    },

    async release({ scope, tenantId, userId }) {
      if (scope === 'tenant' && !tenantId) {
        throw new Error('A tenant-scoped release requires a tenantId');
      }
      const scopeKey = scope === 'global' ? GLOBAL_SCOPE_KEY : tenantId!;

      // SEC-4 defect 2: releasing a tenant scope must not lift a global halt.
      // The caller may hold `owner` on one tenant; that is not authority over
      // every other tenant's execution.
      if (scope === 'tenant') {
        const rows = await loadEngagedRows();
        if (rows.some((r) => r.scope === 'global')) {
          logger.warn(
            { userId, tenantId },
            'tenant release refused: a global kill switch is engaged',
          );
          return { released: false, reason: 'global_halt_active' };
        }
      }

      const supabase = clientFactory();
      const { data, error } = await supabase
        .from('kill_switch_state')
        .update({
          engaged: false,
          released_by: userId,
          released_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('scope_key', scopeKey)
        .eq('engaged', true)
        .select('scope_key');

      if (error) {
        logger.error({ error: error.message, scope, tenantId }, 'kill switch release failed');
        throw new Error(`Failed to release kill switch: ${error.message}`);
      }

      this.invalidate();

      if (!data || data.length === 0) {
        return { released: false, reason: 'not_engaged' };
      }

      logger.warn({ userId, scope, tenantId }, 'kill switch released');
      return { released: true, scope };
    },

    async state(tenantId?: string) {
      const rows = await loadEngagedRows();
      const global = rows.find((r) => r.scope === 'global');
      const scoped = tenantId
        ? rows.find((r) => r.scope === 'tenant' && r.tenant_id === tenantId)
        : undefined;
      const row = global ?? scoped;

      if (!row) {
        return { engaged: false, reason: '', engagedBy: '', engagedAt: '', scope: 'global' };
      }
      return {
        engaged: true,
        reason: row.reason,
        engagedBy: row.engaged_by ?? '',
        engagedAt: row.engaged_at ?? '',
        scope: row.scope,
        tenantId: row.tenant_id ?? undefined,
      };
    },

    invalidate() {
      cache = null;
    },
  };
}
