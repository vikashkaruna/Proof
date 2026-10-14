import { randomUUID } from 'node:crypto';
import { generateTotp } from '@axiom/mfa';

/** Enrol through the deployed BFF: the harness never needs its encryption key. */
export async function enrolTestMfa(input: {
  bffUrl: string;
  supabaseUrl: string;
  anonKey: string;
  email: string;
  password: string;
  tenantId: string;
  waitForNextCode?: boolean;
}): Promise<string> {
  const login = await fetch(`${input.supabaseUrl}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
    headers: { apikey: input.anonKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: input.email, password: input.password }),
  });
  if (login.status !== 200) throw new Error('Fixture MFA login failed');
  const { access_token } = (await login.json()) as { access_token: string };
  async function post(path: string, body: unknown) {
    return fetch(`${input.bffUrl}${path}`, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
      headers: {
        Authorization: `Bearer ${access_token}`,
        'X-Tenant-Id': input.tenantId,
        'Idempotency-Key': randomUUID(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  }
  const enrol = await post('/v1/mfa/enrol', {});
  if (enrol.status !== 201) throw new Error(`Fixture MFA enrolment failed (${enrol.status})`);
  const { secret } = (await enrol.json()) as { secret: string };
  if (typeof secret !== 'string') throw new Error('Fixture MFA enrolment did not return a secret');
  const activationAt = Date.now();
  const activationCounter = Math.floor(activationAt / 30_000);
  const activation = await post('/v1/mfa/enrol/activate', {
    code: generateTotp(secret, activationAt),
  });
  if (activation.status !== 200)
    throw new Error(`Fixture MFA activation failed (${activation.status})`);
  // Recovery plaintext is neither needed nor persisted by the harness.
  await activation.arrayBuffer();
  // Activation spends the generated counter. A slow response may already have
  // crossed its boundary; retain the readiness margin without waiting another step.
  const waitMs = (activationCounter + 1) * 30_000 + 500 - Date.now();
  if (input.waitForNextCode !== false && waitMs > 0)
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  return secret;
}
