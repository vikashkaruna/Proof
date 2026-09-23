import { createHash } from 'node:crypto';
import { Client, credentials, Metadata, type ClientReadableStream } from '@grpc/grpc-js';
import { z } from 'zod';
import { fetchJwtBundles, type BundleResponse } from './workload-api-protocol.js';
import {
  jwtPublicBundle,
  workloadTrustDomain,
  type JwtTrustSource,
  type JwtTrustBundle,
} from './jwt-svid.js';

const configuration = z
  .object({
    socketPath: z
      .string()
      .min(2)
      .max(100)
      .regex(/^\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+$/)
      .refine((s) => s.trim() === s && !s.split('/').some((part) => part === '.' || part === '..')),
    trustDomains: z
      .array(workloadTrustDomain)
      .min(1)
      .max(20)
      .refine((v) => new Set(v).size === v.length),
    timeoutMs: z.number().int().min(100).max(5000).default(2500),
  })
  .strict();
const response = z.object({ bundles: z.record(z.string(), z.instanceof(Buffer)) }).strict();
const freshnessMs = 10000;

/** Explicit trusted VM-controller composition only. The local socket and its
 * parent/mount must be controlled by the trusted node, never by a job. Each
 * operation opens a bounded FetchJWTBundles stream and consumes its first full
 * snapshot; no cached fallback, token minting, token-derived URL or TCP proxy.
 * This bounds local snapshot use, not the node's replication lag from SPIRE.
 */
export class WorkloadApiJwtTrust implements JwtTrustSource {
  readonly #config: z.infer<typeof configuration>;
  constructor(config: unknown) {
    this.#config = configuration.parse(config);
  }
  async load(trustDomain: string): Promise<JwtTrustBundle | null> {
    if (!this.#config.trustDomains.includes(trustDomain)) return null;
    const started = Date.now();
    let client: Client | undefined;
    let stream: ClientReadableStream<BundleResponse> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      client = new Client(`unix:${this.#config.socketPath}`, credentials.createInsecure(), {
        'grpc.enable_http_proxy': 0,
        'grpc.max_receive_message_length': 1024 * 1024,
        'grpc.max_send_message_length': 1024,
        'grpc.enable_retries': 0,
      });
      const metadata = new Metadata();
      metadata.set('workload.spiffe.io', 'true');
      const snapshot = await new Promise<unknown>((resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Trust unavailable')), this.#config.timeoutMs);
        stream = client!.makeServerStreamRequest(
          fetchJwtBundles.path,
          fetchJwtBundles.requestSerialize,
          fetchJwtBundles.responseDeserialize,
          {},
          metadata,
          { deadline: started + this.#config.timeoutMs },
        );
        stream.once('data', resolve);
        // Keep an error listener through cancel/close; transport details must
        // never escape into HTTP responses, logs or caller-visible errors.
        stream.on('error', () => reject(new Error('Trust unavailable')));
        stream.once('end', () => reject(new Error('Trust unavailable')));
      });
      if (Date.now() >= started + this.#config.timeoutMs) return null;
      const bundles = response.parse(snapshot).bundles;
      if (Object.keys(bundles).length > 20) return null;
      const bytes = bundles[`spiffe://${trustDomain}`];
      if (!bytes || bytes.length > 128 * 1024) return null;
      const parsed = jwtPublicBundle.parse(
        JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
      );
      // Byte fingerprint conservatively rejects even formatting-only changes.
      // Include the selected domain to prevent cross-domain receipt reuse.
      return Object.freeze({
        revision: createHash('sha256').update(trustDomain).update('\0').update(bytes).digest('hex'),
        validUntil: started + freshnessMs,
        jwks: parsed,
      });
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
      stream?.cancel();
      client?.close();
    }
  }
  async stillCurrent(trustDomain: string, revision: string): Promise<boolean> {
    if (!/^[a-f0-9]{64}$/.test(revision) || revision.length !== 64) return false;
    const current = await this.load(trustDomain);
    return current !== null && current.validUntil > Date.now() && current.revision === revision;
  }
}
