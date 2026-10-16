import test from 'node:test';
import assert from 'node:assert/strict';
import { localAssessmentUiFixture } from './local-assessment-ui-fixture.js';
const tenant = 'aaaaaaaa-1111-4111-8111-111111111111';
function evidence() {
  return {
    environment: 'local',
    authMode: 'strict',
    deployed: false,
    application: {
      url: 'http://127.0.0.1:56321',
      anonKey: 'synthetic-anon',
      serviceKey: 'synthetic-service',
    },
    parity: {
      apiOrigin: 'http://127.0.0.1:56321',
      databaseId: 'a'.repeat(64),
      status: {
        API_URL: 'http://127.0.0.1:56321',
        ANON_KEY: 'synthetic-anon',
        SERVICE_ROLE_KEY: 'synthetic-service',
      },
    },
    persona: {
      supabaseUrl: 'http://127.0.0.1:56321',
      anonKey: 'synthetic-anon',
      serviceKey: 'synthetic-service',
      tenantA: { id: tenant, slug: 'synthetic-a', name: 'Synthetic A' },
    },
  };
}
test('metadata is scoped to exact synthetic tenant and actual dispatch always refuses', async () => {
  const { producer } = localAssessmentUiFixture(evidence());
  assert.equal(producer.configurationForTenant?.(tenant), true);
  assert.equal(producer.configurationForTenant?.('bbbbbbbb-2222-4222-8222-222222222222'), false);
  await assert.rejects(
    producer.request(tenant, tenant, {
      operationKey: tenant,
      engagementId: tenant,
      answers: {},
      applicability: { sdfSelfAttested: null, processesChildren: null, processesHealth: null },
    }),
    /refuses real dispatch/,
  );
});
for (const change of [
  { environment: 'production' },
  { authMode: 'e2e-bypass' },
  { deployed: true },
  { parity: null },
])
  test(`unverified or non-local fixture context refuses ${Object.keys(change)[0]}`, () => {
    assert.throws(() => localAssessmentUiFixture({ ...evidence(), ...change }), /target refused/);
  });
test('foreign persona keys and URLs refuse before metadata facade creation', () => {
  const v = evidence();
  assert.throws(
    () => localAssessmentUiFixture({ ...v, persona: { ...v.persona, serviceKey: 'foreign-key' } }),
    /target refused/,
  );
  assert.throws(
    () =>
      localAssessmentUiFixture({
        ...v,
        persona: { ...v.persona, supabaseUrl: 'https://foreign.invalid' },
      }),
    /target refused/,
  );
});

test('foreign application database credentials refuse even with valid persona evidence', () => {
  const v = evidence();
  assert.throws(
    () =>
      localAssessmentUiFixture({
        ...v,
        application: { ...v.application, serviceKey: 'foreign-app-key' },
      }),
    /target refused/,
  );
});
