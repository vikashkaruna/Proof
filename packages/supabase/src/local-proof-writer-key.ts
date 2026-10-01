import { createHmac, timingSafeEqual } from 'node:crypto';

function sign(input: string, secret: string) {
  return createHmac('sha256', secret).update(input).digest('base64url');
}

/**
 * Test-only: bind a restricted JWT to the actual local Supabase signing secret.
 * The deployed BFF receives an operator-provisioned key from its secret store.
 */
export function mintLocalPostgrestRoleKey(input: {
  role:
    | 'statutory_proof_writer'
    | 'approval_archive_writer'
    | 'human_action_writer'
    | 'agent_ledger_writer'
    | 'evidence_ingestion_writer';
  jwtSecret: string;
  serviceKey: string;
}) {
  const { role, jwtSecret, serviceKey } = input;
  if (!jwtSecret || !serviceKey) throw new Error('Local Supabase JWT inputs are unavailable');
  const parts = serviceKey.split('.');
  if (parts.length !== 3) throw new Error('Local service key is not an HS256 JWT');
  let header: unknown;
  let payload: unknown;
  try {
    header = JSON.parse(Buffer.from(parts[0]!, 'base64url').toString('utf8'));
    payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8'));
  } catch {
    throw new Error('Local service key is malformed');
  }
  const signature = Buffer.from(parts[2]!, 'base64url');
  const expected = Buffer.from(sign(`${parts[0]}.${parts[1]}`, jwtSecret), 'base64url');
  if (
    !header ||
    typeof header !== 'object' ||
    !('alg' in header) ||
    header.alg !== 'HS256' ||
    !payload ||
    typeof payload !== 'object' ||
    !('role' in payload) ||
    payload.role !== 'service_role' ||
    !('exp' in payload) ||
    typeof payload.exp !== 'number' ||
    payload.exp <= Math.floor(Date.now() / 1000) ||
    signature.length !== expected.length ||
    !timingSafeEqual(signature, expected)
  )
    throw new Error('Local service key does not match the target JWT secret');

  const now = Math.floor(Date.now() / 1000);
  const scoped = {
    iss: 'iss' in payload && typeof payload.iss === 'string' ? payload.iss : 'supabase',
    role,
    iat: now,
    exp: Math.min(payload.exp, now + 3600),
  };
  const unsigned = `${Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')}.${Buffer.from(JSON.stringify(scoped)).toString('base64url')}`;
  return `${unsigned}.${sign(unsigned, jwtSecret)}`;
}
