import { Client, credentials, Metadata, type ClientReadableStream } from '@grpc/grpc-js';
import { z } from 'zod';
import { types as utilTypes } from 'node:util';
import { fetchX509Svid, type X509SvidResponse } from './workload-api-protocol.js';
import { prepareX509Material, x509Identity, X509Refused, type X509Material } from './x509-svid.js';

const configuration = z
  .object({
    socketPath: z
      .string()
      .min(2)
      .max(100)
      .regex(/^\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+$/)
      .refine((s) => !s.split('/').some((p) => p === '.' || p === '..')),
    spiffeId: x509Identity,
    purpose: z.enum(['client', 'server']),
  })
  .strict();
export interface X509Stream {
  close(): void;
}
export type OpenX509Stream = (
  socketPath: string,
  deadline: number,
  data: (value: unknown) => void,
  unavailable: () => void,
) => X509Stream;
/** Fixed local Workload API only; no URL, redirect, proxy or cached credential. */
const openStream: OpenX509Stream = (path, deadline, data, unavailable) => {
  const client = new Client(`unix:${path}`, credentials.createInsecure(), {
    'grpc.enable_http_proxy': 0,
    'grpc.enable_retries': 0,
    'grpc.max_receive_message_length': 1024 * 1024,
    'grpc.max_send_message_length': 1024,
  });
  let stream: ClientReadableStream<X509SvidResponse> | undefined;
  try {
    const metadata = new Metadata();
    metadata.set('workload.spiffe.io', 'true');
    stream = client.makeServerStreamRequest(
      fetchX509Svid.path,
      fetchX509Svid.requestSerialize,
      fetchX509Svid.responseDeserialize,
      {},
      metadata,
      { deadline },
    );
    stream.on('data', data);
    stream.on('error', unavailable);
    stream.on('end', unavailable);
    stream.on('close', unavailable);
    return {
      close() {
        try {
          stream?.cancel();
        } finally {
          client.close();
        }
      },
    };
  } catch {
    try {
      stream?.cancel();
    } catch {
      /* Refuse without exposing transport details. */
    }
    try {
      client.close();
    } catch {
      /* Owned close attempted even if cancel fails. */
    }
    throw new X509Refused();
  }
};
function eraseReceivedKeys(value: unknown) {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('svids' in value) ||
    !Array.isArray(value.svids)
  )
    return;
  for (const item of value.svids) {
    if (
      typeof item === 'object' &&
      item !== null &&
      'x509SvidKey' in item &&
      Buffer.isBuffer(item.x509SvidKey)
    )
      item.x509SvidKey.fill(0);
  }
}
export interface X509Lease {
  readonly revision: string;
  readonly epoch: number;
  readonly validUntil: number;
}
/** Unmounted material/health foundation, NOT an authenticated peer/caller.
 * Every use opens a fresh bounded stream and pins its ORIGINAL lease. Changed
 * material, stream failure and stale issuer observation withhold any result.
 * The in-process work port must honor AbortSignal and own its I/O cleanup; this
 * helper cannot cancel arbitrary injected work. Stage2 must prove real TLS PKIX,
 * peer URI SAN and channel/epoch binding, never trust these material checks alone.
 */
export class WorkloadApiX509Source {
  readonly #config: z.infer<typeof configuration>;
  #revision: string | undefined;
  #epoch = 0;
  #clock = 0;
  constructor(
    config: unknown,
    private readonly health: { readonly domain: string; validUntil(): Promise<number | null> },
    private readonly open: OpenX509Stream = openStream,
  ) {
    this.#config = configuration.parse(config);
    if (health.domain !== new URL(this.#config.spiffeId).hostname) throw new X509Refused();
  }
  withSnapshot<T>(
    deadline: number,
    work: (material: X509Material, lease: X509Lease, signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    return this.exchange(
      deadline,
      work,
      () => {},
      async (value) => value,
      false,
    );
  }
  /** Trusted transport port only. The one synchronous enqueue follows final live
   * checks while the original lease is held. A later failure cannot undo a write:
   * callers must reconcile its outcome, never automatically repeat the operation.
   * receive must honor abort and the same original deadline; no lease renewal.
   * Return-value validation detects misuse, not arbitrary callback side effects:
   * only a fixed synchronous in-process transport writer may be supplied. */
  withPublication<T, R>(
    deadline: number,
    prepare: (material: X509Material, lease: X509Lease, signal: AbortSignal) => Promise<T>,
    publish: (value: T, lease: Readonly<X509Lease>) => undefined,
    receive: (value: T, signal: AbortSignal) => Promise<R>,
  ): Promise<R> {
    return this.exchange(deadline, prepare, publish, receive);
  }
  private async exchange<T, R>(
    deadline: number,
    work: (material: X509Material, lease: X509Lease, signal: AbortSignal) => Promise<T>,
    publish: (value: T, lease: Readonly<X509Lease>) => undefined,
    receive: (value: T, signal: AbortSignal) => Promise<R>,
    checkReceived = true,
  ): Promise<R> {
    let material: X509Material | undefined, stream: X509Stream | undefined;
    let materialEpoch: number | undefined;
    let valid = true,
      closed = false;
    const abort = new AbortController();
    let rejectFailure: (reason: X509Refused) => void = () => {};
    const failure = new Promise<never>((_, reject) => {
      rejectFailure = reject;
    });
    // Install a handler even if opening a synchronous injected stream refuses.
    void failure.catch(() => {});
    const refuse = () => {
      valid = false;
      abort.abort();
      rejectFailure(new X509Refused());
    };
    const clock = () => {
      const now = Date.now();
      if (!Number.isSafeInteger(now) || now < this.#clock) throw new X509Refused();
      this.#clock = now;
      return now;
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const started = clock();
      if (!Number.isSafeInteger(deadline) || deadline <= started || deadline > started + 5000)
        throw new X509Refused();
      timer = setTimeout(refuse, deadline - started);
      const before = await Promise.race([this.health.validUntil(), failure]);
      if (!Number.isSafeInteger(before) || before === null || before <= clock())
        throw new X509Refused();
      let ready: (value: X509Material) => void = () => {};
      const first = new Promise<X509Material>((resolve) => {
        ready = resolve;
      });
      stream = this.open(
        this.#config.socketPath,
        deadline,
        (value) => {
          let next: X509Material | undefined;
          try {
            if (closed || !valid) return;
            next = prepareX509Material(value, this.#config.spiffeId, this.#config.purpose, clock());
            if (this.#revision !== next.revision) {
              this.#revision = next.revision;
              this.#epoch++;
            }
            if (material) {
              if (next.revision !== material.revision) refuse();
            } else {
              materialEpoch = this.#epoch;
              material = next;
              next = undefined;
              ready(material);
            }
          } catch {
            refuse();
          } finally {
            next?.privateKeyDer.fill(0);
            eraseReceivedKeys(value);
          }
        },
        refuse,
      );
      material = await Promise.race([first, failure]);
      const epoch = materialEpoch;
      let validUntil = Math.min(deadline, before, material.certificateExpiresAt);
      if (
        !valid ||
        epoch === undefined ||
        epoch !== this.#epoch ||
        material.revision !== this.#revision ||
        clock() >= validUntil
      )
        throw new X509Refused();
      const lease = Object.freeze({ revision: material.revision, epoch, validUntil });
      clearTimeout(timer);
      timer = setTimeout(refuse, Math.max(1, validUntil - clock()));
      const result = await Promise.race([
        Promise.resolve().then(() => {
          if (
            !valid ||
            epoch !== this.#epoch ||
            material!.revision !== this.#revision ||
            clock() >= validUntil
          )
            throw new X509Refused();
          return work(material!, lease, abort.signal);
        }),
        failure,
      ]);
      const after = await Promise.race([this.health.validUntil(), failure]);
      if (
        !valid ||
        abort.signal.aborted ||
        epoch !== this.#epoch ||
        material.revision !== this.#revision ||
        after === null ||
        !Number.isSafeInteger(after) ||
        clock() >= Math.min(validUntil, after)
      )
        throw new X509Refused();
      // Later health can only shorten the original window, never renew it.
      validUntil = Math.min(validUntil, after);
      clearTimeout(timer);
      timer = setTimeout(refuse, Math.max(1, validUntil - clock()));
      // No await may intervene between the checked lease and this enqueue.
      const publication: unknown = publish(
        result,
        Object.freeze({ ...lease, validUntil: Math.min(validUntil, after) }),
      );
      // A trusted-port bug must refuse deterministically, without leaving a
      // rejected native Promise unobserved. Do not invoke arbitrary thenables;
      // this cannot undo side effects or stop an async callback already running.
      if (utilTypes.isPromise(publication))
        void Promise.prototype.then.call(publication, undefined, () => undefined);
      if (publication !== undefined) throw new X509Refused();
      const received = await Promise.race([receive(result, abort.signal), failure]);
      const finalHealth = checkReceived
        ? await Promise.race([this.health.validUntil(), failure])
        : after;
      if (
        !valid ||
        abort.signal.aborted ||
        epoch !== this.#epoch ||
        material.revision !== this.#revision ||
        finalHealth === null ||
        !Number.isSafeInteger(finalHealth) ||
        clock() >= Math.min(validUntil, finalHealth)
      )
        throw new X509Refused();
      return received;
    } catch {
      throw new X509Refused();
    } finally {
      closed = true;
      valid = false;
      clearTimeout(timer);
      abort.abort();
      try {
        stream?.close();
      } catch {
        throw new X509Refused();
      } finally {
        material?.privateKeyDer.fill(0);
      }
    }
  }
}
