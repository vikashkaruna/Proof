/** Unmounted bounded controller HTTP transport. Configuration never comes from a request body. */
import { AccountedResultRefused } from './accounted-agent-result.js';
import { parsePrativedanAssessmentJson } from './prativedan-assessment-json.js';

export function accountedRuntimeHttpPort(config: {
  readonly runtimeUrl: string;
  readonly internalToken: string;
  readonly fetchImpl?: typeof fetch;
  readonly authHeaders: (signal: AbortSignal) => Promise<Readonly<Record<string, string>>>;
}) {
  const url = new URL(config.runtimeUrl);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !config.internalToken
  )
    throw new AccountedResultRefused();
  const endpoint = config.runtimeUrl.replace(/\/$/, '') + '/accounted-agents/invoke';
  return {
    async invoke(request: {
      readonly tenant_id: string;
      readonly run_id: string;
      readonly request_sha256: string;
    }): Promise<unknown> {
      const abort = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          abort.abort();
          reject(new AccountedResultRefused());
        }, 65000);
      });
      const operation = async () => {
        const headers = await config.authHeaders(abort.signal);
        if (abort.signal.aborted) throw new AccountedResultRefused();
        const response = await (config.fetchImpl ?? fetch)(endpoint, {
          method: 'POST',
          redirect: 'error',
          signal: abort.signal,
          headers: {
            'Content-Type': 'application/json',
            'X-Internal-Token': config.internalToken,
            ...headers,
          },
          body: JSON.stringify(request),
        });
        if (abort.signal.aborted || !response.ok || !response.body) {
          void response.body?.cancel().catch(() => {});
          throw new AccountedResultRefused();
        }
        const reader = response.body.getReader();
        const cancel = () => {
          void reader.cancel().catch(() => {});
        };
        abort.signal.addEventListener('abort', cancel, { once: true });
        const parts: Uint8Array[] = [];
        let size = 0;
        try {
          for (;;) {
            const next = await reader.read();
            if (abort.signal.aborted) throw new AccountedResultRefused();
            if (next.done) break;
            size += next.value.byteLength;
            if (size > 2097152) throw new AccountedResultRefused();
            parts.push(next.value);
          }
        } finally {
          abort.signal.removeEventListener('abort', cancel);
          cancel();
          reader.releaseLock();
        }
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const part of parts) {
          bytes.set(part, offset);
          offset += part.byteLength;
        }
        const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        return parsePrativedanAssessmentJson(text);
      };
      try {
        // A signal alone cannot bound an injected callback/fetch that ignores it.
        return await Promise.race([operation(), deadline]);
      } catch {
        throw new AccountedResultRefused();
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        abort.abort();
      }
    },
  };
}
