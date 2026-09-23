import { Client, credentials, Metadata, type ClientUnaryCall } from '@grpc/grpc-js';
import { z } from 'zod';
import { fetchJwtSvid } from './workload-api-protocol.js';
import { JwtSvidVerifier, workloadTrustDomain, type JwtTrustSource } from './jwt-svid.js';

const audience = 'axiom-controller-startup';
const configuration = z
  .object({
    socketPath: z
      .string()
      .min(2)
      .max(100)
      .regex(/^\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+$/)
      .refine((s) => !s.split('/').some((part) => part === '.' || part === '..')),
    trustDomain: workloadTrustDomain,
    timeoutMs: z.number().int().min(100).max(5000).default(2500),
  })
  .strict();
const response = z
  .object({
    svids: z
      .array(
        z
          .object({
            spiffeId: z.string().max(2048),
            svid: z.string().min(1).max(16384),
            hint: z.string().max(4096).optional(),
          })
          .strict(),
      )
      .length(1),
  })
  .strict();

/** Startup admission for this process only; conveys no tenant, task or action
 * authority. The trusted node owns the Unix socket and workload registration.
 * Never retain, log or return the self-proof bearer. No TCP or cached fallback.
 */
export async function requireControllerIdentity(
  config: unknown,
  trust: JwtTrustSource,
): Promise<void> {
  let client: Client | undefined;
  let call: ClientUnaryCall | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const parsed = configuration.parse(config);
    const expected = `spiffe://${parsed.trustDomain}/controller/assessment`;
    const deadline = Date.now() + parsed.timeoutMs;
    client = new Client(`unix:${parsed.socketPath}`, credentials.createInsecure(), {
      'grpc.enable_http_proxy': 0,
      'grpc.enable_retries': 0,
      'grpc.max_receive_message_length': 32768,
      'grpc.max_send_message_length': 4096,
    });
    const metadata = new Metadata();
    metadata.set('workload.spiffe.io', 'true');
    const result = response.parse(
      await new Promise<unknown>((resolve, reject) => {
        timer = setTimeout(() => reject(new Error('identity unavailable')), parsed.timeoutMs);
        call = client!.makeUnaryRequest(
          fetchJwtSvid.path,
          fetchJwtSvid.requestSerialize,
          fetchJwtSvid.responseDeserialize,
          { audience: [audience], spiffeId: expected },
          metadata,
          { deadline },
          (error, value) => (error ? reject(new Error('identity unavailable')) : resolve(value)),
        );
      }),
    );
    clearTimeout(timer);
    if (Date.now() >= deadline || result.svids[0]!.spiffeId !== expected)
      throw new Error('identity refused');
    const identity = await new JwtSvidVerifier(
      {
        audience,
        trustDomains: [parsed.trustDomain],
        maxLifetimeSeconds: 300,
      },
      trust,
    ).verify(result.svids[0]!.svid);
    if (identity.spiffeId !== expected) throw new Error('identity refused');
  } catch {
    throw new Error('Controller workload identity refused');
  } finally {
    clearTimeout(timer);
    call?.cancel();
    client?.close();
  }
}
