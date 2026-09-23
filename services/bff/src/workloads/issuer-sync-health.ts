import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import { controllerFilePath } from './controller-files.js';
import { parseWorkloadSpiffeId, type JwtTrustBundle, type JwtTrustSource } from './jwt-svid.js';

export const issuerNodeId = z
  .string()
  .max(2048)
  .refine((value) => {
    try {
      parseWorkloadSpiffeId(value);
      return /^spiffe:\/\/[^/]+\/spire\/agent\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)+$/.test(value);
    } catch {
      return false;
    }
  });
const milliseconds = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const observation = z
  .object({
    schemaVersion: z.literal(1),
    healthy: z.literal(true),
    nodeId: issuerNodeId,
    observedAtMs: milliseconds,
    syncAtMs: milliseconds,
    certificateExpiresAtMs: milliseconds,
  })
  .strict();

/** Public metadata with root-owned integrity, not a secret file. Parent must be
 * root-owned and non-writable; deployment mounts it read-only to the controller.
 * The separate owner-only credential reader intentionally stays unchanged. */
export async function readIssuerObservation(filename: string): Promise<unknown> {
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    controllerFilePath.parse(filename);
    if ((await realpath(filename)) !== filename) throw new Error();
    const parent = await lstat(dirname(filename));
    if (!parent.isDirectory() || parent.uid !== 0 || (parent.mode & 0o022) !== 0) throw new Error();
    file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const meta = await file.stat();
    if (
      !meta.isFile() ||
      meta.uid !== 0 ||
      (meta.mode & 0o022) !== 0 ||
      meta.size < 1 ||
      meta.size > 4096
    )
      throw new Error();
    const bytes = Buffer.alloc(meta.size + 1);
    const read = await file.read(bytes, 0, bytes.length, 0);
    if (read.bytesRead !== meta.size) throw new Error();
    return JSON.parse(
      new TextDecoder('utf8', { fatal: true }).decode(bytes.subarray(0, read.bytesRead)),
    );
  } catch {
    throw new Error('Issuer synchronization unavailable');
  } finally {
    try {
      await file?.close();
    } catch {
      throw new Error('Issuer synchronization unavailable');
    }
  }
}

export class IssuerSyncHealth {
  readonly nodeId: string;
  readonly domain: string;
  #lastClock = 0;
  constructor(
    nodeId: string,
    private readonly filename = '/run/spire-health/status.json',
    private readonly read: typeof readIssuerObservation = readIssuerObservation,
  ) {
    this.nodeId = issuerNodeId.parse(nodeId);
    this.domain = parseWorkloadSpiffeId(nodeId).trustDomain;
    controllerFilePath.parse(filename);
  }
  async validUntil(): Promise<number | null> {
    try {
      const started = Date.now();
      if (started < this.#lastClock) return null;
      this.#lastClock = started;
      const value = observation.parse(await this.read(this.filename));
      const now = Date.now();
      if (now < this.#lastClock || now - started > 1000) return null;
      this.#lastClock = now;
      const end = Math.min(
        value.observedAtMs + 10000,
        value.syncAtMs + 30000,
        value.certificateExpiresAtMs,
      );
      if (
        value.nodeId !== this.nodeId ||
        value.observedAtMs > now ||
        value.syncAtMs > value.observedAtMs ||
        end <= now
      )
        return null;
      return end;
    } catch {
      return null;
    }
  }
  async requireFresh(): Promise<void> {
    if ((await this.validUntil()) === null) throw new Error('Issuer synchronization unavailable');
  }
}

/** Every use checks both current node synchronization and Workload API trust.
 * Snapshots never outlive either authority, including across an awaited read. */
export class SyncedWorkloadTrust implements JwtTrustSource {
  constructor(
    private readonly source: JwtTrustSource,
    private readonly health: IssuerSyncHealth,
  ) {}
  async load(domain: string): Promise<JwtTrustBundle | null> {
    try {
      if (domain !== this.health.domain) return null;
      const before = await this.health.validUntil();
      if (before === null) return null;
      const bundle = await this.source.load(domain);
      const after = await this.health.validUntil();
      if (!bundle || after === null) return null;
      const validUntil = Math.min(before, after, bundle.validUntil);
      if (!Number.isSafeInteger(validUntil) || validUntil <= Date.now()) return null;
      return Object.freeze({ ...bundle, validUntil });
    } catch {
      return null;
    }
  }
  async stillCurrent(domain: string, revision: string): Promise<boolean> {
    const current = await this.load(domain);
    return current !== null && current.revision === revision;
  }
}
