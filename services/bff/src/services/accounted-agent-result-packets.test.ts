import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { verifyAccountedAgentResult } from './accounted-agent-result.js';

const packets = z
  .object({
    cases: z.array(
      z.object({
        name: z.string(),
        wire_text: z.string(),
        expected: z.object({
          binding: z.unknown(),
          seal: z.unknown(),
          terminal_status: z.string(),
          runtime_output_sha256: z.string().nullable(),
        }),
        basis: z.string(),
        cost_projection: z.string().nullable(),
        runtime_output_text: z.string().nullable(),
      }),
    ),
  })
  .parse(
    JSON.parse(
      readFileSync(
        fileURLToPath(
          new URL(
            '../../../../tests/fixtures/model-accounting/accounted-results.json',
            import.meta.url,
          ),
        ),
        'utf8',
      ),
    ),
  );

describe('exact shared runtime/BFF/Temporal packets', () => {
  it.each(packets.cases)(
    '$name preserves retained business bytes and true metric projection',
    (testCase) => {
      const result = verifyAccountedAgentResult(JSON.parse(testCase.wire_text), {
        binding: testCase.expected.binding,
        seal: testCase.expected.seal,
        terminalStatus: testCase.expected.terminal_status,
        runtimeOutputSha256: testCase.expected.runtime_output_sha256,
      });
      expect(result.result.runtime_output_text).toBe(testCase.runtime_output_text);
      expect(result.result.cost_usd).toBe(testCase.cost_projection);
      expect(result.accounting_status).toBe('sealed_observed_journal');
    },
  );
});
