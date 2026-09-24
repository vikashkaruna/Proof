import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createKillSwitchService } from './kill-switch.js';
import { TENANT_A, TENANT_B } from '../test/harness.js';

/**
 * W9 · SEC-4 · FR-8.6 — "the kill switch halts in-flight execution
 * immediately", including across replicas.
 *
 * The suite drives the service against a fake shared store so two independent
 * service instances can stand in for two BFF replicas.
 */

const FOUNDER = 'ffffffff-0000-0000-0000-000000000001';
const TENANT_OWNER = 'aaaaaaaa-0000-0000-0000-000000000002';

interface Row {
  scope_key: string;
  scope: 'global' | 'tenant';
  tenant_id: string | null;
  engaged: boolean;
  reason: string;
  engaged_by: string | null;
  engaged_at: string | null;
}

/** A stand-in for the shared `kill_switch_state` table. */
function createSharedStore() {
  const rows = new Map<string, Row>();
  let failReads = false;

  const client = {
    from() {
      const state: { filters: Array<[string, unknown]> } = { filters: [] };
      const builder: Record<string, unknown> = {};

      builder.select = () => builder;
      builder.eq = (field: string, value: unknown) => {
        state.filters.push([field, value]);
        // `.select().eq('engaged', true)` resolves as a promise.
        return Object.assign(builder, {
          then: (resolve: (v: unknown) => void) => {
            if (failReads) {
              return Promise.resolve({ data: null, error: { message: 'connection lost' } }).then(
                resolve,
              );
            }
            const matched = [...rows.values()].filter((r) =>
              state.filters.every(([f, v]) => (r as unknown as Record<string, unknown>)[f] === v),
            );
            return Promise.resolve({ data: matched, error: null }).then(resolve);
          },
        });
      };
      builder.upsert = async (row: Row) => {
        rows.set(row.scope_key, { ...rows.get(row.scope_key), ...row } as Row);
        return { data: null, error: null };
      };
      builder.update = (patch: Partial<Row>) => {
        const updateFilters: Array<[string, unknown]> = [];
        const chain: Record<string, unknown> = {
          eq(field: string, value: unknown) {
            updateFilters.push([field, value]);
            return chain;
          },
          select: async () => {
            const matched = [...rows.values()].filter((r) =>
              updateFilters.every(([f, v]) => (r as unknown as Record<string, unknown>)[f] === v),
            );
            for (const row of matched) rows.set(row.scope_key, { ...row, ...patch } as Row);
            return { data: matched.map((r) => ({ scope_key: r.scope_key })), error: null };
          },
        };
        return chain;
      };
      return builder;
    },
  };

  return {
    factory: () => client as never,
    setFailReads: (v: boolean) => {
      failReads = v;
    },
    rows,
  };
}

describe('kill switch — SEC-4 · shared across replicas', () => {
  let store: ReturnType<typeof createSharedStore>;

  beforeEach(() => {
    store = createSharedStore();
  });

  // The headline defect: engaging on one replica left every other replica
  // executing, because the flag was a process-local object.
  it('a halt engaged on one replica is seen by another', async () => {
    const replicaA = createKillSwitchService(store.factory);
    const replicaB = createKillSwitchService(store.factory);

    expect(await replicaB.isActive(TENANT_A)).toBe(false);

    await replicaA.engage({ userId: FOUNDER, reason: 'incident', scope: 'global' });

    replicaB.invalidate(); // stand in for the TTL expiring
    expect(await replicaB.isActive(TENANT_A)).toBe(true);
  });

  it('a tenant-scoped halt does not stop a different tenant', async () => {
    const svc = createKillSwitchService(store.factory);
    await svc.engage({
      userId: TENANT_OWNER,
      reason: 'tenant incident',
      scope: 'tenant',
      tenantId: TENANT_A,
    });

    expect(await svc.isActive(TENANT_A)).toBe(true);
    expect(await svc.isActive(TENANT_B)).toBe(false);
  });

  it('a global halt stops every tenant', async () => {
    const svc = createKillSwitchService(store.factory);
    await svc.engage({ userId: FOUNDER, reason: 'platform incident', scope: 'global' });

    expect(await svc.isActive(TENANT_A)).toBe(true);
    expect(await svc.isActive(TENANT_B)).toBe(true);
    expect(await svc.isActive(undefined)).toBe(true);
  });
});

describe('kill switch — SEC-4 · release is scope-aware', () => {
  let store: ReturnType<typeof createSharedStore>;

  beforeEach(() => {
    store = createSharedStore();
  });

  // The second SEC-4 defect: release() took no arguments and cleared
  // everything, so a tenant owner could lift a founder's platform-wide halt.
  it('a tenant release cannot lift a global halt', async () => {
    const svc = createKillSwitchService(store.factory);
    await svc.engage({ userId: FOUNDER, reason: 'platform incident', scope: 'global' });

    const result = await svc.release({
      scope: 'tenant',
      tenantId: TENANT_A,
      userId: TENANT_OWNER,
    });

    expect(result).toEqual({ released: false, reason: 'global_halt_active' });
    expect(await svc.isActive(TENANT_A)).toBe(true);
  });

  it('releases the global halt when the global scope is named', async () => {
    const svc = createKillSwitchService(store.factory);
    await svc.engage({ userId: FOUNDER, reason: 'platform incident', scope: 'global' });

    const result = await svc.release({ scope: 'global', userId: FOUNDER });

    expect(result).toEqual({ released: true, scope: 'global' });
    expect(await svc.isActive(TENANT_A)).toBe(false);
  });

  it('releases only the named tenant', async () => {
    const svc = createKillSwitchService(store.factory);
    await svc.engage({ userId: TENANT_OWNER, reason: 'a', scope: 'tenant', tenantId: TENANT_A });
    await svc.engage({ userId: TENANT_OWNER, reason: 'b', scope: 'tenant', tenantId: TENANT_B });

    await svc.release({ scope: 'tenant', tenantId: TENANT_A, userId: TENANT_OWNER });

    expect(await svc.isActive(TENANT_A)).toBe(false);
    expect(await svc.isActive(TENANT_B)).toBe(true);
  });

  it('reports rather than throws when nothing was engaged', async () => {
    const svc = createKillSwitchService(store.factory);
    const result = await svc.release({ scope: 'tenant', tenantId: TENANT_A, userId: TENANT_OWNER });
    expect(result).toEqual({ released: false, reason: 'not_engaged' });
  });

  it('requires a tenantId for tenant scope in both directions', async () => {
    const svc = createKillSwitchService(store.factory);
    await expect(svc.engage({ userId: FOUNDER, reason: 'x', scope: 'tenant' })).rejects.toThrow(
      /requires a tenantId/,
    );
    await expect(svc.release({ scope: 'tenant', userId: FOUNDER })).rejects.toThrow(
      /requires a tenantId/,
    );
  });
});

describe('kill switch — fails safe, not open', () => {
  // The emergency stop is the one place where an unreadable dependency must
  // mean "halted". This is the opposite of the SEC-1 family and deliberately
  // so: there, failing open granted authority; here, failing closed withholds
  // it.
  it('reports active when the shared state cannot be read', async () => {
    const store = createSharedStore();
    const svc = createKillSwitchService(store.factory);

    expect(await svc.isActive(TENANT_A)).toBe(false);

    store.setFailReads(true);
    svc.invalidate();

    expect(await svc.isActive(TENANT_A)).toBe(true);
  });

  it('throws rather than silently failing to persist an engage', async () => {
    const store = createSharedStore();
    const svc = createKillSwitchService(store.factory);
    // An engage that does not persist is worse than none, because the
    // operator believes they are safe.
    const failing = createKillSwitchService(
      () =>
        ({
          from: () => ({ upsert: async () => ({ error: { message: 'write failed' } }) }),
        }) as never,
    );

    await expect(
      failing.engage({ userId: FOUNDER, reason: 'incident', scope: 'global' }),
    ).rejects.toThrow(/Failed to engage kill switch/);
    expect(svc).toBeDefined();
  });
});

describe('kill switch — caching', () => {
  it('serves repeated reads from cache within the TTL', async () => {
    const store = createSharedStore();
    const factory = vi.fn(store.factory);
    const svc = createKillSwitchService(factory);

    await svc.isActive(TENANT_A);
    await svc.isActive(TENANT_A);
    await svc.isActive(TENANT_A);

    // One shared-store read, not three — the execute path calls this per action.
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('re-reads after invalidation', async () => {
    const store = createSharedStore();
    const factory = vi.fn(store.factory);
    const svc = createKillSwitchService(factory);

    await svc.isActive(TENANT_A);
    svc.invalidate();
    await svc.isActive(TENANT_A);

    expect(factory).toHaveBeenCalledTimes(2);
  });
});
