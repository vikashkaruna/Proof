import test from 'node:test';
import assert from 'node:assert/strict';
import { loadAssessmentHttpModules } from './assessment-http-loader.js';
// Explicitly synthetic, unreachable configuration: module loading must not
// depend on a developer's .env, selected services, or private credentials.
Object.assign(process.env, {
  NODE_ENV: 'test',
  ENVIRONMENT: 'local',
  AXIOM_AUTH_MODE: 'strict',
  SUPABASE_URL: 'http://127.0.0.1:1',
  SUPABASE_ANON_KEY: 'synthetic-loader-anon-key'.repeat(3),
  SUPABASE_SERVICE_KEY: 'synthetic-loader-service-key'.repeat(3),
  APPROVAL_SIGNING_KEY: 'synthetic-loader-signing-key'.repeat(3),
  AXIOM_MFA_ENCRYPTION_KEY: 'a'.repeat(64),
  AGENT_RUNTIME_INTERNAL_TOKEN: 'synthetic-loader-runtime-token'.repeat(3),
  MODEL_GATEWAY_API_KEY: 'synthetic-loader-model-key'.repeat(3),
  LOG_LEVEL: 'error',
});
const tenant = 'aaaaaaaa-1111-4111-8111-111111111111',
  actor = 'bbbbbbbb-2222-4222-8222-222222222222',
  operation = 'cccccccc-3333-4333-8333-333333333333',
  engagement = 'dddddddd-4444-4444-8444-444444444444';
// Pure route protocol regression; this fake context is NOT Auth/MFA or actual
// database acceptance proof. The genuine harness uses complete normal Auth.
async function refusal(error: Error) {
  const { assessmentRequestRoutes } =
    await import('../../services/bff/src/routes/assessment-request.js');
  const route = assessmentRequestRoutes({
    request: async () => {
      throw error;
    },
  }).routes.find(({ method, path }) => method === 'POST' && path === '/assessment/jobs');
  assert(route);
  const headers = new Headers({
    'Content-Type': 'application/json',
    'Idempotency-Key': operation,
    'X-Expected-Actor-Id': actor,
  });
  const state: Record<string, unknown> = { tenantId: tenant, user: { id: actor }, role: 'owner' };
  const context = {
    req: {
      url: 'http://localhost/v1/assessment/jobs',
      header: (name: string) => headers.get(name) ?? undefined,
      json: async () => ({ operationKey: operation, engagementId: engagement }),
    },
    get: (key: string) => state[key],
    header: () => {},
    json: (value: unknown, status = 200) => Response.json(value, { status }),
  };
  const response = await route.handler(
    context as unknown as Parameters<typeof route.handler>[0],
    async () => {},
  );
  assert(response instanceof Response);
  return response;
}
test('dynamic producer preserves missing owned engagement refusal through actual route module', async () => {
  const { producer, application } = await loadAssessmentHttpModules();
  assert.equal(typeof application.createApp, 'function');
  const response = await refusal(
    new producer.AssessmentContextRefused('assessment_engagement_not_found'),
  );
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: { code: 'assessment_engagement_not_found' } });
});
test('arbitrary producer failures remain unconfirmed and private', async () => {
  await loadAssessmentHttpModules();
  const response = await refusal(new Error('private credential and questionnaire'));
  assert.equal(response.status, 503);
  const body = await response.text();
  assert(body.includes('assessment_request_unconfirmed'));
  assert(!body.includes('private credential'));
});
