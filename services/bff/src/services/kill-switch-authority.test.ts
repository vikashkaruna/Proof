import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { UserRole } from '@axiom/types';
import { createKillSwitchService, KillSwitchAuthorityRefused } from './kill-switch.js';
import type { Variables } from '../types.js';

vi.hoisted(() =>
  Object.assign(process.env, {
    NODE_ENV: 'test',
    SUPABASE_URL: 'https://local.supabase.co',
    SUPABASE_ANON_KEY: 'a'.repeat(40),
    SUPABASE_SERVICE_KEY: 'b'.repeat(40),
    APPROVAL_SIGNING_KEY: 'k'.repeat(48),
  }),
);
const tenantId = '11111111-1111-4111-8111-1111111111aa';
const userId = '22222222-2222-4222-8222-2222222222bb';
type Row = Record<string, unknown>;

// PostgreSQL UUID equality ignores hexadecimal letter casing; responses are canonical.
function matchesField(row: Row, key: string, value: unknown): boolean {
  const stored = row[key];
  if (
    ['tenant_id', 'user_id', 'id'].includes(key) &&
    typeof stored === 'string' &&
    typeof value === 'string'
  )
    return stored.toLowerCase() === value.toLowerCase();
  return stored === value;
}

function fixture() {
  const members: Row[] = [{ tenant_id: tenantId, user_id: userId, role: 'founder' }];
  const founders: Row[] = [];
  const users: Row[] = [{ id: userId, is_axiom_internal: true }];
  const stops: Row[] = [
    {
      scope_key: 'global',
      scope: 'global',
      tenant_id: null,
      engaged: true,
      reason: 'incident',
      engaged_by: userId,
      engaged_at: new Date().toISOString(),
    },
  ];
  const upsert = vi.fn(async (row: Row) => {
    stops.splice(0, stops.length, row);
    return { error: null };
  });
  const update = vi.fn();
  const rpc = vi.fn();
  const signals: AbortSignal[] = [];
  const reads: string[] = [];
  let fault:
    | { table: string; data?: unknown; error?: boolean; throws?: boolean; timeout?: boolean }
    | undefined;
  const factory = () =>
    ({
      rpc,
      from(table: string) {
        const filters: Array<[string, unknown]> = [];
        let fields: string[] = [],
          patch: Row | undefined,
          signal: AbortSignal | undefined;
        const builder = {
          select(value: string) {
            fields = value.split(',').map((x) => x.trim());
            return builder;
          },
          abortSignal(value: AbortSignal) {
            signal = value;
            signals.push(value);
            return builder;
          },
          eq(key: string, value: unknown) {
            filters.push([key, value]);
            return builder;
          },
          async maybeSingle(): Promise<{ data: Row | null; error: unknown }> {
            const value = (await builder) as { data: Row[] | null; error: unknown };
            return { data: value.data?.[0] ?? null, error: value.error };
          },
          upsert,
          update(value: Row) {
            update(value);
            patch = value;
            return builder;
          },
          then(resolve: (value: unknown) => unknown, reject?: (error: unknown) => unknown) {
            const result = async () => {
              if (patch) {
                const matches = stops.filter((row) =>
                  filters.every(([key, value]) => matchesField(row, key, value)),
                );
                for (const row of matches) Object.assign(row, patch);
                return {
                  data: matches.map((row) => ({ scope_key: row['scope_key'] })),
                  error: null,
                };
              }
              reads.push(table);
              if (fault?.table === table) {
                if (fault.throws) throw new Error('private adapter sentinel');
                if (fault.timeout)
                  return new Promise((_resolve, failed) =>
                    signal?.addEventListener(
                      'abort',
                      () => failed(new Error('private timeout sentinel')),
                      { once: true },
                    ),
                  );
                return {
                  data: fault.data,
                  error: fault.error ? { message: 'private connection sentinel' } : null,
                };
              }
              const rows =
                table === 'tenant_users'
                  ? members
                  : table === 'users'
                    ? users
                    : table === 'platform_founders'
                      ? founders
                      : stops;
              return {
                data: rows
                  .filter((row) => filters.every(([key, value]) => matchesField(row, key, value)))
                  .map((row) => Object.fromEntries(fields.map((field) => [field, row[field]]))),
                error: null,
              };
            };
            return result().then(resolve, reject);
          },
        };
        return builder;
      },
    }) as never;
  return {
    members,
    founders,
    users,
    stops,
    upsert,
    update,
    rpc,
    signals,
    reads,
    service: createKillSwitchService(factory),
    fault(value: typeof fault) {
      fault = value;
    },
  };
}
type Fixture = ReturnType<typeof fixture>;
const options = { tenantId, userId, scope: 'global' as const, reason: 'human review' };
async function route(
  f: Fixture,
  path: string,
  scope = 'global',
  role: UserRole = UserRole.FOUNDER,
  context = { tenantId, userId },
) {
  const { v1Routes } = await import('../routes/v1.js');
  const ledger = vi.fn();
  const app = new Hono<{ Variables: Variables }>();
  app.use('*', async (c, next) => {
    c.set('tenantId', context.tenantId as never);
    c.set('role', role);
    c.set('user', { id: context.userId } as never);
    await next();
  });
  app.route(
    '/v1',
    v1Routes({
      approvalEngine: {} as never,
      killSwitch: f.service,
      ledger: { append: ledger } as never,
      mfa: {} as never,
      realtime: {} as never,
    }),
  );
  const response = await app.request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scope, reason: 'human review' }),
  });
  return { response, ledger };
}
const cases: Array<[string, (f: Fixture) => void, number]> = [
  [
    'client initialization unavailable',
    (f) => {
      f.service = createKillSwitchService(() => {
        throw new Error('private client sentinel');
      });
    },
    503,
  ],
  [
    'internal revoked',
    (f) => {
      f.users[0]!['is_axiom_internal'] = false;
    },
    403,
  ],
  [
    'profile absent',
    (f) => {
      f.users.length = 0;
    },
    403,
  ],
  [
    'membership absent',
    (f) => {
      f.members.length = 0;
    },
    403,
  ],
  [
    'role changed',
    (f) => {
      f.members[0]!['role'] = 'owner';
    },
    403,
  ],
  [
    'ambiguous membership',
    (f) => {
      f.members.push({ ...f.members[0] });
    },
    503,
  ],
  [
    'ambiguous profile',
    (f) => {
      f.users.push({ ...f.users[0] });
    },
    503,
  ],
  [
    'malformed profile',
    (f) => {
      f.users[0]!['is_axiom_internal'] = 'true';
    },
    503,
  ],
  [
    'malformed role',
    (f) => {
      f.members[0]!['role'] = 'founder ';
    },
    503,
  ],
  ['null read', (f) => f.fault({ table: 'users', data: null }), 503],
  ['malformed membership response', (f) => f.fault({ table: 'tenant_users', data: {} }), 503],
  [
    'wrong tenant response',
    (f) =>
      f.fault({
        table: 'tenant_users',
        data: [{ tenant_id: userId, user_id: userId, role: 'founder' }],
      }),
    503,
  ],
  [
    'unexpected profile fields',
    (f) =>
      f.fault({
        table: 'users',
        data: [{ id: userId, is_axiom_internal: true, extra: 'private' }],
      }),
    503,
  ],
  [
    'wrong actor response',
    (f) => f.fault({ table: 'users', data: [{ id: tenantId, is_axiom_internal: true }] }),
    503,
  ],
  ['membership read error', (f) => f.fault({ table: 'tenant_users', error: true }), 503],
  ['profile read error', (f) => f.fault({ table: 'users', error: true }), 503],
  ['transport rejection', (f) => f.fault({ table: 'users', throws: true }), 503],
];
beforeEach(() => vi.useRealTimers());
describe('global stop authority at the service boundary', () => {
  it('canonicalizes validated uppercase actor IDs while retaining exact UUID binding', async () => {
    const f = fixture();
    await f.service.engage({
      ...options,
      tenantId: tenantId.toUpperCase(),
      userId: userId.toUpperCase(),
    });
    expect(f.upsert).toHaveBeenCalledOnce();
    expect(f.reads).toEqual(['tenant_users', 'users']);
    const wrong = fixture();
    await expect(
      wrong.service.engage({ ...options, tenantId: userId.toUpperCase() }),
    ).rejects.toMatchObject({ reason: 'forbidden' });
    expect(wrong.upsert).not.toHaveBeenCalled();
  });

  it.each(['tenant_users', 'users'])('canonicalizes valid UUIDs in %s responses', async (table) => {
    const f = fixture();
    f.fault({
      table,
      data:
        table === 'users'
          ? [{ id: userId.toUpperCase(), is_axiom_internal: true }]
          : [{ tenant_id: tenantId.toUpperCase(), user_id: userId.toUpperCase(), role: 'founder' }],
    });
    await f.service.engage(options);
    expect(f.upsert).toHaveBeenCalledOnce();
  });
  it.each(cases)('refuses %s before either mutation', async (_name, change, status) => {
    for (const operation of ['engage', 'release'] as const) {
      const f = fixture();
      change(f);
      await expect(f.service[operation](options)).rejects.toMatchObject({
        reason: status === 403 ? 'forbidden' : 'unavailable',
      });
      expect(f.upsert).not.toHaveBeenCalled();
      expect(f.update).not.toHaveBeenCalled();
      expect(f.rpc).not.toHaveBeenCalled();
    }
  });
  it('requires the named tenant even for a direct global caller', async () => {
    const f = fixture();
    await expect(f.service.engage({ ...options, tenantId: undefined })).rejects.toBeInstanceOf(
      KillSwitchAuthorityRefused,
    );
    expect(f.upsert).not.toHaveBeenCalled();
    expect(f.reads).toEqual([]);
  });
  it.each(['internal', 'membership'])(
    'uses fresh reads after %s revocation',
    async (revocation) => {
      const f = fixture();
      await f.service.engage(options);
      if (revocation === 'internal') f.users[0]!['is_axiom_internal'] = false;
      else f.members[0]!['role'] = 'owner';
      await expect(f.service.release(options)).rejects.toMatchObject({ reason: 'forbidden' });
      expect(f.update).not.toHaveBeenCalled();
      expect(f.signals).toHaveLength(4);
      expect(f.signals[0]).toBe(f.signals[1]);
      expect(f.signals[2]).toBe(f.signals[3]);
      expect(f.reads.slice(-2)).toEqual(
        revocation === 'internal'
          ? ['tenant_users', 'users']
          : ['tenant_users', 'platform_founders'],
      );
      expect(f.signals[2]).not.toBe(f.signals[0]);
    },
  );
  it.each(['tenant_users', 'users'])(
    'bounds a hung %s authority read without writes',
    async (table) => {
      vi.useFakeTimers();
      const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
        const controller = new AbortController();
        setTimeout(() => controller.abort(), ms);
        return controller.signal;
      });
      try {
        const f = fixture();
        f.fault({ table, timeout: true });
        const result = expect(f.service.engage(options)).rejects.toMatchObject({
          reason: 'unavailable',
        });
        await vi.advanceTimersByTimeAsync(10000);
        await result;
        expect(f.upsert).not.toHaveBeenCalled();
        expect(f.update).not.toHaveBeenCalled();
        expect(timeout).toHaveBeenCalledWith(10000);
      } finally {
        timeout.mockRestore();
        vi.useRealTimers();
      }
    },
  );
});
for (const path of ['/v1/kill-switch', '/v1/kill-switch/engage', '/v1/kill-switch/release']) {
  describe(`actual global route ${path}`, () => {
    it.each(cases)(
      'refuses %s without success ledger or mutation',
      async (_name, change, status) => {
        const f = fixture();
        change(f);
        const { response, ledger } = await route(f, path);
        expect(response.status).toBe(status);
        expect(response.headers.get('cache-control')).toBe('private, no-store');
        const body = await response.text();
        expect(body).not.toContain('private');
        expect(JSON.parse(body)).toMatchObject({
          error: {
            code:
              status === 403
                ? 'global_kill_switch_authority_required'
                : 'global_kill_switch_authority_unavailable',
          },
        });
        expect(f.upsert).not.toHaveBeenCalled();
        expect(f.update).not.toHaveBeenCalled();
        expect(ledger).not.toHaveBeenCalled();
      },
    );
    it('permits uppercase authenticated actor/tenant context with canonical DB UUIDs', async () => {
      const f = fixture();
      const { response, ledger } = await route(f, path, 'global', UserRole.FOUNDER, {
        tenantId: tenantId.toUpperCase(),
        userId: userId.toUpperCase(),
      });
      expect(response.status).toBe(200);
      expect(ledger).toHaveBeenCalledOnce();
    });
    it('permits a live founder and appends the exact success event', async () => {
      const f = fixture();
      const { response, ledger } = await route(f, path);
      expect(response.status).toBe(200);
      expect(ledger).toHaveBeenCalledOnce();
      expect(ledger).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId,
          actorId: userId,
          actorType: 'human',
          result: 'success',
          actionType: path.endsWith('/release')
            ? 'execution.kill_switch.released'
            : 'execution.kill_switch.engaged',
        }),
      );
      expect(f.reads).toEqual(['tenant_users', 'users']);
    });
  });
}
it('preserves tenant owner engage/release without consulting founder profile', async () => {
  const f = fixture();
  f.stops.length = 0;
  f.fault({ table: 'users', error: true });
  expect((await route(f, '/v1/kill-switch/engage', 'tenant', UserRole.OWNER)).response.status).toBe(
    200,
  );
  expect(
    (await route(f, '/v1/kill-switch/release', 'tenant', UserRole.OWNER)).response.status,
  ).toBe(200);
  expect(f.reads).toEqual(['kill_switch_state']);
});
it('preserves global halt refusal for tenant owner release', async () => {
  const f = fixture();
  const { response, ledger } = await route(f, '/v1/kill-switch/release', 'tenant', UserRole.OWNER);
  expect(response.status).toBe(409);
  expect(f.update).not.toHaveBeenCalled();
  expect(ledger).not.toHaveBeenCalled();
});

describe('global founder kill switch authority', () => {
  it.each([null, 'viewer'])('accepts live global designation with local role %s', async (role) => {
    const f = fixture();
    f.members.splice(0);
    if (role) f.members.push({ tenant_id: tenantId, user_id: userId, role });
    f.founders.push({ user_id: userId, revoked_at: null });
    await f.service.engage(options);
    expect(f.upsert).toHaveBeenCalledTimes(1);
  });
  it('denies a revoked designation without a separate local founder grant', async () => {
    const f = fixture();
    f.members.splice(0);
    f.founders.push({ user_id: userId, revoked_at: '2026-10-20T00:00:00Z' });
    await expect(f.service.engage(options)).rejects.toMatchObject({ reason: 'forbidden' });
    expect(f.upsert).not.toHaveBeenCalled();
  });
});
