/** Controller-only result reader. No writer creation and no caller-supplied witness. */
import { modelAccountingBindingSchema } from '@axiom/types';
import { z } from 'zod';
import { AccountedResultRefused, verifyAccountedAgentResult } from './accounted-agent-result.js';

export interface AccountedResultReadPort {
  call(
    name: 'read_model_accounting_result',
    arguments_: {
      readonly t: string;
      readonly r: string;
      readonly rh: string;
    },
  ): Promise<unknown>;
}

export async function readAndVerifyAccountedRuntimeResult(
  value: unknown,
  dispatch: unknown,
  reader: AccountedResultReadPort,
): Promise<ReturnType<typeof verifyAccountedAgentResult>> {
  try {
    const binding = modelAccountingBindingSchema.parse(dispatch);
    const read = z
      .strictObject({
        binding: modelAccountingBindingSchema,
        seal: z.unknown(),
        terminal_status: z.enum(['succeeded', 'failed']),
        runtime_output_sha256: z.string().nullable(),
      })
      .parse(
        await reader.call('read_model_accounting_result', {
          t: binding.tenant_id,
          r: binding.run_id,
          rh: binding.request_sha256,
        }),
      );
    if (
      Object.keys(binding).some(
        (k) => binding[k as keyof typeof binding] !== read.binding[k as keyof typeof binding],
      )
    )
      throw new AccountedResultRefused();
    return verifyAccountedAgentResult(value, {
      binding,
      seal: read.seal,
      terminalStatus: read.terminal_status,
      runtimeOutputSha256: read.runtime_output_sha256,
    });
  } catch {
    throw new AccountedResultRefused();
  }
}
