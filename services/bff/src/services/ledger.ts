import { LedgerClient } from '@axiom/ledger';
import { loadEnv } from '@axiom/config';
import { createClient } from '@supabase/supabase-js';
import type { AppendLedgerInput, AppendLedgerResult } from '@axiom/ledger';

export type VerifyResult =
  | { intact: true }
  | { intact: false; firstBreak: { sequenceNo: number; reason: string } }
  // SEC-10 sibling: verification that could not run is NOT verification that
  // passed. A reviewer checking a seal must be able to tell "the chain is
  // sound" from "I could not check".
  | { intact: null; error: string };

export interface LedgerService {
  append(input: AppendLedgerInput): Promise<AppendLedgerResult>;
  // `appendAndForget` was removed in W0.2. Per BR-3 no action bypasses the
  // ledger, and `append.ts` says so in its own docstring: "a ledger write
  // failure must fail the parent operation". Its single caller was tenant
  // creation (SEC-10), which is precisely a path where a missing audit entry
  // matters. If a future caller genuinely does not need durability, that is a
  // decision to argue for explicitly rather than to inherit from a helper.
  verify(tenantId: string, fromSequence?: number): Promise<VerifyResult>;
  query(opts: Parameters<LedgerClient['query']>[0]): ReturnType<LedgerClient['query']>;
}

export function createLedgerService(): LedgerService {
  const env = loadEnv();
  const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false },
  });
  const client = new LedgerClient(supabase);

  return {
    append: (input) => client.append(input),
    verify: async (tenantId, fromSequence) => {
      try {
        return await client.verify(tenantId, fromSequence);
      } catch (err: any) {
        // This used to `return { intact: true }` — an exception during the
        // integrity check reported the chain as SOUND. On a product whose
        // proposition is tamper-evidence, a failed verification that renders
        // as a green tick is worse than no verification at all: it manufactures
        // false assurance for exactly the reviewer the feature exists to serve.
        return { intact: null, error: err?.message ?? 'Ledger verification failed to run' };
      }
    },
    query: (opts) => client.query(opts),
  };
}
