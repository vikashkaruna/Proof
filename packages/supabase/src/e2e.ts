import type { SupabaseClient, User } from '@supabase/supabase-js';

const E2E_USER: User = {
  id: '00000000-0000-0000-0000-000000000001',
  aud: 'authenticated',
  role: 'authenticated',
  email: 'founder@axiomminds.ai',
  email_confirmed_at: '2026-01-01T00:00:00.000Z',
  phone: '',
  confirmed_at: '2026-01-01T00:00:00.000Z',
  last_sign_in_at: '2026-01-01T00:00:00.000Z',
  app_metadata: { provider: 'email', providers: ['email'] },
  user_metadata: { full_name: 'Founder' },
  identities: [],
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
};

const E2E_PLAN = {
  id: '00000000-0000-0000-0000-000000000001',
  title: 'E2E remediation plan',
  description: 'A deterministic plan fixture for browser tests.',
  status: 'draft',
  version: 1,
  library_version: '0.1.0',
  created_at: '2026-01-01T00:00:00.000Z',
  tenant_id: '00000000-0000-0000-0000-000000000002',
  engagement_id: '00000000-0000-0000-0000-000000000003',
  aggregate_blast_radius: { recordsAffected: 120, systemsAffected: ['postgres'] },
  remediation_actions: [
    {
      id: '00000000-0000-0000-0000-000000000010',
      sequence: 1,
      action_type: 'data.retention_purge',
      description: 'Purge telemetry logs older than 180 days per retention policy',
      risk_class: 'medium',
      risk_score: 35,
      closes_finding_ids: ['00000000-0000-0000-0000-000000000020'],
      dry_run_status: 'dry_run_complete',
      dry_run_completed_at: '2026-01-01T00:00:00.000Z',
      dry_run_expires_at: '2026-01-02T00:00:00.000Z',
      dry_run_result: { simulatedAffectedRows: 120 },
      rollback_validated: true,
      rollback_definition: { estimatedRollbackTimeSeconds: 15 },
      approval_status: 'approved',
      approved_at: '2026-01-01T00:00:00.000Z',
      blast_radius: { recordsAffected: 120, systemsAffected: ['postgres'], environment: 'staging' },
    },
  ],
  tenants: { id: '00000000-0000-0000-0000-000000000002', name: 'E2E tenant', slug: 'e2e' },
};

const E2E_USER_PROFILE = {
  id: '00000000-0000-0000-0000-000000000001',
  email: 'founder@axiomminds.ai',
  full_name: 'Founder',
  is_axiom_internal: true,
};

const E2E_TENANT = {
  id: '00000000-0000-0000-0000-000000000001',
  name: 'Demo Client (Acme Fintech Pvt Ltd)',
  slug: 'demo-client',
  tier: 'growth',
  is_sdf: false,
};

const E2E_LEDGER_ENTRY = {
  id: '1',
  sequence_no: 1,
  actor_type: 'agent',
  actor_id: 'drishti',
  action_type: 'discovery.started',
  result: 'success',
  target_ref: '00000000-0000-0000-0000-000000000001',
  detail: { summary: 'Initial system discovery completed' },
  entry_hash: '6fae688e4b150dbbaa49eaf57359a53879fd6be0893a74a8f7700461cc9a206b',
  prev_entry_hash: null,
  occurred_at: '2026-09-11T19:13:30.546Z',
};

type QueryResult = {
  data: unknown[];
  error: null;
  count: number;
};

type QueryBuilder = {
  select: (...args: unknown[]) => QueryBuilder;
  order: (...args: unknown[]) => QueryBuilder;
  limit: (...args: unknown[]) => QueryBuilder;
  eq: (...args: unknown[]) => QueryBuilder;
  in: (...args: unknown[]) => QueryBuilder;
  insert: (...args: unknown[]) => QueryBuilder;
  upsert: (...args: unknown[]) => QueryBuilder;
  update: (...args: unknown[]) => QueryBuilder;
  delete: (...args: unknown[]) => QueryBuilder;
  single: () => Promise<{ data: unknown; error: null }>;
  maybeSingle: () => Promise<{ data: unknown; error: null }>;
  then: Promise<QueryResult>['then'];
};

const e2eInMemoryTableStore = new Map<string, Map<string, Record<string, unknown>>>();

function getTableStore(table: string): Map<string, Record<string, unknown>> {
  let store = e2eInMemoryTableStore.get(table);
  if (!store) {
    store = new Map();
    e2eInMemoryTableStore.set(table, store);
  }
  return store;
}

function createQuery(table: string): QueryBuilder {
  let mutatedData: unknown = null;
  const filters: Array<{ field: string; value: unknown }> = [];

  const defaultRows =
    table === 'users'
      ? [E2E_USER_PROFILE]
      : table === 'remediation_plans'
        ? [E2E_PLAN]
        : table === 'tenants'
          ? [E2E_TENANT]
          : table === 'audit_ledger'
            ? [E2E_LEDGER_ENTRY]
            : [];

  const defaultSingle =
    table === 'users'
      ? E2E_USER_PROFILE
      : table === 'remediation_plans'
        ? E2E_PLAN
        : table === 'tenants'
          ? E2E_TENANT
          : table === 'audit_ledger'
            ? E2E_LEDGER_ENTRY
            : null;

  const query = {} as QueryBuilder;
  query.select = () => query;
  query.order = () => query;
  query.limit = () => query;
  query.eq = (field: unknown, value: unknown) => {
    if (typeof field === 'string') {
      filters.push({ field, value });
    }
    return query;
  };
  query.in = () => query;
  query.insert = (values: unknown) => {
    const arr = Array.isArray(values) ? values : [values];
    const store = getTableStore(table);
    for (const v of arr) {
      if (v && typeof v === 'object') {
        const rec = v as Record<string, unknown>;
        const id = (rec.id as string) || '00000000-0000-0000-0000-000000000001';
        store.set(id, rec);
        mutatedData = rec;
      }
    }
    return query;
  };
  query.upsert = (values: unknown) => {
    const arr = Array.isArray(values) ? values : [values];
    const store = getTableStore(table);
    for (const v of arr) {
      if (v && typeof v === 'object') {
        const rec = v as Record<string, unknown>;
        const id = (rec.id as string) || '00000000-0000-0000-0000-000000000001';
        store.set(id, rec);
        mutatedData = rec;
      }
    }
    return query;
  };
  query.update = (values: unknown) => {
    mutatedData = values;
    return query;
  };
  query.delete = () => query;
  query.single = async () => {
    if (mutatedData && typeof mutatedData === 'object') {
      return {
        data: {
          id: '00000000-0000-0000-0000-000000000001',
          ...(mutatedData as Record<string, unknown>),
        },
        error: null,
      };
    }
    const store = getTableStore(table);
    if (store.size > 0) {
      for (const item of store.values()) {
        const matches = filters.every((f) => item[f.field] === f.value);
        if (matches) {
          return { data: item, error: null };
        }
      }
    }
    if (defaultSingle) {
      return { data: defaultSingle, error: null };
    }
    return { data: null, error: { message: 'Row not found', code: 'PGRST116' } as unknown as null };
  };
  query.maybeSingle = async () => {
    if (mutatedData && typeof mutatedData === 'object') {
      return {
        data: {
          id: '00000000-0000-0000-0000-000000000001',
          ...(mutatedData as Record<string, unknown>),
        },
        error: null,
      };
    }
    const store = getTableStore(table);
    if (store.size > 0) {
      for (const item of store.values()) {
        const matches = filters.every((f) => item[f.field] === f.value);
        if (matches) {
          return { data: item, error: null };
        }
      }
    }
    return { data: defaultSingle, error: null };
  };

  const storeItems = Array.from(getTableStore(table).values());
  const allData = storeItems.length > 0 ? storeItems : defaultRows;
  const filteredData =
    filters.length > 0
      ? allData.filter((item) =>
          filters.every((f) => (item as Record<string, unknown>)[f.field] === f.value),
        )
      : allData;

  const result: QueryResult = {
    data: filteredData,
    error: null,
    count: filteredData.length,
  };

  query.then = Promise.resolve(result).then.bind(Promise.resolve(result));
  return query;
}

/**
 * @deprecated W0.0 — superseded by `isAuthBypassEnabled()` from `@axiom/config`.
 *
 * This guard was itself written correctly: it required NODE_ENV=test, or local
 * plus an explicit flag. It was defeated by `admin.ts` ORing it together with
 * `ENVIRONMENT === 'preprod'` and two SUPABASE_URL substring checks (SEC-13).
 *
 * Kept as a re-export so there is exactly one answer to "is the bypass on?",
 * and that answer is refused at boot outside local/test.
 */
export { isAuthBypassEnabled as isE2EBypassEnabled } from '@axiom/config';

/**
 * A deterministic, resilient Supabase facade for browser tests and standalone preprod/staging setups.
 */
export function createE2ESupabaseClient(customEmail?: string): SupabaseClient {
  const email = customEmail || E2E_USER.email;
  const currentUser: User = {
    ...E2E_USER,
    email,
  };

  return {
    auth: {
      getUser: async () => ({ data: { user: currentUser }, error: null }),
      getSession: async () => ({
        data: {
          session: {
            access_token: 'test-access-token',
            refresh_token: 'test-refresh-token',
            user: currentUser,
          },
        },
        error: null,
      }),
      signOut: async () => ({ error: null }),
      signInWithPassword: async () => ({
        data: {
          user: currentUser,
          session: {
            access_token: 'test-access-token',
            refresh_token: 'test-refresh-token',
            user: currentUser,
          },
        },
        error: null,
      }),
      signUp: async () => ({
        data: {
          user: currentUser,
          session: {
            access_token: 'test-access-token',
            refresh_token: 'test-refresh-token',
            user: currentUser,
          },
        },
        error: null,
      }),
      onAuthStateChange: () => ({
        data: {
          subscription: {
            id: 'mock-sub',
            callback: () => {},
            unsubscribe: () => {},
          },
        },
      }),
      resetPasswordForEmail: async () => ({ data: {}, error: null }),
      updateUser: async (attrs: Record<string, unknown>) => ({
        data: { user: { ...currentUser, ...attrs } },
        error: null,
      }),
    },
    from: (table: string) => createQuery(table),
    rpc: async (_fn: string, _args?: unknown) => ({ data: [], error: null }),
  } as unknown as SupabaseClient;
}
