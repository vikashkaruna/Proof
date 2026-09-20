import { createHash, randomUUID } from 'node:crypto';

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

  /**
   * `action_set_content_digest` and `issue_plan_approval` (migration 0026).
   *
   * Modelled rather than stubbed, because what the route tests are about is
   * the behaviour these two produce: that a content change between the
   * step-up and the write is refused, and that the token, the actions, the
   * plan, the challenge link and the ledger entry all appear together or not
   * at all. A stub returning `issued` would make those tests assert nothing.
   */
  const contentDigest = (tenantId: string, planId: string, actionIds: string[]): string => {
    const rows = (tables['remediation_actions'] ?? [])
      .filter(
        (a) =>
          a['tenant_id'] === tenantId &&
          a['plan_id'] === planId &&
          actionIds.includes(a['id'] as string),
      )
      .sort((a, b) => String(a['id']).localeCompare(String(b['id'])))
      .map((a) => ({
        id: a['id'],
        action_type: a['action_type'] ?? null,
        parameters: a['parameters'] ?? null,
        rollback_definition: a['rollback_definition'] ?? null,
        closes_finding_ids: [...((a['closes_finding_ids'] as string[]) ?? [])].sort(),
        dry_run_result: a['dry_run_result'] ?? null,
      }));
    return createHash('sha256').update(JSON.stringify(rows), 'utf8').digest('hex');
  };

  rpcHandlers.set('action_set_content_digest', (args) =>
    contentDigest(
      args['p_tenant_id'] as string,
      args['p_plan_id'] as string,
      (args['p_action_ids'] as string[]) ?? [],
    ),
  );

  rpcHandlers.set('issue_plan_approval', (args) => {
    const tenantId = args['p_tenant_id'] as string;
    const planId = args['p_plan_id'] as string;
    const actionIds = (args['p_action_ids'] as string[]) ?? [];
    const approverId = args['p_approver_id'] as string;

    if (actionIds.length === 0 || new Set(actionIds).size !== actionIds.length) {
      return { decision: 'invalid_actions' };
    }
    const plan = (tables['remediation_plans'] ?? []).find(
      (r) => r['id'] === planId && r['tenant_id'] === tenantId,
    );
    if (!plan) return { decision: 'plan_not_found' };

    const actions = (tables['remediation_actions'] ?? []).filter(
      (a) =>
        a['tenant_id'] === tenantId &&
        a['plan_id'] === planId &&
        actionIds.includes(a['id'] as string),
    );
    if (actions.length !== actionIds.length) return { decision: 'actions_not_found' };
    if (
      actions.some((a) =>
        ['executing', 'succeeded', 'failed', 'rolled_back'].includes(
          String(a['execution_status'] ?? ''),
        ),
      )
    ) {
      return { decision: 'actions_in_flight' };
    }
    if (
      actions.some(
        (a) => a['dry_run_status'] !== 'dry_run_complete' || a['rollback_validated'] !== true,
      )
    ) {
      return { decision: 'actions_not_ready' };
    }

    // Recomputed here, as the real function recomputes it under row locks.
    if (contentDigest(tenantId, planId, actionIds) !== args['p_expected_digest']) {
      return { decision: 'content_changed' };
    }

    const tokenId = randomUUID();
    table('approval_tokens').push({
      id: tokenId,
      tenant_id: tenantId,
      plan_id: planId,
      action_ids: actionIds,
      approver_id: approverId,
      mode: args['p_mode'],
      concurrency: args['p_concurrency'],
      stop_on_failure: args['p_stop_on_failure'],
      signature: args['p_signature'],
      signed_payload: args['p_signed_payload'],
      nonce: args['p_nonce'],
      expires_at: args['p_expires_at'],
      reason: args['p_reason'] ?? null,
      conditions: args['p_conditions'] ?? {},
      status: 'issued',
    });

    const challengeId = args['p_challenge_id'] as string | null;
    if (challengeId) {
      const challenge = (tables['mfa_challenges'] ?? []).find((r) => r['id'] === challengeId);
      if (challenge) challenge['consumed_for'] = tokenId;
    }

    for (const action of actions) {
      action['approval_status'] = 'approved';
      action['approval_token_id'] = tokenId;
      action['approved_by'] = approverId;
      action['approved_at'] = new Date().toISOString();
    }
    plan['status'] = 'approved';

    // Written in the same call, because that is the property 0026 adds.
    table('audit_ledger').push({
      tenant_id: tenantId,
      correlation_id: args['p_correlation_id'],
      actor_type: 'human',
      actor_id: approverId,
      action_type: 'approval.token.issued',
      target_ref: planId,
      approval_token_id: tokenId,
      approver_id: approverId,
      result: 'success',
      detail: {
        actionIds,
        mode: args['p_mode'],
        expiresAt: args['p_expires_at'],
        contentDigest: args['p_expected_digest'],
        mfaChallengeId: challengeId,
        ...((args['p_mfa_detail'] as Record<string, unknown>) ?? {}),
      },
    });

    return {
      decision: 'issued',
      token_id: tokenId,
      expires_at: args['p_expires_at'],
      content_digest: args['p_expected_digest'],
    };
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
