import { randomUUID } from 'node:crypto';

/**
 * A small in-memory stand-in for the PostgREST query builder.
 *
 * The MFA service's security properties are almost all *conditional writes* —
 * "update this row only if it is still unconsumed", "claim this counter only
 * if nothing later has claimed it". Those are exactly the behaviours a mock
 * that just records calls cannot check, and exactly the ones that matter: each
 * one is the difference between a defence and a comment claiming a defence.
 *
 * So this double actually stores rows, actually applies the filters, and
 * actually returns the affected rows — which lets a test race two callers
 * against one challenge and assert that precisely one wins.
 */

type Row = Record<string, unknown>;
type Filter = (row: Row) => boolean;

function parseOrClause(clause: string): Filter {
  // `col.is.null,col.lt.123` — the subset the service uses.
  const terms = clause.split(',').map((term) => {
    const [column, op, rawValue] = term.split('.');
    if (!column || !op) throw new Error(`fake-postgrest: unparseable or() term "${term}"`);
    if (op === 'is' && rawValue === 'null') return (row: Row) => row[column] == null;
    if (op === 'lt') {
      const value = Number(rawValue);
      return (row: Row) => row[column] != null && Number(row[column]) < value;
    }
    throw new Error(`fake-postgrest: unsupported or() term "${term}"`);
  });
  return (row) => terms.some((t) => t(row));
}

export interface FakeDb {
  client: { from(table: string): unknown; rpc(fn: string, args: Record<string, unknown>): unknown };
  /** Install a handler for a Postgres function the code calls via `.rpc()`. */
  onRpc(fn: string, handler: (args: Record<string, unknown>) => unknown): void;
  /** Force the next `.rpc()` call for this function to fail. */
  failNextRpc(fn: string): void;
  rows(table: string): Row[];
  seed(table: string, row: Row): Row;
  /** Force the next read on a table to fail, as an unreachable database would. */
  failNext(table: string): void;
}

export function createFakeDb(initial: Record<string, Row[]> = {}): FakeDb {
  const tables: Record<string, Row[]> = {};
  for (const [name, rows] of Object.entries(initial)) tables[name] = rows.map((r) => ({ ...r }));
  const failing = new Set<string>();
  const rpcHandlers = new Map<string, (args: Record<string, unknown>) => unknown>();
  const failingRpc = new Set<string>();

  /**
   * A fixed-window counter standing in for `take_rate_limit` (migration 0018).
   * Real enough to exhaust: the MFA budgets are only meaningful if a test can
   * spend them.
   */
  const buckets = new Map<string, number>();
  rpcHandlers.set('take_rate_limit', (args) => {
    const key = `${args.p_bucket}:${args.p_subject}`;
    const limit = Number(args.p_limit);
    const used = (buckets.get(key) ?? 0) + 1;
    buckets.set(key, used);
    return { allowed: used <= limit, retry_after: Number(args.p_window_seconds) };
  });

  function table(name: string): Row[] {
    tables[name] ??= [];
    return tables[name];
  }

  function from(name: string) {
    const filters: Filter[] = [];
    let mode: 'select' | 'insert' | 'update' | 'delete' = 'select';
    let payload: Row | Row[] | null = null;
    let returning = false;
    let settled: { data: unknown; error: { message: string } | null } | null = null;

    const matched = () => table(name).filter((row) => filters.every((f) => f(row)));

    function run(): { data: unknown; error: { message: string } | null } {
      if (settled) return settled;

      if (failing.has(name)) {
        failing.delete(name);
        settled = { data: null, error: { message: 'connection lost' } };
        return settled;
      }

      let data: unknown = null;
      if (mode === 'insert') {
        const incoming = Array.isArray(payload) ? payload : [payload as Row];
        const created = incoming.map((row) => ({
          id: randomUUID(),
          created_at: new Date().toISOString(),
          attempts: 0,
          max_attempts: 5,
          ...row,
        }));
        table(name).push(...created);
        data = returning ? created : null;
      } else if (mode === 'update') {
        const hits = matched();
        for (const row of hits) Object.assign(row, payload as Row);
        data = returning ? hits.map((r) => ({ ...r })) : null;
      } else if (mode === 'delete') {
        const hits = new Set(matched());
        tables[name] = table(name).filter((row) => !hits.has(row));
        data = returning ? [...hits] : null;
      } else {
        data = matched().map((r) => ({ ...r }));
      }

      settled = { data, error: null };
      return settled;
    }

    const builder: Record<string, unknown> = {};

    builder.select = () => {
      returning = true;
      return builder;
    };
    builder.insert = (rows: Row | Row[]) => {
      mode = 'insert';
      payload = rows;
      return builder;
    };
    builder.update = (patch: Row) => {
      mode = 'update';
      payload = patch;
      return builder;
    };
    builder.delete = () => {
      mode = 'delete';
      return builder;
    };

    const where = (predicate: Filter) => {
      filters.push(predicate);
      return builder;
    };

    builder.eq = (column: string, value: unknown) => where((row) => row[column] === value);
    builder.neq = (column: string, value: unknown) => where((row) => row[column] !== value);
    builder.is = (column: string, value: unknown) =>
      where((row) => (value === null ? row[column] == null : row[column] === value));
    builder.in = (column: string, values: unknown[]) =>
      where((row) => values.includes(row[column]));
    builder.or = (clause: string) => where(parseOrClause(clause));

    builder.single = async () => {
      const result = run();
      if (result.error) return result;
      const rows = (result.data as Row[]) ?? [];
      if (rows.length !== 1) return { data: null, error: { message: 'no rows' } };
      return { data: rows[0], error: null };
    };
    builder.maybeSingle = async () => {
      const result = run();
      if (result.error) return result;
      const rows = (result.data as Row[]) ?? [];
      return { data: rows[0] ?? null, error: null };
    };

    // Awaiting the builder directly is how PostgREST resolves a filtered read
    // or a write with no `.select()`.
    builder.then = (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
      Promise.resolve(run()).then(resolve, reject);

    return builder;
  }

  async function rpc(fn: string, args: Record<string, unknown>) {
    if (failingRpc.has(fn)) {
      failingRpc.delete(fn);
      return { data: null, error: { message: `rpc ${fn} unavailable` } };
    }
    const handler = rpcHandlers.get(fn);
    if (!handler) throw new Error(`fake-postgrest: no handler for rpc "${fn}"`);
    return { data: handler(args), error: null };
  }

  return {
    client: { from, rpc },
    onRpc: (fn, handler) => rpcHandlers.set(fn, handler),
    failNextRpc: (fn) => failingRpc.add(fn),
    rows: (name) => table(name),
    seed: (name, row) => {
      const created = { id: randomUUID(), created_at: new Date().toISOString(), ...row };
      table(name).push(created);
      return created;
    },
    failNext: (name) => failing.add(name),
  };
}
