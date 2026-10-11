import { z } from 'zod';
import { createHash, createPublicKey, sign, verify, type KeyObject } from 'node:crypto';

/**
 * Axiom Proof — Sovereign Offline Licensing Module
 *
 * Implements cryptographic offline license issuance and verification
 * for on-premise, air-gapped sovereign environments (W10).
 *
 * Designed with asymmetric Ed25519 cryptography:
 * - An uncompromised public trust root must be explicitly provisioned by the operator.
 * - Private key is retained by Axiom Minds authority to mint genuine licenses.
 * - Verification executes 100% offline without phoning home or requiring internet egress.
 */

/** Published historical authority is burned; no embedded/default trust root remains. */
const BURNED_LICENSE_ROOT_SPKI_SHA256 =
  '137bfb57f9b76d8e8e17cc1ca3e1aa05016199ad6790f0239c67e4e7021cf41f';

function trustedLicensePublicKey(
  configured: string | undefined,
): { key: KeyObject } | { error: string } {
  if (!configured?.trim()) return { error: 'Trusted license root public key is required' };
  const pem = configured.replace(/\\n/g, '\n').trim();
  // Public SPKI PEM only. Never derive trust from a supplied private key.
  if (!pem.startsWith('-----BEGIN PUBLIC KEY-----') || !pem.endsWith('-----END PUBLIC KEY-----')) {
    return { error: 'License root must be an Ed25519 public key in SPKI PEM format' };
  }
  try {
    const key = createPublicKey(pem);
    if (key.asymmetricKeyType !== 'ed25519') {
      return { error: 'License root must be an Ed25519 public key' };
    }
    const fingerprint = createHash('sha256')
      .update(key.export({ format: 'der', type: 'spki' }))
      .digest('hex');
    if (fingerprint === BURNED_LICENSE_ROOT_SPKI_SHA256) {
      return { error: 'License root public key is revoked' };
    }
    return { key };
  } catch {
    return { error: 'License root public key is malformed' };
  }
}

export const OfflineLicenseTierSchema = z.enum([
  'community',
  'enterprise-sovereign',
  'enterprise-airgapped',
]);
export type OfflineLicenseTier = z.infer<typeof OfflineLicenseTierSchema>;

export const OfflineLicensePayloadSchema = z.object({
  licenseId: z.string().min(1),
  licensee: z.string().min(1),
  environment: z.literal('onprem'),
  tier: OfflineLicenseTierSchema,
  issuedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  maxTenants: z.number().int().positive(),
  maxNodes: z.number().int().positive(),
  features: z.array(z.string()).default([]),
  hardwareFingerprint: z.string().optional(),
});

export type OfflineLicensePayload = z.infer<typeof OfflineLicensePayloadSchema>;

export interface OfflineLicenseVerificationResult {
  valid: boolean;
  payload?: OfflineLicensePayload;
  error?: string;
  daysRemaining?: number;
}

/**
 * Canonical JSON serialization ensuring deterministic byte representation
 * for cryptographic signing across different environments and runtimes.
 */
export function canonicalJsonStringify(obj: unknown): string {
  if (obj === null || typeof obj !== 'object') {
    return JSON.stringify(obj);
  }
  if (Array.isArray(obj)) {
    return '[' + obj.map(canonicalJsonStringify).join(',') + ']';
  }
  const keys = Object.keys(obj as Record<string, unknown>).sort();
  const entries = keys.map((key) => {
    const val = (obj as Record<string, unknown>)[key];
    return JSON.stringify(key) + ':' + canonicalJsonStringify(val);
  });
  return '{' + entries.join(',') + '}';
}

/**
 * Mints an offline license token using Axiom Minds Ed25519 private authority key.
 */
export function mintOfflineLicense(payload: OfflineLicensePayload, privateKeyPem: string): string {
  const validated = OfflineLicensePayloadSchema.parse(payload);
  const canonicalBytes = Buffer.from(canonicalJsonStringify(validated), 'utf-8');
  const signature = sign(null, canonicalBytes, privateKeyPem);

  const payloadB64 = Buffer.from(JSON.stringify(validated), 'utf-8').toString('base64url');
  const signatureB64 = signature.toString('base64url');

  return `v1.${payloadB64}.${signatureB64}`;
}

/**
 * Verifies an offline license token against the Axiom Minds Ed25519 root public key.
 */
export function verifyOfflineLicense(
  token: string,
  options?: {
    publicKeyPem?: string;
    now?: Date;
  },
): OfflineLicenseVerificationResult {
  if (!token || typeof token !== 'string') {
    return { valid: false, error: 'License token is required' };
  }

  const parts = token.trim().split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') {
    return {
      valid: false,
      error: 'Malformed license token format: expected v1.<payload>.<signature>',
    };
  }

  const [, payloadB64, signatureB64] = parts;
  if (!payloadB64 || !signatureB64) {
    return { valid: false, error: 'Malformed license token format: missing payload or signature' };
  }

  try {
    const payloadRaw = Buffer.from(payloadB64, 'base64url').toString('utf-8');
    const parsedJson = JSON.parse(payloadRaw);
    const payload = OfflineLicensePayloadSchema.parse(parsedJson);

    const signature = Buffer.from(signatureB64, 'base64url');
    const canonicalBytes = Buffer.from(canonicalJsonStringify(payload), 'utf-8');

    const root = trustedLicensePublicKey(
      options?.publicKeyPem ?? process.env.AXIOM_LICENSE_ROOT_PUBLIC_KEY,
    );
    if ('error' in root) return { valid: false, error: root.error };
    const isSignatureValid = verify(null, canonicalBytes, root.key, signature);

    if (!isSignatureValid) {
      return {
        valid: false,
        error: 'Cryptographic signature verification failed: license is invalid or forged',
      };
    }

    const now = options?.now ?? new Date();
    const expiresAt = new Date(payload.expiresAt);
    const issuedAt = new Date(payload.issuedAt);

    if (now.getTime() > expiresAt.getTime()) {
      return {
        valid: false,
        payload,
        error: `License has expired on ${payload.expiresAt}`,
        daysRemaining: 0,
      };
    }

    if (now.getTime() < issuedAt.getTime() - 60_000) {
      // 1 minute clock skew tolerance
      return {
        valid: false,
        payload,
        error: `License issuance date ${payload.issuedAt} is in the future`,
      };
    }

    const msRemaining = expiresAt.getTime() - now.getTime();
    const daysRemaining = Math.max(0, Math.floor(msRemaining / (1000 * 60 * 60 * 24)));

    return {
      valid: true,
      payload,
      daysRemaining,
    };
  } catch (err) {
    return {
      valid: false,
      error: `License verification failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Checks if a verified license enables a specific feature.
 */
export function hasLicenseFeature(license: OfflineLicensePayload, featureName: string): boolean {
  if (license.features.includes('*')) {
    return true;
  }
  return license.features.includes(featureName);
}
