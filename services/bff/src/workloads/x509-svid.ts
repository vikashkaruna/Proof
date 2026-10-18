import { createHash, createPrivateKey, createPublicKey, X509Certificate } from 'node:crypto';
import { z } from 'zod';
import { workloadTrustDomain } from './jwt-svid.js';

export const x509Identity = z
  .string()
  .max(2048)
  .superRefine((value, ctx) => {
    const match = /^spiffe:\/\/([^/]+)(\/[A-Za-z0-9/_-]+)$/.exec(value);
    if (!match || !workloadTrustDomain.safeParse(match[1]).success)
      ctx.addIssue({ code: 'custom', message: 'X509 identity refused' });
  });
export class X509Refused extends Error {
  constructor() {
    super('X509 workload material refused');
  }
}
function requireValid(value: unknown): asserts value {
  if (!value) throw new X509Refused();
}
const boundedBytes = (max: number) =>
  z.instanceof(Buffer).refine((b) => b.length > 0 && b.length <= max);
const response = z
  .object({
    svids: z
      .array(
        z
          .object({
            spiffeId: x509Identity,
            x509Svid: boundedBytes(128 * 1024),
            x509SvidKey: boundedBytes(16384),
            bundle: boundedBytes(128 * 1024),
            hint: z.string().max(4096).optional(),
          })
          .strict(),
      )
      .length(1),
    crl: z.array(z.instanceof(Buffer)).length(0),
    federatedBundles: z
      .record(z.string(), z.instanceof(Buffer))
      .refine((v) => Object.keys(v).length === 0),
  })
  .strict();

/** Canonical bounded DER framing; returns the exact end of one SEQUENCE. */
function sequenceEnd(bytes: Buffer, offset: number, max: number): number {
  requireValid(bytes[offset] === 0x30 && offset + 2 <= bytes.length);
  const first = bytes[offset + 1]!;
  let length = first,
    header = 2;
  if (first >= 128) {
    const count = first & 127;
    requireValid(
      count > 0 && count <= 3 && offset + 2 + count <= bytes.length && bytes[offset + 2] !== 0,
    );
    length = 0;
    for (let i = 0; i < count; i++) length = length * 256 + bytes[offset + 2 + i]!;
    requireValid(length >= 128 && (count === 1 || length >= 256 ** (count - 1)));
    header += count;
  }
  requireValid(length > 0 && header + length <= max && offset + header + length <= bytes.length);
  return offset + header + length;
}
/** Canonical DER SEQUENCE framing only; no unbounded ASN.1 recursion. */
function certificates(bytes: Buffer, limit: number): X509Certificate[] {
  const result: X509Certificate[] = [];
  for (let offset = 0; offset < bytes.length;) {
    requireValid(result.length < limit);
    const end = sequenceEnd(bytes, offset, 65536);
    result.push(new X509Certificate(bytes.subarray(offset, end)));
    offset = end;
  }
  requireValid(
    result.length > 0 && new Set(result.map((c) => c.fingerprint256)).size === result.length,
  );
  return result;
}
export interface X509Material {
  readonly spiffeId: string;
  readonly revision: string;
  readonly certificateExpiresAt: number;
  /** Own ephemeral SVID only. Trusted in-process TLS consumer; never log/retain. */
  readonly privateKeyDer: Buffer;
  readonly chainPem: string;
  readonly bundlePem: string;
}

/** Structural/signature material checks are NOT full PKIX or authenticated peer
 * authority. Stage2 MUST use a real rejectUnauthorized TLS handshake with ONLY
 * this explicit bundle, and check exact URI SAN/current epoch before release.
 * Bounded intermediates accepted; CRLs/federation/multiple own identities are
 * unsupported and fail closed. No default OS roots or network AIA retrieval. */
export function prepareX509Material(
  input: unknown,
  expectedIdentity: string,
  purpose: 'client' | 'server',
  now: number,
): X509Material {
  let keyBytes: Buffer | undefined;
  try {
    requireValid(Number.isSafeInteger(now) && now > 0 && ['client', 'server'].includes(purpose));
    x509Identity.parse(expectedIdentity);
    // Reject cardinality before Zod visits any attacker-controlled per-entry fields.
    requireValid(
      typeof input === 'object' &&
        input !== null &&
        'svids' in input &&
        Array.isArray(input.svids) &&
        input.svids.length === 1,
    );
    const value = response.parse(input).svids[0]!;
    requireValid(value.spiffeId === expectedIdentity);
    const chain = certificates(value.x509Svid, 8),
      roots = certificates(value.bundle, 20);
    const leaf = chain[0]!;
    requireValid(!leaf.ca && leaf.subjectAltName === `URI:${expectedIdentity}`);
    requireValid(
      leaf.keyUsage?.includes(purpose === 'client' ? '1.3.6.1.5.5.7.3.2' : '1.3.6.1.5.5.7.3.1'),
    );
    const validNow = (cert: X509Certificate) =>
      Number.isFinite(Date.parse(cert.validFrom)) &&
      Number.isFinite(Date.parse(cert.validTo)) &&
      Date.parse(cert.validFrom) <= now &&
      Date.parse(cert.validTo) > now;
    requireValid(chain.every(validNow));
    // SPIRE retains old authorities during rotation. Parse and bound the complete
    // bundle above, but never use an expired/future authority as a TLS anchor.
    requireValid(roots.every((cert) => cert.ca));
    const currentRoots = roots.filter(validNow);
    requireValid(currentRoots.length > 0);
    for (let i = 1; i < chain.length; i++) {
      const issuer = chain[i]!,
        child = chain[i - 1]!;
      requireValid(issuer.ca && child.checkIssued(issuer) && child.verify(issuer.publicKey));
    }
    const last = chain.at(-1)!;
    requireValid(
      currentRoots.some(
        (root) =>
          root.raw.equals(last.raw) || (last.checkIssued(root) && last.verify(root.publicKey)),
      ),
    );
    keyBytes = Buffer.from(value.x509SvidKey);
    requireValid(sequenceEnd(keyBytes, 0, 16384) === keyBytes.length);
    const privateKey = createPrivateKey({ key: keyBytes, format: 'der', type: 'pkcs8' });
    requireValid(
      createPublicKey(privateKey)
        .export({ format: 'der', type: 'spki' })
        .equals(leaf.publicKey.export({ format: 'der', type: 'spki' })),
    );
    const revision = createHash('sha256')
      .update(expectedIdentity)
      .update('\0')
      .update(value.x509Svid)
      .update('\0')
      .update(value.bundle)
      .digest('hex');
    return Object.freeze({
      spiffeId: expectedIdentity,
      revision,
      certificateExpiresAt: Math.min(
        ...[...chain, ...currentRoots].map((c) => Date.parse(c.validTo)),
      ),
      privateKeyDer: keyBytes,
      chainPem: chain.map((c) => c.toString()).join(''),
      bundlePem: currentRoots.map((c) => c.toString()).join(''),
    });
  } catch {
    keyBytes?.fill(0);
    throw new X509Refused();
  }
}
