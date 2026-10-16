/**
 * Audited manual-test roster changes (e448): rename an existing identity in
 * place, or create a clean manual identity. Never reseeds, never resets a
 * password or factor, never touches memberships of a renamed account.
 *
 * A rename preserves the UUID — and with it factors, password, memberships,
 * approvals, evidence and ledger history — and changes only the email in
 * GoTrue and the mirrored profile. Every step checks exact preconditions first
 * and refuses rather than guessing; the default is a dry run.
 */
import { randomBytes } from 'node:crypto';
import { z } from 'zod';

const uuid = z.uuid();
const email = z.email().transform((e) => e.toLowerCase());

export const RosterPlanSchema = z
  .object({
    renames: z.array(z.object({ userId: uuid, from: email, to: email }).strict()).default([]),
    creates: z
      .array(
        z
          .object({
            email,
            fullName: z.string().min(1).max(200).optional(),
            internal: z.boolean().default(false),
            memberships: z
              .array(
                z
                  .object({
                    tenantId: uuid,
                    role: z.enum([
                      'owner',
                      'admin',
                      'approver',
                      'reviewer',
                      'viewer',
                      'axiom_analyst',
                    ]),
                    approvalScopes: z.array(z.string().min(1)).default([]),
                  })
                  .strict(),
              )
              .min(1),
          })
          .strict(),
      )
      .default([]),
  })
  .strict()
  .superRefine((plan, ctx) => {
    const targets = [...plan.renames.map((r) => r.to), ...plan.creates.map((c) => c.email)];
    if (new Set(targets).size !== targets.length)
      ctx.addIssue({ code: 'custom', message: 'A target email appears twice in the plan' });
  });
export type RosterPlan = z.infer<typeof RosterPlanSchema>;

export interface RosterApi {
  authUser(id: string): Promise<{ id: string; email: string | null } | null>;
  profileByEmail(email: string): Promise<Array<{ id: string; email: string }>>;
  authUserByEmail(email: string): Promise<{ id: string } | null>;
  tenantExists(id: string): Promise<boolean>;
  setAuthEmail(id: string, email: string): Promise<void>;
  setProfileEmail(id: string, email: string): Promise<void>;
  createAuthUser(email: string, password: string): Promise<string>;
  createProfile(
    id: string,
    email: string,
    fullName: string | null,
    internal: boolean,
  ): Promise<void>;
  createMembership(m: {
    tenantId: string;
    userId: string;
    role: string;
    approvalScopes: string[];
  }): Promise<void>;
}

export interface AuditEntry {
  action: 'rename' | 'create';
  userId: string;
  from?: string;
  to?: string;
  email?: string;
  memberships?: Array<{ tenantId: string; role: string; approvalScopes: string[] }>;
  status: 'planned' | 'applied' | 'already_applied';
}

export interface Credential {
  userId: string;
  email: string;
  password: string;
  mfa: 'none';
}

export class RosterRefused extends Error {}

/** Check every precondition for the whole plan before any write. */
export async function checkRoster(plan: RosterPlan, api: RosterApi): Promise<AuditEntry[]> {
  const entries: AuditEntry[] = [];
  for (const r of plan.renames) {
    const user = await api.authUser(r.userId);
    if (!user) throw new RosterRefused(`rename ${r.userId}: no such Auth user`);
    const current = user.email?.toLowerCase() ?? null;
    if (current === r.to) {
      const profiles = await api.profileByEmail(r.to);
      if (profiles.length !== 1 || profiles[0]!.id !== r.userId)
        throw new RosterRefused(`rename ${r.userId}: Auth already renamed but profile disagrees`);
      entries.push({
        action: 'rename',
        userId: r.userId,
        from: r.from,
        to: r.to,
        status: 'already_applied',
      });
      continue;
    }
    if (current !== r.from)
      throw new RosterRefused(`rename ${r.userId}: Auth email is not the expected source email`);
    const fromProfiles = await api.profileByEmail(r.from);
    if (fromProfiles.length !== 1 || fromProfiles[0]!.id !== r.userId)
      throw new RosterRefused(`rename ${r.userId}: profile does not match the exact user`);
    if ((await api.authUserByEmail(r.to)) || (await api.profileByEmail(r.to)).length > 0)
      throw new RosterRefused(`rename ${r.userId}: target email is already in use`);
    entries.push({ action: 'rename', userId: r.userId, from: r.from, to: r.to, status: 'planned' });
  }
  for (const c of plan.creates) {
    if ((await api.authUserByEmail(c.email)) || (await api.profileByEmail(c.email)).length > 0)
      throw new RosterRefused(`create ${c.email}: email is already in use`);
    for (const m of c.memberships) {
      if (!(await api.tenantExists(m.tenantId)))
        throw new RosterRefused(`create ${c.email}: tenant ${m.tenantId} does not exist`);
      if (m.role === 'axiom_analyst' && !c.internal)
        throw new RosterRefused(`create ${c.email}: axiom_analyst requires an internal account`);
    }
    entries.push({
      action: 'create',
      userId: '(assigned on apply)',
      email: c.email,
      memberships: c.memberships,
      status: 'planned',
    });
  }
  return entries;
}

export async function applyRoster(
  plan: RosterPlan,
  api: RosterApi,
  password: () => string = () => randomBytes(18).toString('base64url'),
): Promise<{ audit: AuditEntry[]; credentials: Credential[] }> {
  const audit = await checkRoster(plan, api);
  const credentials: Credential[] = [];
  for (const entry of audit) {
    if (entry.action === 'rename' && entry.status === 'planned') {
      await api.setAuthEmail(entry.userId, entry.to!);
      await api.setProfileEmail(entry.userId, entry.to!);
      const after = await api.authUser(entry.userId);
      if (after?.email?.toLowerCase() !== entry.to)
        throw new RosterRefused(`rename ${entry.userId}: Auth readback disagrees after write`);
      entry.status = 'applied';
    } else if (entry.action === 'create') {
      const spec = plan.creates.find((c) => c.email === entry.email)!;
      const secret = password();
      const id = await api.createAuthUser(spec.email, secret);
      await api.createProfile(id, spec.email, spec.fullName ?? null, spec.internal);
      for (const m of spec.memberships) await api.createMembership({ ...m, userId: id });
      entry.userId = id;
      entry.status = 'applied';
      credentials.push({ userId: id, email: spec.email, password: secret, mfa: 'none' });
    }
  }
  return { audit, credentials };
}

/** GoTrue admin + PostgREST, with the service role. Never logs secrets. */
export function restRosterApi(
  baseUrl: string,
  serviceKey: string,
  f: typeof fetch = fetch,
): RosterApi {
  const call = async (path: string, init: RequestInit = {}, ok = [200]) => {
    const res = await f(`${baseUrl}${path}`, {
      ...init,
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        'content-type': 'application/json',
        Prefer: 'return=representation',
        ...(init.headers ?? {}),
      },
    });
    if (!ok.includes(res.status))
      throw new RosterRefused(`${init.method ?? 'GET'} ${path.split('?')[0]}: HTTP ${res.status}`);
    return res;
  };
  return {
    async authUser(id) {
      const res = await f(`${baseUrl}/auth/v1/admin/users/${id}`, {
        headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
        signal: AbortSignal.timeout(30_000),
      });
      if (res.status === 404) return null;
      if (!res.ok) throw new RosterRefused(`GET Auth user: HTTP ${res.status}`);
      const body = (await res.json()) as { id: string; email?: string | null };
      return { id: body.id, email: body.email ?? null };
    },
    async profileByEmail(e) {
      const res = await call(`/rest/v1/users?select=id,email&email=ilike.${encodeURIComponent(e)}`);
      return (await res.json()) as Array<{ id: string; email: string }>;
    },
    async authUserByEmail(e) {
      // GoTrue's admin list has no exact-email filter; page through it.
      for (let page = 1; page <= 50; page++) {
        const res = await call(`/auth/v1/admin/users?page=${page}&per_page=200`);
        const body = (await res.json()) as { users: Array<{ id: string; email?: string }> };
        const hit = body.users.find((u) => u.email?.toLowerCase() === e);
        if (hit) return { id: hit.id };
        if (body.users.length < 200) return null;
      }
      throw new RosterRefused('Auth user listing did not terminate');
    },
    async tenantExists(id) {
      const res = await call(`/rest/v1/tenants?select=id&id=eq.${id}`);
      return ((await res.json()) as unknown[]).length === 1;
    },
    async setAuthEmail(id, e) {
      await call(`/auth/v1/admin/users/${id}`, {
        method: 'PUT',
        body: JSON.stringify({ email: e, email_confirm: true }),
      });
    },
    async setProfileEmail(id, e) {
      const res = await call(`/rest/v1/users?id=eq.${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ email: e }),
      });
      if (((await res.json()) as unknown[]).length !== 1)
        throw new RosterRefused(`profile ${id}: update matched no row`);
    },
    async createAuthUser(e, pw) {
      const res = await call('/auth/v1/admin/users', {
        method: 'POST',
        body: JSON.stringify({ email: e, password: pw, email_confirm: true }),
      });
      return ((await res.json()) as { id: string }).id;
    },
    async createProfile(id, e, fullName, internal) {
      await call(
        '/rest/v1/users',
        {
          method: 'POST',
          body: JSON.stringify({ id, email: e, full_name: fullName, is_axiom_internal: internal }),
        },
        [201],
      );
    },
    async createMembership(m) {
      await call(
        '/rest/v1/tenant_users',
        {
          method: 'POST',
          body: JSON.stringify({
            tenant_id: m.tenantId,
            user_id: m.userId,
            role: m.role,
            approval_scopes: m.approvalScopes,
            accepted_at: new Date().toISOString(),
          }),
        },
        [201],
      );
    },
  };
}
