import { z } from 'zod';
import type {
  ConnectorInvocation,
  ConnectorManifest,
  ConnectorResult,
  ReadConnector,
} from '@axiom/types';
import type { AcquiredToken } from '../broker/oauth-grants.js';
import { profileField } from '../profile.js';

export class RestConnectorRefused extends Error {
  constructor(readonly reason: string) {
    super(`REST connector refused: ${reason}`);
    this.name = 'RestConnectorRefused';
  }
}

/** Reviewed endpoint configuration keyed by a connector's endpointRef. */
export const RestEndpointSchema = z
  .object({
    baseUrl: z
      .url()
      .max(500)
      .refine((value) => {
        const url = new URL(value);
        return (
          url.protocol === 'https:' &&
          !url.username &&
          !url.password &&
          !url.search &&
          !url.hash &&
          url.pathname === '/'
        );
      }, 'An HTTPS origin with no path, credentials, query or fragment'),
  })
  .strict();
export type RestEndpoint = z.infer<typeof RestEndpointSchema>;

type Fetch = (input: string, init: RequestInit) => Promise<Response>;
const MAX_BODY = 1024 * 1024;
const MAX_SAMPLE = 100;
const MAX_FIELDS = 200;
const CURSOR = /^[A-Za-z0-9._~+/=-]{1,500}$/;

function pointer(document: unknown, path: string): unknown {
  let current = document;
  for (const segment of path.slice(1).split('/')) {
    if (current === null || typeof current !== 'object' || Array.isArray(current)) return undefined;
    if (!Object.prototype.hasOwnProperty.call(current, segment)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/** Flattens an item into dotted field paths, depth 3, arrays summarised. */
function flatten(item: unknown, prefix = '', depth = 0, out = new Map<string, unknown>()) {
  if (item === null || typeof item !== 'object' || Array.isArray(item) || depth >= 3) {
    if (prefix) out.set(prefix, Array.isArray(item) ? null : item);
    return out;
  }
  for (const [key, value] of Object.entries(item as Record<string, unknown>)) {
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(key)) continue;
    flatten(value, prefix ? `${prefix}.${key}` : key, depth + 1, out);
  }
  return out;
}

/**
 * W4.7 REST/OpenAPI read transport (Drishti discovery). Only descriptor-
 * declared GET paths are called, against a reviewed HTTPS origin, with a
 * broker-issued bearer token, no redirects, a deadline-bound timeout and a
 * 1 MiB response cap. Output is field paths and value-shape counts; response
 * bodies, values and tokens never leave this adapter or enter errors.
 */
export class RestReadConnector implements ReadConnector {
  constructor(
    private readonly manifest: ConnectorManifest,
    private readonly endpoint: RestEndpoint,
    private readonly token: (context: ConnectorInvocation) => Promise<AcquiredToken>,
    private readonly fetchImpl: Fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {
    if (manifest.transport !== 'rest' || !manifest.rest)
      throw new RestConnectorRefused('descriptor');
    if (!RestEndpointSchema.safeParse(endpoint).success) throw new RestConnectorRefused('endpoint');
  }

  private resource(name: string) {
    const resources = this.manifest.rest!.resources;
    if (!Object.prototype.hasOwnProperty.call(resources, name))
      throw new RestConnectorRefused('resource');
    return resources[name]!;
  }

  private async get(
    context: ConnectorInvocation,
    name: string,
    pageSize: number,
    cursor?: string,
  ): Promise<{ items: unknown[]; next?: string }> {
    const deadline = Date.parse(context.deadline);
    if (!Number.isFinite(deadline) || deadline <= this.now())
      throw new RestConnectorRefused('deadline');
    const resource = this.resource(name);
    const url = new URL(resource.path, this.endpoint.baseUrl);
    url.searchParams.set(resource.pageSizeParam, String(pageSize));
    if (cursor !== undefined) {
      if (!resource.cursor || !CURSOR.test(cursor)) throw new RestConnectorRefused('cursor');
      url.searchParams.set(resource.cursor.param, cursor);
    }
    const token = await this.token(context);
    let response: Response;
    try {
      response = await token.withValue((value) =>
        this.fetchImpl(url.toString(), {
          method: 'GET',
          redirect: 'error',
          headers: { authorization: `Bearer ${value}`, accept: 'application/json' },
          signal: AbortSignal.timeout(Math.max(1, deadline - this.now())),
        }),
      );
    } catch {
      throw new RestConnectorRefused('transport');
    } finally {
      token.destroy();
    }
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => undefined);
      throw new RestConnectorRefused(`status_${response.status}`);
    }
    if (!/^application\/([a-z.+-]*\+)?json\b/i.test(response.headers.get('content-type') ?? '')) {
      await response.body?.cancel().catch(() => undefined);
      throw new RestConnectorRefused('content_type');
    }
    const declared = Number(response.headers.get('content-length') ?? '0');
    if (declared > MAX_BODY) {
      await response.body?.cancel().catch(() => undefined);
      throw new RestConnectorRefused('too_large');
    }
    const body = await this.bounded(response);
    let document: unknown;
    try {
      document = JSON.parse(body);
    } catch {
      throw new RestConnectorRefused('malformed');
    }
    const items = pointer(document, resource.itemsPointer);
    if (!Array.isArray(items)) throw new RestConnectorRefused('malformed');
    const next = resource.cursor ? pointer(document, resource.cursor.responsePointer) : undefined;
    return {
      items: items.slice(0, pageSize),
      ...(typeof next === 'string' && CURSOR.test(next) ? { next } : {}),
    };
  }

  private async bounded(response: Response): Promise<string> {
    const reader = response.body?.getReader();
    if (!reader) return '';
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BODY) {
        await reader.cancel().catch(() => undefined);
        throw new RestConnectorRefused('too_large');
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString('utf8');
  }

  /** Declared resources with the field paths observed in one small page. */
  async enumerate(context: ConnectorInvocation): Promise<ConnectorResult> {
    const records = [];
    for (const name of Object.keys(this.manifest.rest!.resources).sort()) {
      const { items } = await this.get(context, name, 5);
      const fields = new Set<string>();
      for (const item of items) for (const key of flatten(item).keys()) fields.add(key);
      records.push({ resource: name, fields: [...fields].sort().slice(0, MAX_FIELDS) });
    }
    return { records };
  }

  /** Value-shape counts per field path over up to `limit` items. */
  async sample(
    context: ConnectorInvocation,
    resource: string,
    limit: number,
    cursor?: string,
  ): Promise<ConnectorResult> {
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_SAMPLE)
      throw new RestConnectorRefused('limit');
    const { items, next } = await this.get(context, resource, limit, cursor);
    const columns = new Map<string, unknown[]>();
    items.forEach((item, index) => {
      for (const [field, value] of flatten(item)) {
        if (!columns.has(field)) {
          if (columns.size >= MAX_FIELDS) continue;
          columns.set(field, new Array(index).fill(undefined));
        }
        columns.get(field)!.push(value);
      }
      for (const values of columns.values()) if (values.length <= index) values.push(undefined);
    });
    const records = [...columns.keys()]
      .sort()
      .map((field) => profileField(field, columns.get(field)!));
    return next ? { records, cursor: next } : { records };
  }

  /** Raw record reads stay disabled until the redaction pipeline covers them. */
  async read(): Promise<ConnectorResult> {
    throw new RestConnectorRefused('raw_read_disabled');
  }
}
