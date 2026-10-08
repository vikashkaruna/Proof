/** Real owned loopback HTTP/bytes. Compliance responses are simulated, NOT provider acceptance. */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { EvidenceVault } from '@axiom/evidence';
import { describe, expect, it } from 'vitest';
import {
  createConfiguredStagePort,
  resolveRetainedHumanBytes,
  type StageBinding,
  type RetainedResourceReader,
} from './saakshi-staging-port.js';

const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const body = Buffer.from('human retained artifact');
const hash = createHash('sha256').update(body).digest('hex');
function binding(): StageBinding {
  return {
    source: {
      purpose: 'saakshi_owned_resource_stage_v1',
      tenant_id: id,
      actor_id: id,
      engagement_id: null,
      operation_id: id,
      operation_key: id,
      owned_resource_id: id,
      human_request_hash: hash,
      provider: 's3-compatible',
      bucket: 'owned-stage-fixture',
      object_key: `tenants/${id}/evidence-ingestions/${id}/${hash}`,
      content_hash: hash,
      byte_size: body.length,
      retain_until: '2034-01-01T00:00:00Z',
      legal_hold: false,
      encryption: 'AES256',
    },
    runId: id,
    correlationId: id,
    requestedReceipt: '1234',
  };
}
function reader(
  chunks: Uint8Array[] = [body],
  mutate?: (b: StageBinding) => void,
): RetainedResourceReader {
  return {
    async read(b) {
      const copy = structuredClone(b);
      mutate?.(copy);
      return {
        binding: copy,
        byteSize: body.length,
        contentType: 'text/plain',
        async *open() {
          for (const chunk of chunks) yield chunk;
        },
      };
    },
  };
}
async function loopback(
  options: { lost?: boolean; mode?: string; tamper?: boolean; truncated?: boolean } = {},
) {
  let stored: Buffer | null = null;
  let metadata: Record<string, string> = {};
  let puts = 0;
  let until = '';
  const version = 'owned-http-version-1';
  const key = binding().source.object_key;
  const xml = (res: ServerResponse, text: string) => {
    res.setHeader('content-type', 'application/xml');
    res.end(text);
  };
  const headers = (res: ServerResponse) => {
    res.setHeader('x-amz-version-id', version);
    res.setHeader('x-amz-server-side-encryption', 'AES256');
    res.setHeader('content-length', stored!.length);
    for (const [name, value] of Object.entries(metadata)) res.setHeader(name, value);
  };
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url!, 'http://127.0.0.1');
    if (req.method === 'PUT') {
      puts++;
      if (stored) {
        res.statusCode = 412;
        res.end();
        return;
      }
      const chunks: Buffer[] = [];
      req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      req.on('end', () => {
        stored = Buffer.concat(chunks);
        metadata = Object.fromEntries(
          Object.entries(req.headers)
            .filter(([name]) => name.startsWith('x-amz-meta-'))
            .map(([name, value]) => [name, String(value)]),
        );
        until = String(req.headers['x-amz-object-lock-retain-until-date']);
        if (options.tamper) metadata['x-amz-meta-saakshi-original-actor'] = 'foreign';
        if (options.lost) {
          req.socket.destroy();
          return;
        }
        res.setHeader('x-amz-version-id', version);
        res.end();
      });
      return;
    }
    if (url.searchParams.has('object-lock')) {
      xml(
        res,
        '<ObjectLockConfiguration><ObjectLockEnabled>Enabled</ObjectLockEnabled></ObjectLockConfiguration>',
      );
      return;
    }
    if (url.searchParams.has('versions')) {
      xml(
        res,
        `<ListVersionsResult><IsTruncated>false</IsTruncated>${
          stored
            ? `<Version><Key>${key}</Key><VersionId>${version}</VersionId><IsLatest>true</IsLatest></Version>`
            : ''
        }</ListVersionsResult>`,
      );
      return;
    }
    if (!stored) {
      res.statusCode = 404;
      res.end();
      return;
    }
    if (url.searchParams.has('retention')) {
      xml(
        res,
        `<Retention><Mode>${options.mode ?? 'COMPLIANCE'}</Mode><RetainUntilDate>${until}</RetainUntilDate></Retention>`,
      );
      return;
    }
    if (url.searchParams.has('legal-hold')) {
      xml(res, '<LegalHold><Status>OFF</Status></LegalHold>');
      return;
    }
    headers(res);
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    res.end(options.truncated ? stored.subarray(0, stored.length - 1) : stored);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('owned fixture address missing');
  const vault = new EvidenceVault('us-east-1', `http://127.0.0.1:${address.port}`, {
    accessKeyId: 'owned-local-only',
    secretAccessKey: 'owned-local-only-not-secret',
  });
  let consumed = false;
  const claim = {
    async consume() {
      if (consumed) return { mode: 'recover_only' as const, expiresAt: Date.now() + 60_000 };
      consumed = true;
      return { mode: 'upload_once' as const, expiresAt: Date.now() + 60_000 };
    },
  };
  const port = createConfiguredStagePort({
    provider: 's3-compatible',
    bucket: 'owned-stage-fixture',
    vault,
    resources: reader(),
    claim,
    timeoutMs: 2000,
  });
  return {
    port,
    puts: () => puts,
    bytes: () => stored,
    async close() {
      vault.close();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((e) => (e ? reject(e) : resolve())),
      );
    },
  };
}

describe('retained human resource boundary', () => {
  it('accepts the exact eight MiB retained limit with bounded chunks', async () => {
    const bytes = Buffer.alloc(8 * 1024 * 1024, 7);
    const b = binding();
    b.source.byte_size = bytes.length;
    b.source.content_hash = createHash('sha256').update(bytes).digest('hex');
    b.source.object_key = `tenants/${id}/evidence-ingestions/${id}/${b.source.content_hash}`;
    const resources: RetainedResourceReader = {
      async read() {
        return {
          binding: b,
          byteSize: bytes.length,
          contentType: 'application/octet-stream',
          async *open() {
            for (let i = 0; i < bytes.length; i += 65536) yield bytes.subarray(i, i + 65536);
          },
        };
      },
    };
    const resolved = await resolveRetainedHumanBytes(b, resources, new AbortController().signal);
    expect(resolved.body.byteLength).toBe(bytes.byteLength);
    expect(resolved.body.equals(bytes)).toBe(true);
  });
  it('rejects a declared size above eight MiB before opening the resource', async () => {
    let read = false;
    const b = binding();
    b.source.byte_size = 8 * 1024 * 1024 + 1;
    const resources: RetainedResourceReader = {
      async read() {
        read = true;
        throw new Error('must not read');
      },
    };
    await expect(
      resolveRetainedHumanBytes(b, resources, new AbortController().signal),
    ).rejects.toThrow();
    expect(read).toBe(false);
  });
  it('reads exact owned bytes, digest and immutable actor/run/request binding', async () => {
    const result = await resolveRetainedHumanBytes(
      binding(),
      reader([body.subarray(0, 2), body.subarray(2)]),
      new AbortController().signal,
    );
    expect(result.body).toEqual(body);
  });
  it.each(['actor_id', 'human_request_hash', 'owned_resource_id', 'content_hash'] as const)(
    'refuses changed immutable source %s before opening storage',
    async (field) => {
      const r = reader([body], (b) => {
        b.source[field] = field.includes('hash')
          ? 'b'.repeat(64)
          : 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
      });
      await expect(
        resolveRetainedHumanBytes(binding(), r, new AbortController().signal),
      ).rejects.toThrow();
    },
  );
  it.each([Buffer.concat([body, Buffer.from('x')]), body.subarray(1), Buffer.alloc(body.length)])(
    'refuses oversized, truncated or changed retained bytes',
    async (chunk) => {
      await expect(
        resolveRetainedHumanBytes(binding(), reader([chunk]), new AbortController().signal),
      ).rejects.toThrow();
    },
  );
  it.each(['runId', 'correlationId', 'requestedReceipt'] as const)(
    'refuses changed immutable dispatch %s',
    async (field) => {
      const r = reader([body], (b) => {
        b[field] = field === 'requestedReceipt' ? '1235' : 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
      });
      await expect(
        resolveRetainedHumanBytes(binding(), r, new AbortController().signal),
      ).rejects.toThrow();
    },
  );
  it('refuses caller URLs or unapproved resource fields', async () => {
    const altered = {
      ...binding(),
      source: { ...binding().source, source_url: 'http://private.invalid' },
    };
    await expect(
      resolveRetainedHumanBytes(altered, reader(), new AbortController().signal),
    ).rejects.toThrow();
  });
  it('never uploads again when a consumed lease has no confirmed original version', async () => {
    let puts = 0;
    const port = createConfiguredStagePort({
      provider: 's3-compatible',
      bucket: 'owned-stage-fixture',
      vault: {
        async findEvidenceVersion() {
          return null;
        },
        async seal() {
          puts++;
          throw new Error('must not execute');
        },
      } as unknown as EvidenceVault,
      resources: reader(),
      claim: {
        async consume() {
          return { mode: 'recover_only', expiresAt: Date.now() + 60_000 };
        },
      },
    });
    await expect(port(binding())).rejects.toThrow('Evidence staging is unconfirmed');
    expect(puts).toBe(0);
  });
  it('bounds a hung resource before any claim or storage mutation', async () => {
    let claims = 0;
    const resources: RetainedResourceReader = { read: () => new Promise(() => {}) };
    const port = createConfiguredStagePort({
      provider: 's3-compatible',
      bucket: 'owned-stage-fixture',
      vault: {} as EvidenceVault,
      resources,
      claim: {
        async consume() {
          claims++;
          return { mode: 'upload_once', expiresAt: Date.now() + 60_000 };
        },
      },
      timeoutMs: 20,
    });
    await expect(port(binding())).rejects.toThrow('Evidence staging is unconfirmed');
    expect(claims).toBe(0);
  });
});
describe('payload expiry after upload claim', () => {
  it('refuses PUT after a slow version lookup outlives original lease', async () => {
    let puts = 0;
    const port = createConfiguredStagePort({
      provider: 's3-compatible',
      bucket: 'owned-stage-fixture',
      resources: reader(),
      claim: {
        async consume() {
          return { mode: 'upload_once', expiresAt: Date.now() + 15 };
        },
      },
      vault: {
        async findEvidenceVersion() {
          await new Promise((resolve) => setTimeout(resolve, 40));
          return null;
        },
        async seal() {
          puts++;
          throw new Error('must not execute');
        },
      } as unknown as EvidenceVault,
      timeoutMs: 1000,
    });
    await expect(port(binding())).rejects.toThrow('Evidence staging is unconfirmed');
    expect(puts).toBe(0);
  });
  it.each([0, NaN, Infinity, Date.now() - 1000])(
    'refuses invalid/expired lease %s before storage lookup',
    async (expiresAt) => {
      let reads = 0;
      const port = createConfiguredStagePort({
        provider: 's3-compatible',
        bucket: 'owned-stage-fixture',
        resources: reader(),
        claim: {
          async consume() {
            return { mode: 'upload_once', expiresAt };
          },
        },
        vault: {
          async findEvidenceVersion() {
            reads++;
            return null;
          },
        } as unknown as EvidenceVault,
      });
      await expect(port(binding())).rejects.toThrow('Evidence staging is unconfirmed');
      expect(reads).toBe(0);
    },
  );
});
describe('actual owned HTTP storage protocol (simulated Compliance assertions)', () => {
  it.each([false, true])(
    'seals exact bytes and recovers lost acknowledgement=%s without another PUT',
    async (lost) => {
      const fixture = await loopback({ lost });
      try {
        const first = await fixture.port(binding());
        const replay = await fixture.port(binding());
        expect(first.version_id).toBe('owned-http-version-1');
        expect(replay.version_id).toBe(first.version_id);
        expect(fixture.puts()).toBe(1);
        expect(fixture.bytes()).toEqual(body);
        expect(first.lock_mode).toBe('COMPLIANCE');
        expect(first).not.toHaveProperty('evidence_id');
      } finally {
        await fixture.close();
      }
    },
  );
  it.each([{ mode: 'GOVERNANCE' }, { tamper: true }, { truncated: true }])(
    'refuses unconfirmed retention, foreign original actor or truncated actual bytes %j',
    async (options) => {
      const fixture = await loopback(options);
      try {
        await expect(fixture.port(binding())).rejects.toThrow('Evidence staging is unconfirmed');
        await expect(fixture.port(binding())).rejects.toThrow('Evidence staging is unconfirmed');
        expect(fixture.puts()).toBe(1);
      } finally {
        await fixture.close();
      }
    },
  );
  it('concurrent attempts consume one upload lease and retry only the original version', async () => {
    const fixture = await loopback();
    try {
      const outcomes = await Promise.allSettled([fixture.port(binding()), fixture.port(binding())]);
      expect(outcomes.some((result) => result.status === 'fulfilled')).toBe(true);
      expect(fixture.puts()).toBe(1);
      expect((await fixture.port(binding())).version_id).toBe('owned-http-version-1');
      expect(fixture.puts()).toBe(1);
    } finally {
      await fixture.close();
    }
  });
  it('refuses configured bucket/provider drift before PUT', async () => {
    const fixture = await loopback();
    try {
      const changed = binding();
      changed.source.bucket = 'foreign-bucket';
      await expect(fixture.port(changed)).rejects.toThrow('Evidence staging is unconfirmed');
      expect(fixture.puts()).toBe(0);
    } finally {
      await fixture.close();
    }
  });
});
