import { DispatchRefused, type DispatchKeyWrapper } from './dispatch-payload.js';
import { dispatchKmsBinding } from './dispatch-key-policy.js';
import { localKeyReference } from './local-key-policy.js';
import {
  requestLocalKeyMtls,
  type LocalKeyTlsEndpoint,
  type LocalKeyTlsIdentities,
} from './local-key-mtls.js';
import type { WorkloadApiX509Source } from './workload-api-x509.js';

const deadlineMs = 5000;

/** Dispatch key wrapping through the admitted local custody key service
 * (0143–0150). The producer wraps and the controller unwraps; each call is one
 * fresh mutually authenticated TLS exchange with the key service's exact
 * SPIFFE identity. The key service re-reads custody admission in SQL for every
 * operation, so this adapter adds no authority of its own and never holds the
 * master key. No policy fingerprint: local custody pins travel with the SQL
 * enqueue/claim instead (AssessmentDispatch local mode). */
export class LocalDispatchKeyWrapper implements DispatchKeyWrapper {
  #busy = false;
  constructor(
    private readonly options: {
      source: WorkloadApiX509Source;
      identities: LocalKeyTlsIdentities;
      /** The key service's exact URI SAN (servicePrincipals.key_service). */
      serverIdentity: string;
      endpoint: LocalKeyTlsEndpoint;
      deadlineMs?: number;
    },
  ) {}

  async #exchange<T>(work: (deadline: number) => Promise<T>): Promise<T> {
    if (this.#busy) throw new DispatchRefused();
    this.#busy = true;
    try {
      return await work(Date.now() + (this.options.deadlineMs ?? deadlineMs));
    } catch {
      throw new DispatchRefused();
    } finally {
      this.#busy = false;
    }
  }

  async wrap(context: Uint8Array, key: Uint8Array) {
    return this.#exchange(async (deadline) => {
      if (
        !(context instanceof Uint8Array) ||
        context.byteLength < 1 ||
        context.byteLength > 4096 ||
        !(key instanceof Uint8Array) ||
        key.byteLength !== 32
      )
        throw new DispatchRefused();
      dispatchKmsBinding(context);
      const result = await requestLocalKeyMtls({
        source: this.options.source,
        identities: this.options.identities,
        serverIdentity: this.options.serverIdentity,
        endpoint: this.options.endpoint,
        deadline,
        request: {
          version: 1,
          operation: 'wrap',
          context: Buffer.from(context).toString('base64'),
          key: Buffer.from(key).toString('base64'),
        },
      });
      const wrappedKey = Buffer.from(result.key, 'base64');
      if (wrappedKey.length !== 61 || !localKeyReference.safeParse(result.keyRef).success) {
        wrappedKey.fill(0);
        throw new DispatchRefused();
      }
      return { keyRef: result.keyRef!, wrappedKey };
    });
  }

  async unwrap(context: Uint8Array, keyRef: string, wrappedKey: Uint8Array) {
    return this.#exchange(async (deadline) => {
      if (
        !(context instanceof Uint8Array) ||
        context.byteLength < 1 ||
        context.byteLength > 4096 ||
        !(wrappedKey instanceof Uint8Array) ||
        wrappedKey.byteLength !== 61 ||
        !localKeyReference.safeParse(keyRef).success
      )
        throw new DispatchRefused();
      dispatchKmsBinding(context);
      const result = await requestLocalKeyMtls({
        source: this.options.source,
        identities: this.options.identities,
        serverIdentity: this.options.serverIdentity,
        endpoint: this.options.endpoint,
        deadline,
        request: {
          version: 1,
          operation: 'unwrap',
          context: Buffer.from(context).toString('base64'),
          key: Buffer.from(wrappedKey).toString('base64'),
          keyRef,
        },
      });
      const clear = Buffer.from(result.key, 'base64');
      if (clear.length !== 32 || result.keyRef !== undefined) {
        clear.fill(0);
        throw new DispatchRefused();
      }
      return clear;
    });
  }
}
