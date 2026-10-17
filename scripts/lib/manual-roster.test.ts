import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  RosterPlanSchema,
  RosterRefused,
  applyRoster,
  checkRoster,
  type RosterApi,
} from './manual-roster.js';

const FOUNDER = '00000000-0000-4000-8000-000000000001';
const TENANT = '00000000-0000-4000-8000-0000000000aa';
const CREATED = '00000000-0000-4000-8000-0000000000c1';

function fake(seed: {
  auth: Record<string, string>;
  profiles: Record<string, string>;
  tenants?: string[];
}) {
  const writes: string[] = [];
  const api: RosterApi = {
    authUser: async (id) => (id in seed.auth ? { id, email: seed.auth[id]! } : null),
    profileByEmail: async (e) =>
      Object.entries(seed.profiles)
        .filter(([, v]) => v === e)
        .map(([id, email]) => ({ id, email })),
    authUserByEmail: async (e) => {
      const hit = Object.entries(seed.auth).find(([, v]) => v === e);
      return hit ? { id: hit[0] } : null;
    },
    tenantExists: async (id) => (seed.tenants ?? [TENANT]).includes(id),
    setAuthEmail: async (id, e) => {
      writes.push(`auth ${id} ${e}`);
      seed.auth[id] = e;
    },
    setProfileEmail: async (id, e) => {
      writes.push(`profile ${id} ${e}`);
      seed.profiles[id] = e;
    },
    createAuthUser: async (e) => {
      writes.push(`create ${e}`);
      seed.auth[CREATED] = e;
      return CREATED;
    },
    createProfile: async (id, e) => {
      writes.push(`createProfile ${e}`);
      seed.profiles[id] = e;
    },
    createMembership: async (m) => {
      writes.push(`member ${m.tenantId} ${m.role} ${m.approvalScopes.join('|')}`);
    },
  };
  return { api, writes };
}

const plan = RosterPlanSchema.parse({
  renames: [
    {
      userId: FOUNDER,
      from: 'persona-founder-x@example.invalid',
      to: 'founder-test@example.invalid',
    },
  ],
  creates: [
    {
      email: 'scoped-approver-test@example.invalid',
      memberships: [
        { tenantId: TENANT, role: 'approver', approvalScopes: ['identity.deprovision'] },
      ],
    },
  ],
});

const original = (): { auth: Record<string, string>; profiles: Record<string, string> } => ({
  auth: { [FOUNDER]: 'persona-founder-x@example.invalid' },
  profiles: { [FOUNDER]: 'persona-founder-x@example.invalid' },
});

describe('manual roster', () => {
  it('dry run checks everything and writes nothing', async () => {
    const { api, writes } = fake(original());
    const audit = await checkRoster(plan, api);
    assert.deepEqual(
      audit.map((a) => a.status),
      ['planned', 'planned'],
    );
    assert.deepEqual(writes, []);
  });

  it('renames in place, preserving the UUID, and creates without MFA', async () => {
    const { api, writes } = fake(original());
    const { audit, credentials } = await applyRoster(plan, api, () => 'generated-secret');
    assert.deepEqual(writes, [
      `auth ${FOUNDER} founder-test@example.invalid`,
      `profile ${FOUNDER} founder-test@example.invalid`,
      'create scoped-approver-test@example.invalid',
      'createProfile scoped-approver-test@example.invalid',
      `member ${TENANT} approver identity.deprovision`,
    ]);
    assert.equal(audit[0]!.userId, FOUNDER);
    assert.equal(audit[0]!.status, 'applied');
    assert.deepEqual(credentials, [
      {
        userId: CREATED,
        email: 'scoped-approver-test@example.invalid',
        password: 'generated-secret',
        mfa: 'none',
      },
    ]);
    assert.ok(!JSON.stringify(audit).includes('generated-secret'), 'audit holds no secret');
  });

  it('is idempotent for an already applied rename', async () => {
    const { api, writes } = fake({
      auth: { [FOUNDER]: 'founder-test@example.invalid' },
      profiles: { [FOUNDER]: 'founder-test@example.invalid' },
    });
    const audit = await checkRoster({ renames: plan.renames, creates: [] }, api);
    assert.equal(audit[0]!.status, 'already_applied');
    assert.deepEqual(writes, []);
  });

  it('refuses the whole plan before writing when the source email differs', async () => {
    const { api, writes } = fake({
      auth: { [FOUNDER]: 'someone-else@example.invalid' },
      profiles: { [FOUNDER]: 'persona-founder-x@example.invalid' },
    });
    await assert.rejects(applyRoster(plan, api), RosterRefused);
    assert.deepEqual(writes, []);
  });

  it('refuses the whole plan before writing when the target is taken', async () => {
    const seed = original();
    seed.auth['00000000-0000-4000-8000-0000000000dd'] = 'founder-test@example.invalid';
    const { api, writes } = fake(seed);
    await assert.rejects(applyRoster(plan, api), /already in use/);
    assert.deepEqual(writes, []);
  });

  it('refuses an analyst role on an external account and an unknown tenant', async () => {
    const { api } = fake({ auth: {}, profiles: {} });
    await assert.rejects(
      checkRoster(
        RosterPlanSchema.parse({
          creates: [
            {
              email: 'a@example.invalid',
              memberships: [{ tenantId: TENANT, role: 'axiom_analyst' }],
            },
          ],
        }),
        api,
      ),
      /requires an internal account/,
    );
    await assert.rejects(
      checkRoster(
        RosterPlanSchema.parse({
          creates: [
            {
              email: 'a@example.invalid',
              memberships: [{ tenantId: '00000000-0000-4000-8000-0000000000ff', role: 'viewer' }],
            },
          ],
        }),
        api,
      ),
      /does not exist/,
    );
  });

  it('never accepts founder or partner roles for a created account', () => {
    assert.throws(() =>
      RosterPlanSchema.parse({
        creates: [
          { email: 'a@example.invalid', memberships: [{ tenantId: TENANT, role: 'founder' }] },
        ],
      }),
    );
  });
});
