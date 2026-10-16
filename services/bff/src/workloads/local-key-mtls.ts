import { createServer, connect, type TLSSocket, type Server } from 'node:tls';
import { constants, createPrivateKey, X509Certificate } from 'node:crypto';
import type { Socket } from 'node:net';
import { lstat, realpath, chmod } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';
import { z } from 'zod';
import { parseCatalogueJson } from '@axiom/control-library';
import { dispatchKmsBinding } from './dispatch-key-policy.js';
import type { LocalKeyService } from './local-key-service.js';
import { localKeyReference, type LocalKeyCaller } from './local-key-policy.js';
import { WorkloadApiX509Source } from './workload-api-x509.js';
import { x509Identity, X509Refused, type X509Material } from './x509-svid.js';

const ALPN = 'axiom-local-key/1';
const uuid = z.uuid().refine((s) => s === s.toLowerCase());
const mappingSchema = z
  .array(
    z
      .object({
        spiffeId: x509Identity,
        tenantId: uuid,
        workloadId: uuid,
        servicePrincipal: x509Identity,
        role: z.enum(['producer', 'controller', 'key_service']),
      })
      .strict(),
  )
  .min(1)
  .max(64);
const requestSchema = z
  .object({
    version: z.literal(1),
    operation: z.enum(['wrap', 'unwrap']),
    context: z.string().max(5500),
    key: z.string().max(100),
    keyRef: z.string().max(500).optional(),
  })
  .strict();
const resultSchema = z
  .object({
    version: z.literal(1),
    key: z.string().max(100),
    keyRef: z.string().max(500).optional(),
  })
  .strict();
export type LocalKeyTlsRequest = z.infer<typeof requestSchema>;
type Mapping = z.infer<typeof mappingSchema>[number];
/** Constructor-only trusted identity map, not claims from a request or certificate
 * CN. The actual URI SAN must equal its configured servicePrincipal. */
export class LocalKeyTlsIdentities {
  readonly #map = new Map<string, Readonly<Mapping>>();
  readonly #certificates = new WeakMap<TLSSocket, X509Certificate>();
  constructor(input: unknown) {
    try {
      for (const row of mappingSchema.parse(input)) {
        if (row.spiffeId !== row.servicePrincipal || this.#map.has(row.spiffeId))
          throw new X509Refused();
        this.#map.set(row.spiffeId, Object.freeze({ ...row }));
      }
    } catch {
      throw new X509Refused();
    }
  }
  require(socket: TLSSocket, purpose: 'client' | 'server', expected?: string): Readonly<Mapping> {
    let cert = this.#certificates.get(socket);
    if (!cert) {
      const raw = socket.getPeerCertificate().raw;
      if (Buffer.isBuffer(raw) && raw.length > 0 && raw.length <= 65536) {
        // Own a detached copy of the engine-verified peer certificate, once per
        // non-renegotiable channel; never retain a native peer-certificate handle.
        cert = new X509Certificate(Buffer.from(raw));
        this.#certificates.set(socket, cert);
      }
    }
    if (
      !socket.authorized ||
      socket.isSessionReused() ||
      socket.alpnProtocol !== ALPN ||
      !cert ||
      cert.ca ||
      !cert.keyUsage?.includes(purpose === 'client' ? '1.3.6.1.5.5.7.3.2' : '1.3.6.1.5.5.7.3.1') ||
      Date.now() < Date.parse(cert.validFrom) ||
      Date.now() >= Date.parse(cert.validTo)
    )
      throw new X509Refused();
    const row = [...this.#map.values()].find((v) => cert.subjectAltName === `URI:${v.spiffeId}`);
    if (
      !row ||
      (purpose === 'server' ? row.role !== 'key_service' : row.role === 'key_service') ||
      (expected !== undefined && row.spiffeId !== expected)
    )
      throw new X509Refused();
    return row;
  }
}
function decode(text: string, max: number) {
  const bytes = Buffer.from(text, 'base64');
  if (bytes.toString('base64') !== text || bytes.length > max) throw new X509Refused();
  return bytes;
}
function frame(input: unknown): Buffer {
  return Buffer.from(JSON.stringify(input) + '\n');
}
/** One bounded frame, no pipelining or second operation on a channel. */
function readFrame(socket: TLSSocket, signal: AbortSignal): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let bytes = Buffer.alloc(0),
      complete = false;
    const refuse = () => {
      bytes.fill(0);
      socket.destroy();
      reject(new X509Refused());
    };
    socket.on('error', refuse);
    socket.once('close', () => {
      if (!complete) refuse();
    });
    signal.addEventListener('abort', refuse, { once: true });
    socket.on('data', (chunk: Buffer) => {
      if (complete || bytes.length + chunk.length > 8192) {
        refuse();
        return;
      }
      const previous = bytes;
      bytes = Buffer.concat([bytes, chunk]);
      previous.fill(0);
      const end = bytes.indexOf(10);
      if (end === -1) return;
      try {
        if (end !== bytes.length - 1) throw new X509Refused();
        const value = parseCatalogueJson(
          new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, end)),
          8192,
        );
        complete = true;
        resolve(value);
      } catch {
        refuse();
      } finally {
        bytes.fill(0);
      }
    });
  });
}
const tlsOptions = (material: X509Material) => ({
  key: Buffer.from(
    createPrivateKey({ key: material.privateKeyDer, format: 'der', type: 'pkcs8' }).export({
      format: 'pem',
      type: 'pkcs8',
    }),
  ),
  cert: material.chainPem,
  ca: material.bundlePem,
  minVersion: 'TLSv1.3' as const,
  maxVersion: 'TLSv1.3' as const,
  secureOptions: constants.SSL_OP_NO_TICKET,
  rejectUnauthorized: true,
  ALPNProtocols: [ALPN],
  allowPartialTrustChain: false,
});
const endpointSchema = z.union([
  z.object({ path: z.string().min(1).max(100) }).strict(),
  z.object({ host: z.literal('127.0.0.1'), port: z.number().int().min(0).max(65535) }).strict(),
]);
function checked<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new X509Refused();
  return parsed.data;
}
export type LocalKeyTlsEndpoint =
  { readonly path: string } | { readonly host: '127.0.0.1'; readonly port: number };
async function endpoint(value: LocalKeyTlsEndpoint, server: boolean) {
  if ('path' in value) {
    if (!isAbsolute(value.path) || Buffer.byteLength(value.path) > 100 || value.path.includes('..'))
      throw new X509Refused();
    const directory = dirname(value.path),
      info = await lstat(directory);
    if (
      (await realpath(directory)) !== directory ||
      !info.isDirectory() ||
      info.uid !== process.getuid?.() ||
      (info.mode & 0o7777) !== 0o700
    )
      throw new X509Refused();
    // No unlink/overwrite: an existing socket/path belongs to its creator.
    if (server) {
      try {
        await lstat(value.path);
      } catch (error) {
        if (
          typeof error === 'object' &&
          error !== null &&
          'code' in error &&
          error.code === 'ENOENT'
        )
          return;
        throw new X509Refused();
      }
      throw new X509Refused();
    }
    const socket = await lstat(value.path);
    if (!socket.isSocket() || socket.uid !== process.getuid?.() || (socket.mode & 0o7777) !== 0o600)
      throw new X509Refused();
  } else if (
    value.host !== '127.0.0.1' ||
    !Number.isInteger(value.port) ||
    value.port < (server ? 0 : 1) ||
    value.port > 65535
  )
    throw new X509Refused();
}
/** Unmounted single-generation exchange. The listening socket, every TLS
 * handshake and the one operation share the original <=5s lease; this is NOT a
 * persistent daemon/supervisor or retained configuration. No SNI/session cache.
 * Real TLS PKIX precedes fixed URI mapping; SQL admission remains independent.
 * resolveAcceptedRun must use authenticated registry SQL and exact job/context,
 * never body/header run claims. LocalKeyService independently rechecks its grant.
 */
export async function serveLocalKeyMtlsGeneration(options: {
  source: WorkloadApiX509Source;
  identities: LocalKeyTlsIdentities;
  service: Pick<LocalKeyService, 'wrap' | 'unwrap'>;
  endpoint: LocalKeyTlsEndpoint;
  deadline: number;
  resolveAcceptedRun: (
    caller: Readonly<LocalKeyCaller>,
    context: Buffer,
    deadline: number,
  ) => Promise<string>;
  listening: (endpoint: LocalKeyTlsEndpoint) => void;
}): Promise<void> {
  options = {
    ...options,
    endpoint: Object.freeze(checked(endpointSchema, options.endpoint)),
    service: {
      wrap: options.service.wrap.bind(options.service),
      unwrap: options.service.unwrap.bind(options.service),
    },
  };
  let server: Server | undefined, active: TLSSocket | undefined, output: Buffer | undefined;
  let pendingRaw: Socket | undefined;
  let closed = false;
  try {
    await endpoint(options.endpoint, true);
    await options.source.withPublication(
      options.deadline,
      async (material, _lease, signal) => {
        const result = new Promise<TLSSocket>((resolve, reject) => {
          const tls = tlsOptions(material);
          try {
            server = createServer(
              {
                ...tls,
                requestCert: true,
                handshakeTimeout: Math.max(1, options.deadline - Date.now()),
              },
              resolve,
            );
          } finally {
            tls.key.fill(0);
          }
          server.maxConnections = 1;
          server.on('connection', (socket) => {
            pendingRaw = socket;
            socket.on('error', () => {});
            server?.close();
          });
          server.on('secureConnection', (socket) => {
            pendingRaw = undefined;
            active = socket;
            socket.disableRenegotiation();
          });
          server.on('tlsClientError', (_error, socket) => {
            pendingRaw = undefined;
            active = socket;
            socket.destroy();
            reject(new X509Refused());
          });
          server.on('error', () => reject(new X509Refused()));
          server.on('resumeSession', (_id, done) => done(null, undefined));
          signal.addEventListener(
            'abort',
            () => {
              if (active) active.destroy();
              else pendingRaw?.destroy();
              server?.close();
              reject(new X509Refused());
            },
            { once: true },
          );
          server.listen(options.endpoint, () => {
            void (async () => {
              if ('path' in options.endpoint) await chmod(options.endpoint.path, 0o600);
              if (closed || signal.aborted) throw new X509Refused();
              const address = server!.address();
              if (!address) throw new X509Refused();
              options.listening(
                typeof address === 'string'
                  ? { path: address }
                  : { host: '127.0.0.1', port: address.port },
              );
            })().catch(() => reject(new X509Refused()));
          });
        });
        const socket = await result;
        const peer = options.identities.require(socket, 'client');
        const body = requestSchema.parse(await readFrame(socket, signal));
        const context = decode(body.context, 4096),
          key = decode(body.key, 61);
        let secret: Uint8Array | undefined;
        const runContext = Buffer.from(context);
        const erase = () => {
          context.fill(0);
          key.fill(0);
          runContext.fill(0);
        };
        signal.addEventListener('abort', erase, { once: true });
        try {
          const binding = dispatchKmsBinding(context);
          if (
            peer.role === 'key_service' ||
            binding.tenant !== peer.tenantId ||
            (body.operation === 'wrap') !== (peer.role === 'producer')
          )
            throw new X509Refused();
          const fields = z.array(z.unknown()).parse(JSON.parse(context.toString('utf8')));
          if (fields[5] !== peer.workloadId) throw new X509Refused();
          let caller: LocalKeyCaller = { ...peer, role: peer.role };
          if (body.operation === 'unwrap')
            caller = {
              ...caller,
              originalRunId: uuid.parse(
                await options.resolveAcceptedRun(
                  Object.freeze(caller),
                  runContext,
                  options.deadline,
                ),
              ),
            };
          if (socket.destroyed || signal.aborted) throw new X509Refused();
          if (body.operation === 'wrap') {
            if (body.keyRef !== undefined || key.length !== 32) throw new X509Refused();
            const wrapped = await options.service.wrap(
              Object.freeze(caller),
              context,
              key,
              options.deadline,
            );
            secret = wrapped.wrappedKey;
            if (closed || signal.aborted || socket.destroyed || Date.now() >= options.deadline)
              throw new X509Refused();
            output = frame({
              version: 1,
              keyRef: wrapped.keyRef,
              key: Buffer.from(secret.buffer, secret.byteOffset, secret.byteLength).toString(
                'base64',
              ),
            });
          } else {
            if (!body.keyRef || key.length !== 61) throw new X509Refused();
            secret = await options.service.unwrap(
              Object.freeze(caller),
              context,
              body.keyRef,
              key,
              options.deadline,
            );
            if (closed || signal.aborted || socket.destroyed || Date.now() >= options.deadline)
              throw new X509Refused();
            output = frame({
              version: 1,
              key: Buffer.from(secret.buffer, secret.byteOffset, secret.byteLength).toString(
                'base64',
              ),
            });
          }
          return socket;
        } finally {
          signal.removeEventListener('abort', erase);
          erase();
          secret?.fill(0);
        }
      },
      (socket, lease) => {
        if (socket.destroyed || !output) throw new X509Refused();
        options.identities.require(socket, 'client');
        if (Date.now() >= lease.validUntil) throw new X509Refused();
        socket.end(output); // synchronous enqueue while checked lease held
      },
      (socket) =>
        new Promise<void>((resolve, reject) => {
          if (socket.writableFinished) resolve();
          else {
            socket.once('finish', resolve);
            socket.once('error', () => reject(new X509Refused()));
          }
        }),
    );
  } catch {
    throw new X509Refused();
  } finally {
    closed = true;
    output?.fill(0);
    if (active) active.destroy();
    else pendingRaw?.destroy();
    // Include sockets whose handshake never reached secureConnection.
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  }
}
/** One fresh authenticated TLS channel; no reused sessions, DNS, proxy or retry.
 * A post-send refusal has an uncertain outcome and must not trigger auto-repeat. */
export async function requestLocalKeyMtls(options: {
  source: WorkloadApiX509Source;
  identities: LocalKeyTlsIdentities;
  serverIdentity: string;
  endpoint: LocalKeyTlsEndpoint;
  deadline: number;
  request: LocalKeyTlsRequest;
}) {
  options = {
    ...options,
    endpoint: Object.freeze(checked(endpointSchema, options.endpoint)),
    request: Object.freeze(checked(requestSchema, options.request)),
  };
  let socket: TLSSocket | undefined, request: Buffer | undefined;
  try {
    await endpoint(options.endpoint, false);
    const body = checked(requestSchema, options.request);
    request = frame(body);
    const result = await options.source.withPublication(
      options.deadline,
      async (material, _lease, signal) => {
        const connected = new Promise<TLSSocket>((resolve, reject) => {
          const tls = tlsOptions(material);
          try {
            socket = connect(
              {
                ...tls,
                ...options.endpoint,
                checkServerIdentity: (_host, cert) =>
                  cert.subjectaltname === `URI:${options.serverIdentity}`
                    ? undefined
                    : new X509Refused(),
              },
              () => resolve(socket!),
            );
          } finally {
            tls.key.fill(0);
          }
          socket.once('error', () => reject(new X509Refused()));
          signal.addEventListener('abort', () => socket?.destroy(), { once: true });
        });
        const connectedSocket = await connected;
        connectedSocket.disableRenegotiation();
        options.identities.require(connectedSocket, 'server', options.serverIdentity);
        const received = readFrame(connectedSocket, signal);
        void received.catch(() => {});
        return { socket: connectedSocket, received };
      },
      (value, lease) => {
        if (value.socket.destroyed || !request) throw new X509Refused();
        options.identities.require(value.socket, 'server', options.serverIdentity);
        if (Date.now() >= lease.validUntil) throw new X509Refused();
        value.socket.write(request);
      },
      async (value) => {
        const r = resultSchema.parse(await value.received);
        const key = decode(r.key, 61);
        try {
          if (
            key.length !== (body.operation === 'wrap' ? 61 : 32) ||
            (body.operation === 'wrap'
              ? !localKeyReference.safeParse(r.keyRef).success
              : r.keyRef !== undefined)
          )
            throw new X509Refused();
          return r;
        } finally {
          key.fill(0);
        }
      },
    );
    // The server leaf can expire while the final local health read awaits.
    // Revalidate the pinned peer immediately before releasing received bytes;
    // a legitimate completed peer close is allowed, but no new IO occurs here.
    if (!socket || Date.now() >= options.deadline) throw new X509Refused();
    options.identities.require(socket, 'server', options.serverIdentity);
    return result;
  } catch {
    throw new X509Refused();
  } finally {
    request?.fill(0);
    socket?.destroy();
  }
}
