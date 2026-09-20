#!/usr/bin/env node
/**
 * Mints the full set of per-environment secrets a deployed Axiom Proof stack
 * needs: the Supabase JWT secret and the anon / service_role keys signed with
 * it, plus the approval-token signing key and the two service-to-service
 * tokens.
 *
 * Why this exists
 * ---------------
 * `.env.staging.example` shipped the Supabase *demo* keys — the ones published
 * in Supabase's own documentation and identical on every machine that has ever
 * run the local stack. A service-role key bypasses RLS by design, so a
 * world-readable one on a LAN-reachable host means anyone who can route to the
 * box can read and write every tenant's data regardless of how strict the
 * application layer is.
 *
 * W0.0 makes staging, preprod, production and onprem run one identical
 * security ruleset, and @axiom/config now refuses to boot a deployed
 * environment holding the demo key. This script produces the replacement.
 *
 * It also fixes a latent defect in docker-compose.supabase.yml: GoTrue and
 * PostgREST were configured with two DIFFERENT hardcoded JWT secrets, so every
 * token GoTrue issued would have been rejected by PostgREST. Real
 * authentication could not have worked against that stack — it appeared to
 * only because auth was bypassed everywhere. Both services now read one
 * secret from the environment.
 *
 * Usage:
 *   node scripts/mint-supabase-keys.mjs                 # print to stdout
 *   node scripts/mint-supabase-keys.mjs --env staging   # label the output
 *   node scripts/mint-supabase-keys.mjs --years 5       # custom key lifetime
 *
 * The secret is printed once and never stored by this script. Put it in your
 * secret manager (GCP Secret Manager for preprod/production) or the
 * environment's .env file, which is gitignored.
 */
import { createHmac, randomBytes } from 'node:crypto';

const args = process.argv.slice(2);
const getArg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
};

const environment = getArg('env', 'staging');
const years = Number(getArg('years', '5'));

if (!Number.isFinite(years) || years <= 0) {
  console.error('--years must be a positive number');
  process.exit(1);
}

const base64url = (input) =>
  Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** Sign a Supabase-shaped JWT (HS256) for the given PostgREST role. */
function mintKey(role, secret, issuedAt, expiresAt) {
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = base64url(
    JSON.stringify({ iss: 'supabase', role, iat: issuedAt, exp: expiresAt }),
  );
  const signingInput = `${header}.${payload}`;
  const signature = createHmac('sha256', secret)
    .update(signingInput)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return `${signingInput}.${signature}`;
}

// 40 hex chars of entropy, matching the shape GoTrue and PostgREST expect.
const jwtSecret = randomBytes(32).toString('hex');
const issuedAt = Math.floor(Date.now() / 1000);
const expiresAt = issuedAt + Math.round(years * 365.25 * 24 * 60 * 60);

const anonKey = mintKey('anon', jwtSecret, issuedAt, expiresAt);
const serviceKey = mintKey('service_role', jwtSecret, issuedAt, expiresAt);

const expiryDate = new Date(expiresAt * 1000).toISOString().slice(0, 10);

console.log(`# Supabase keys for ENVIRONMENT=${environment}`);
console.log(`# Generated ${new Date().toISOString().slice(0, 10)}, valid until ${expiryDate}.`);
console.log('#');
console.log('# SUPABASE_JWT_SECRET signs and validates every token. GoTrue and PostgREST');
console.log('# must both receive THIS value or tokens issued by one are rejected by the');
console.log('# other. The anon and service_role keys below are derived from it — rotating');
console.log('# the secret invalidates both, so rotate all three together.');
console.log('#');
console.log('# SUPABASE_SERVICE_KEY bypasses RLS. It belongs only in the BFF, the agent');
console.log('# runtime and the Temporal workers. It must never reach a browser.');
console.log('');
console.log(`SUPABASE_JWT_SECRET=${jwtSecret}`);
console.log(`SUPABASE_ANON_KEY=${anonKey}`);
console.log(`SUPABASE_SERVICE_KEY=${serviceKey}`);
console.log('');
console.log('# The web and marketing apps read the public pair:');
console.log(`NEXT_PUBLIC_SUPABASE_ANON_KEY=${anonKey}`);
console.log('');
console.log('# ─── Service secrets ────────────────────────────────────────────────────────');
console.log('# These shipped as committed `dev-` literals. APPROVAL_SIGNING_KEY is the HMAC');
console.log('# key behind the approval-token gate — the single mechanism standing between a');
console.log('# generated plan and execution against a client estate. A known signing key');
console.log('# means forgeable approval tokens, so it is regenerated per environment and');
console.log('# never committed.');
console.log(`APPROVAL_SIGNING_KEY=${randomBytes(32).toString('hex')}`);
console.log(`AGENT_RUNTIME_INTERNAL_TOKEN=${randomBytes(24).toString('hex')}`);
console.log(`MODEL_GATEWAY_API_KEY=${randomBytes(24).toString('hex')}`);
console.log('');
console.log('# Decrypts TOTP secrets at rest. A TOTP secret cannot be hashed — the server');
console.log('# must recover the plaintext to compute the expected code — so this key is what');
console.log('# stands between a database read and the ability to mint valid second factors');
console.log('# for every enrolled user. Deliberately separate from APPROVAL_SIGNING_KEY.');
console.log(`AXIOM_MFA_ENCRYPTION_KEY=${randomBytes(32).toString('hex')}`);
