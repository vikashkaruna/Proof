/** Owned loopback TCP/TLS protocol fixtures, not a real PostgreSQL/IAM acceptance. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Socket, type Server } from 'node:net';
import { createSecureContext, TLSSocket } from 'node:tls';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import type { ConnectorInvocation } from '@axiom/types';
import { postgresSessions } from './session.js';

let directory: string;
let cert: string;
let key: string;
beforeAll(async () => {
  const parent = resolve('.axiom-runtime');
  await mkdir(parent, { recursive: true, mode: 0o700 });
  directory = await mkdtemp(join(parent, 'pg-deadline-tls-fixture-'));
  await chmod(directory, 0o700);
  const keyFile = join(directory, 'key.pem'),
    certFile = join(directory, 'cert.pem');
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      keyFile,
      '-out',
      certFile,
      '-days',
      '1',
      '-subj',
      '/CN=localhost',
      '-addext',
      'subjectAltName=DNS:localhost',
      '-addext',
      'basicConstraints=critical,CA:TRUE',
    ],
    { stdio: 'ignore' },
  );
  await chmod(keyFile, 0o600);
  await chmod(certFile, 0o600);
  key = await readFile(keyFile, 'utf8');
  cert = await readFile(certFile, 'utf8');
});
afterAll(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});
function frame(type: string, payload: Buffer) {
  const result = Buffer.alloc(payload.length + 5);
  result.write(type, 0);
  result.writeInt32BE(payload.length + 4, 1);
  payload.copy(result, 5);
  return result;
}
async function fixture(mode: 'ssl-stall' | 'query-stall' | 'end-stall') {
  const sockets = new Set<Socket | TLSSocket>();
  let accepted = 0;
  let active = false;
  let queries = 0;
  let peerClosedResolve: () => void = () => {};
  const peerClosed = new Promise<void>((resolve) => {
    peerClosedResolve = resolve;
  });
  const server: Server = createServer((raw) => {
    accepted++;
    sockets.add(raw);
    raw.on('error', () => undefined);
    raw.on('close', () => {
      sockets.delete(raw);
      active = false;
      peerClosedResolve();
    });
    if (mode === 'ssl-stall') {
      raw.resume();
      return;
    }
    raw.once('data', () => {
      raw.write('S');
      const tls = new TLSSocket(raw, {
        isServer: true,
        secureContext: createSecureContext({ key, cert }),
      });
      sockets.add(tls);
      tls.on('error', () => undefined);
      tls.on('close', () => {
        sockets.delete(tls);
        active = false;
        peerClosedResolve();
      });
      let started = false;
      let buffered = Buffer.alloc(0);
      tls.on('data', (chunk: Buffer) => {
        buffered = Buffer.concat([buffered, chunk]);
        if (!started) {
          if (buffered.length < 4 || buffered.length < buffered.readInt32BE(0)) return;
          const length = buffered.readInt32BE(0);
          buffered = buffered.subarray(length);
          started = true;
          tls.write(Buffer.concat([frame('R', Buffer.alloc(4)), frame('Z', Buffer.from('I'))]));
        }
        while (buffered.length >= 5) {
          const length = buffered.readInt32BE(1);
          if (buffered.length < length + 1) return;
          const type = String.fromCharCode(buffered[0]!);
          buffered = buffered.subarray(length + 1);
          if (type === 'Q') {
            queries++;
            active = true;
            if (mode === 'end-stall') {
              active = false;
              tls.write(frame('Z', Buffer.from('I')));
            }
          }
        }
      });
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fixture address refused');
  return {
    server,
    port: address.port,
    accepted: () => accepted,
    active: () => active,
    queries: () => queries,
    peerClosed,
    async close() {
      for (const socket of sockets) socket.destroy();
      const done = once(server, 'close');
      server.close();
      await done;
    },
  };
}
function context(lifetimeMs = 1000): ConnectorInvocation {
  return {
    tenantId: 'fixture',
    estateId: 'fixture',
    systemId: 'fixture',
    connectorId: 'fixture',
    descriptorSha256: 'b'.repeat(64),
    grantId: 'fixture',
    workloadIdentity: 'spiffe://fixture/agent/drishti',
    correlationId: 'fixture',
    deadline: new Date(Date.now() + lifetimeMs).toISOString(),
  };
}
function open(
  port: number,
  password: () => Promise<string> = async () => 'IAM-mocked-fixture-only',
) {
  return postgresSessions({
    endpoint: () => ({
      host: 'localhost',
      port,
      database: 'fixture',
      user: 'axiom_drishti',
      region: 'ap-south-1',
      caPem: cert,
    }),
    credentials: { password },
  });
}

describe('PostgreSQL original-deadline owned transport closure', () => {
  it('destroys a stalled SSL-handshake socket instead of leaving connect alive', async () => {
    const f = await fixture('ssl-stall');
    try {
      await expect(open(f.port)(context())).rejects.toThrow();
      await f.peerClosed;
      expect(f.accepted()).toBe(1);
      expect(f.active()).toBe(false);
    } finally {
      await f.close();
    }
  });
  it('aborts a stalled TLS query, confirms peer closure, and permits no late query', async () => {
    const f = await fixture('query-stall');
    try {
      const session = await open(f.port)(context());
      await expect(session.query('select 1')).rejects.toThrow();
      await session.abort?.();
      await f.peerClosed;
      expect(f.queries()).toBe(1);
      expect(f.active()).toBe(false);
      await expect(session.query('select 2')).rejects.toThrow();
      expect(f.queries()).toBe(1);
    } finally {
      await f.close();
    }
  });
  it('closes an idle TLS peer without requiring a Terminate acknowledgement', async () => {
    const f = await fixture('end-stall');
    try {
      const session = await open(f.port)(context());
      await session.end();
      await f.peerClosed;
      expect(f.accepted()).toBe(1);
      expect(f.active()).toBe(false);
    } finally {
      await f.close();
    }
  });
  it('discards a late IAM-mocked credential without ever creating a target connection', async () => {
    const f = await fixture('ssl-stall');
    let release: (value: string) => void = () => {};
    const credential = new Promise<string>((resolve) => {
      release = resolve;
    });
    try {
      await expect(open(f.port, () => credential)(context(50))).rejects.toThrow();
      release('late-IAM-mocked-fixture');
      await Promise.resolve();
      await Promise.resolve();
      expect(f.accepted()).toBe(0);
    } finally {
      await f.close();
    }
  });
});
