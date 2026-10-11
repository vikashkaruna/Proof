/** Optional server composition; missing or invalid authority disables all staging. */
import { z } from 'zod';
import { loadEnv, parseMfaPreviousKeys } from '@axiom/config';
import { createEvidenceIngestionWriter } from '@axiom/supabase';
import { evidenceStorage } from './evidence-ingestion.js';
import type { EvidenceControllerRpc } from './saakshi-evidence-controller.js';
import {
  createScopedTemporaryPayloadStore,
  createScopedStageClaim,
  type ScopedPayloadRpc,
} from './saakshi-payload-store.js';
import { createEncryptedRetainedResourceReader } from './saakshi-temporary-payload.js';
import { createConfiguredStagePort } from './saakshi-staging-port.js';
const secret = z
  .string()
  .min(32)
  .max(256)
  .regex(/^[A-Za-z0-9_-]+$/);
const fields = z.object({
  keyId: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/),
  payloadKey: z.string().regex(/^[a-f0-9]{64}$/),
  peerSecret: secret,
  sourceSecret: secret,
  runtimeToken: secret,
  runtimeUrl: z.url(),
  encryption: z.enum(['AES256', 'aws:kms']),
  legalHold: z.enum(['true', 'false']),
});
export function readSaakshiConfiguration(source: NodeJS.ProcessEnv = process.env) {
  if (source.AXIOM_SAAKSHI_STAGE_ENABLED !== 'true') return null;
  const parsed = fields.safeParse({
    keyId: source.AXIOM_SAAKSHI_PAYLOAD_KEY_ID,
    payloadKey: source.AXIOM_SAAKSHI_PAYLOAD_ENCRYPTION_KEY,
    peerSecret: source.AXIOM_SAAKSHI_STAGE_PEER_TOKEN,
    sourceSecret: source.AXIOM_SAAKSHI_STAGE_SOURCE_KEY,
    runtimeToken: source.AGENT_RUNTIME_INTERNAL_TOKEN,
    runtimeUrl: source.AGENT_RUNTIME_URL,
    encryption: source.AXIOM_SAAKSHI_ENCRYPTION ?? 'AES256',
    legalHold: source.AXIOM_SAAKSHI_LEGAL_HOLD ?? 'false',
  });
  if (!parsed.success) return null;
  const values = parsed.data;
  const url = new URL(values.runtimeUrl);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== '/' && url.pathname !== '')
  )
    return null;
  const key = Buffer.from(values.payloadKey, 'hex');
  const domainSecrets = [
    values.peerSecret,
    values.sourceSecret,
    values.runtimeToken,
    source.APPROVAL_SIGNING_KEY,
    source.AXIOM_MFA_ENCRYPTION_KEY,
    ...parseMfaPreviousKeys(source.AXIOM_MFA_ENCRYPTION_KEYS_PREVIOUS),
    source.AXIOM_PLANNING_SOURCE_SIGNING_KEY,
    source.SUPABASE_HUMAN_ACTION_WRITER_KEY,
    source.SUPABASE_EVIDENCE_INGESTION_WRITER_KEY,
    source.SUPABASE_AGENT_LEDGER_WRITER_KEY,
    source.AXIOM_STORAGE_SECRET_ACCESS_KEY,
    source.AWS_SECRET_ACCESS_KEY,
  ].filter((value): value is string => Boolean(value));
  const buffers = domainSecrets.flatMap((value) =>
    /^[a-f0-9]{64}$/.test(value)
      ? [Buffer.from(value), Buffer.from(value, 'hex')]
      : [Buffer.from(value)],
  );
  if (
    new Set([values.peerSecret, values.sourceSecret, values.runtimeToken]).size !== 3 ||
    buffers.some((value) => key.equals(value)) ||
    domainSecrets
      .slice(3)
      .some((value) => value === values.peerSecret || value === values.sourceSecret)
  )
    return null;
  return {
    ...values,
    key: { id: values.keyId, key, otherKeys: buffers },
    otherSecrets: domainSecrets.filter((value) => value !== values.sourceSecret),
  };
}
/** Each call uses only the role granted these named SQL functions by immutable 0119. */
export const evidenceControllerRpc: EvidenceControllerRpc = {
  async call(name, args, signal) {
    return await createEvidenceIngestionWriter().rpc(name, args).abortSignal(signal);
  },
};
const payloadRpc: ScopedPayloadRpc = {
  async call(name, args, signal) {
    return await createEvidenceIngestionWriter().rpc(name, args).abortSignal(signal);
  },
};
export function createSaakshiComposition(source: NodeJS.ProcessEnv = process.env) {
  const config = readSaakshiConfiguration(source);
  if (!config) return null;
  try {
    // Validate the restricted role locally before advertising an available workflow.
    createEvidenceIngestionWriter();
    const env = loadEnv(source);
    const storage = evidenceStorage(source);
    const stage = createConfiguredStagePort({
      ...storage.config,
      vault: storage.vault,
      resources: createEncryptedRetainedResourceReader(
        createScopedTemporaryPayloadStore(payloadRpc),
        config.key,
      ),
      claim: createScopedStageClaim(payloadRpc),
    });
    return {
      configuration: {
        key: config.key,
        retention: {
          ...storage.config,
          lockMode: 'COMPLIANCE' as const,
          retentionPolicy: 'seven_years' as const,
          encryption: config.encryption,
          legalHold: config.legalHold === 'true',
        },
      },
      invocation: {
        runtimeUrl: config.runtimeUrl,
        runtimeToken: config.runtimeToken,
      },
      internal: {
        peerSecret: config.peerSecret,
        sourceSecret: config.sourceSecret,
        otherSecrets: config.otherSecrets,
        rpc: evidenceControllerRpc,
        stage,
      },
      environment: env.ENVIRONMENT,
    };
  } catch {
    // Optional setup failures must not disable unrelated application routes.
    return null;
  }
}
