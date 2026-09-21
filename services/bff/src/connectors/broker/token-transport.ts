import { request } from 'node:https';
import { isIP } from 'node:net';
import { z } from 'zod';
import { TargetBindingSchema } from '@axiom/types';
import {
  OAuthGrantError,
  type OAuthHttpResponse,
  type TokenEndpointTransport,
} from './oauth-grants.js';

const bindingSchema = z
  .object({
    endpoint: z.url().max(2048),
    address: z.string(),
    targetBinding: TargetBindingSchema,
    caPem: z.string().min(1).max(65536).optional(),
    timeoutMs: z.number().int().min(1).max(30000),
  })
  .strict();
export type PinnedTokenEndpoint = z.infer<typeof bindingSchema>;

/** One transport per trusted tenant/connector endpoint binding. This initial
 * implementation requires an explicit IPv4 pin. DNS and IPv6 fallback are
 * intentionally unavailable. Address updates require reviewed configuration.
 * A decrypted profile's URL must match the configured endpoint exactly. */
export class PinnedTokenTransport implements TokenEndpointTransport {
  readonly #binding: PinnedTokenEndpoint;
  readonly #url: URL;
  constructor(config: PinnedTokenEndpoint) {
    this.#binding = Object.freeze(bindingSchema.parse(config));
    this.#url = new URL(this.#binding.endpoint);
    const address = this.#binding.address;
    if (
      this.#url.protocol !== 'https:' ||
      this.#url.username ||
      this.#url.password ||
      this.#url.hash ||
      this.#url.search ||
      this.#url.href !== this.#binding.endpoint ||
      isIP(this.#url.hostname) !== 0 ||
      this.#url.hostname.startsWith('[') ||
      isIP(address) !== 4
    )
      throw new OAuthGrantError();
    const octets = address.split('.').map(Number);
    if (
      octets[0] === 0 ||
      octets[0]! >= 224 ||
      (octets[0] === 169 && octets[1] === 254) ||
      address === '168.63.129.16' ||
      address === '100.100.100.200' ||
      (octets[0] === 127 && this.#binding.targetBinding !== 'reference-mock')
    )
      throw new OAuthGrantError();
  }
  async post(
    endpoint: string,
    body: Uint8Array,
    headers: Readonly<Record<string, string>>,
  ): Promise<OAuthHttpResponse> {
    if (
      endpoint !== this.#binding.endpoint ||
      body.byteLength > 65536 ||
      !body.byteLength ||
      Object.keys(headers).some(
        (key) => !['Content-Type', 'Accept', 'Authorization'].includes(key),
      ) ||
      headers['Content-Type'] !== 'application/x-www-form-urlencoded' ||
      headers.Accept !== 'application/json' ||
      (headers.Authorization !== undefined &&
        !/^Basic [A-Za-z0-9+/]+=*$/.test(headers.Authorization))
    )
      throw new OAuthGrantError();
    return new Promise<OAuthHttpResponse>((resolve, reject) => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      let finished = false;
      const fail = () => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        for (const chunk of chunks) chunk.fill(0);
        reject(new OAuthGrantError());
      };
      let req: ReturnType<typeof request> | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        req = request(
          this.#url,
          {
            method: 'POST',
            agent: false,
            servername: this.#url.hostname,
            rejectUnauthorized: true,
            minVersion: 'TLSv1.2',
            ca: this.#binding.caPem,
            lookup: (_hostname, options, callback) => {
              if (options.all) callback(null, [{ address: this.#binding.address, family: 4 }]);
              else callback(null, this.#binding.address, 4);
            },
            headers: { ...headers, 'Content-Length': body.byteLength },
          },
          (response) => {
            // https.request does not follow redirects; reject before reading a body.
            if (response.statusCode !== 200) {
              response.destroy();
              req?.destroy();
              fail();
              return;
            }
            response.on('data', (chunk: Buffer) => {
              bytes += chunk.length;
              if (bytes > 65536) {
                chunk.fill(0);
                response.destroy();
                req?.destroy();
                fail();
                return;
              }
              chunks.push(chunk);
            });
            response.on('aborted', fail);
            response.on('error', fail);
            response.on('end', () => {
              if (finished) return;
              finished = true;
              clearTimeout(timer);
              const result = Buffer.concat(chunks);
              for (const chunk of chunks) chunk.fill(0);
              const header = (name: string) => {
                const value = response.headers[name];
                return Array.isArray(value) ? value.join(',') : (value ?? '');
              };
              resolve({
                status: 200,
                headers: {
                  'content-type': header('content-type'),
                  'cache-control': header('cache-control'),
                  pragma: header('pragma'),
                },
                body: result,
              });
            });
          },
        );
        timer = setTimeout(() => {
          req?.destroy();
          fail();
        }, this.#binding.timeoutMs);
        req.on('error', fail);
        req.end(body);
      } catch {
        req?.destroy();
        fail();
      }
    }).catch(() => {
      throw new OAuthGrantError();
    });
  }
}
