import { decodeJwt } from 'jose';
import { createClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { DispatchRefused } from './dispatch-payload.js';
import {
  createLocalCustodyKeyAuthority,
  verifyLocalCustodyPolicy,
  type LocalCustodyReadRpc,
} from './local-key-admission.js';
import {
  localKeyReference,
  type LocalKeyAuthority,
  type LocalKeyCaller,
} from './local-key-policy.js';
import { readControllerFile } from './controller-files.js';

const uuid = z.uuid().refine((v) => v === v.toLowerCase());
const credentialFile = z
  .object({
    schemaVersion: z.literal(1),
    apiKey: z.string().min(32).max(4096),
    accessToken: z.string().min(32).max(4096),
  })
  .strict();

export type VerifierRole = 'operator' | 'producer' | 'controller';
export interface VerifierExpectation {
  readonly tenantId: string;
  readonly workloadId: string;
  readonly principalKind: VerifierRole;
  readonly servicePrincipal: string;
}

/** Shape check of one issuer-written verifier credential (infra/local-custody-issuer).
 * PostgREST verifies the signature and SQL (local143_credential) the registry row;
 * this only refuses a credential for the wrong principal before any request. */
export function verifierCredential(bytes: Buffer, expected: VerifierExpectation) {
  const credential = credentialFile.parse(JSON.parse(bytes.toString('utf8')));
  if (decodeJwt(credential.apiKey).role !== 'anon') throw new DispatchRefused();
  const claims = z
    .object({
      role: z.literal('axiom_local_custody_verifier'),
      sub: uuid,
      tenant_id: z.literal(expected.tenantId),
      workload_id: z.literal(expected.workloadId),
      principal_kind: z.literal(expected.principalKind),
      service_principal: z.literal(expected.servicePrincipal),
      iat: z.number().int().nonnegative(),
      exp: z.number().int().positive(),
    })
    .passthrough()
    .parse(decodeJwt(credential.accessToken));
  const now = Math.floor(Date.now() / 1000);
  if (claims.iat > now || claims.exp <= now || claims.exp - claims.iat > 3600)
    throw new DispatchRefused();
  return credential;
}

/** One read port per verifier role. The credential file is re-read on every
 * call so the issuer's hourly rotation needs no restart, and an expired or
 * revoked credential refuses rather than falling back to another principal. */
export function verifierReadRpc(
  supabaseUrl: string,
  filename: string,
  expected: VerifierExpectation,
  load: (filename: string) => Promise<Buffer> = readControllerFile,
): LocalCustodyReadRpc {
  return async (name, args, signal) => {
    if (name !== 'read_local_custody_admission') throw new DispatchRefused();
    const bytes = await load(filename);
    let credential: z.infer<typeof credentialFile>;
    try {
      credential = verifierCredential(bytes, expected);
    } finally {
      bytes.fill(0);
    }
    const db = createClient(supabaseUrl, credential.apiKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: {
        headers: { Authorization: `Bearer ${credential.accessToken}` },
        fetch: (input, init) => fetch(input, { ...init, redirect: 'error' }),
      },
    });
    const { data, error } = await db.rpc(name, args).abortSignal(signal);
    return { data, error };
  };
}

/** Routes each operation to the authority holding that role's verifier
 * credential. A role without a configured credential refuses. */
export function roleRoutedKeyAuthority(
  policyText: string,
  policySha256: string,
  reads: Partial<Record<VerifierRole, LocalCustodyReadRpc>>,
): LocalKeyAuthority {
  const p = verifyLocalCustodyPolicy(policyText, policySha256);
  const authorities = new Map<VerifierRole, LocalKeyAuthority>();
  for (const role of ['operator', 'producer', 'controller'] as const) {
    const read = reads[role];
    if (read) authorities.set(role, createLocalCustodyKeyAuthority(policyText, policySha256, read));
  }
  const routed: LocalKeyAuthority = {
    value: Object.freeze({ primary: p.keyPolicy.primary }),
    async require(caller, ...rest) {
      const authority = authorities.get(caller.role);
      if (!authority) throw new DispatchRefused();
      return authority.require(caller, ...rest);
    },
  };
  return Object.freeze(routed);
}

/** resolveAcceptedRun for serveLocalKeyMtlsGeneration. The run comes only
 * from SQL: read_local_custody_admission derives the job from the authenticated
 * context and returns its original accepted grant. The key service then
 * re-reads admission with this run pinned (createLocalCustodyKeyAuthority), so
 * this lookup grants nothing by itself. */
export function acceptedRunResolver(
  policy: { tenantId: string; policyId: string },
  controllerRead: LocalCustodyReadRpc,
) {
  return async (
    caller: Readonly<LocalKeyCaller>,
    context: Buffer,
    deadline: number,
    keyRef: string,
  ): Promise<string> => {
    try {
      if (
        caller.role !== 'controller' ||
        caller.tenantId !== policy.tenantId ||
        !localKeyReference.safeParse(keyRef).success ||
        !Number.isSafeInteger(deadline) ||
        deadline <= Date.now() ||
        deadline > Date.now() + 5000 ||
        context.byteLength < 1 ||
        context.byteLength > 4096
      )
        throw new DispatchRefused();
      const contextText = context.toString('utf8');
      const jobId = uuid.parse(z.array(z.unknown()).length(10).parse(JSON.parse(contextText))[2]);
      const { data, error } = await controllerRead(
        'read_local_custody_admission',
        {
          p_tenant_id: policy.tenantId,
          p_policy_id: policy.policyId,
          p_operation: 'unwrap',
          p_key_ref: keyRef,
          p_context_text: contextText,
          p_deadline_ms: deadline,
        },
        AbortSignal.timeout(Math.max(1, deadline - Date.now())),
      );
      if (error) throw new DispatchRefused();
      const row = z
        .object({
          kind: z.literal('accepted_job'),
          tenantId: z.literal(policy.tenantId),
          policyId: z.literal(policy.policyId),
          grant: z.object({ jobId: z.literal(jobId), runId: uuid }).passthrough(),
        })
        .passthrough()
        .parse(data);
      return row.grant.runId;
    } catch {
      throw new DispatchRefused();
    }
  };
}

/** Sequential generations: each serves one mutually authenticated exchange
 * under its own <=5s lease, then the listener is gone. A refused generation
 * (bad peer, SQL refusal, idle window) is not fatal; stop ends the loop. An
 * idle window that ran to its deadline restarts at once, keeping the listener
 * gap short; a fast failure (identity source down) pauses instead of spinning. */
export async function runGenerations(
  serve: (deadline: number) => Promise<void>,
  stop: AbortSignal,
  options: { windowMs?: number; pauseMs?: number; onRefused?: () => void } = {},
): Promise<void> {
  const windowMs = options.windowMs ?? 5000;
  while (!stop.aborted) {
    const deadline = Date.now() + windowMs;
    try {
      await serve(deadline);
    } catch {
      options.onRefused?.();
      if (stop.aborted || Date.now() >= deadline - 50) continue;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, options.pauseMs ?? 250);
        stop.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
      });
    }
  }
}
