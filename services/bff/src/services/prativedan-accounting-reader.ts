/** Unmounted controller-only dedicated reader. Context comes from trusted verification. */
import { modelAccountingBindingSchema } from '@axiom/types';
import { AccountedResultRefused } from './accounted-agent-result.js';
import type { AccountedResultReadPort } from './accounted-runtime-consumer.js';

export interface PrativedanAccountingControllerPort {
  verifiedContext(
    binding: Readonly<Record<string, unknown>>,
  ): Promise<Readonly<Record<string, unknown>>>;
  call(
    name: 'prativedan_read_model_accounting_result',
    arguments_: Readonly<Record<string, unknown>>,
  ): Promise<unknown>;
}
export function prativedanAccountingReader(
  dispatch: unknown,
  port: PrativedanAccountingControllerPort,
): AccountedResultReadPort {
  const binding = Object.freeze(modelAccountingBindingSchema.parse(dispatch));
  if (binding.agent !== 'prativedan' || binding.agent_version !== '0.1.0')
    throw new AccountedResultRefused();
  return {
    async call(name, args) {
      if (
        name !== 'read_model_accounting_result' ||
        args.t !== binding.tenant_id ||
        args.r !== binding.run_id ||
        args.rh !== binding.request_sha256 ||
        Object.keys(args).length !== 3 ||
        Object.keys(args).some((key) => key !== 't' && key !== 'r' && key !== 'rh')
      )
        throw new AccountedResultRefused();
      const authority = await port.verifiedContext(binding);
      return port.call('prativedan_read_model_accounting_result', {
        // Never forward the caller's mutable object after the authority await.
        t: binding.tenant_id,
        r: binding.run_id,
        rh: binding.request_sha256,
        k: binding.correlation_id,
        authority,
      });
    },
  };
}
