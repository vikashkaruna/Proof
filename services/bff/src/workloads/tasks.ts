import { createHash, randomBytes } from 'node:crypto';
import { inspect } from 'node:util';
import type { SupabaseClient } from '@supabase/supabase-js';
import { AGENT_CONTRACTS, AgentName } from '@axiom/types';
import { z } from 'zod';
import { WorkloadAuthenticator, type RegisteredWorkload } from './registration.js';

export class WorkloadTaskRefused extends Error {
  constructor() {
    super('Workload task authority was refused.');
    this.name = 'WorkloadTaskRefused';
  }
}
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const scope = z.string().regex(/^[a-z][a-z0-9_.]{0,99}$/);
const scopes = z
  .array(scope)
  .max(32)
  .refine((v) => new Set(v).size === v.length);
const proof = z
  .string()
  .regex(/^[A-Za-z0-9_-]{43}$/)
  .refine((v) => Buffer.from(v, 'base64url').toString('base64url') === v);
const hashProof = (value: string) =>
  createHash('sha256').update(proof.parse(value), 'ascii').digest('hex');
const timestamp = z.iso.datetime({ offset: true });

/** Explicit private handoff only. Never serialize this into HTTP/browser data,
 * a Temporal history, an audit event, a process argument or a log. */
export class TaskProof {
  readonly #value: string;
  constructor(value: string) {
    this.#value = proof.parse(value);
  }
  reveal(): string {
    return this.#value;
  }
  toJSON(): string {
    return '[REDACTED TASK PROOF]';
  }
  toString(): string {
    return '[REDACTED TASK PROOF]';
  }
  [inspect.custom](): string {
    return this.toString();
  }
}

const issueSchema = z
  .object({
    tenantId: z.uuid(),
    actorId: z.uuid(),
    workloadId: z.uuid(),
    agentName: z.nativeEnum(AgentName),
    estateId: z.uuid().nullable(),
    engagementId: z.uuid().nullable(),
    correlationId: z.uuid(),
    inputHash: digest,
    scopes: scopes.optional(),
  })
  .strict();
export type TaskIssueRequest = z.infer<typeof issueSchema>;
export interface IssuedTask {
  readonly runId: string;
  readonly expiresAt: number;
  readonly proof: TaskProof;
}

/** Trusted BFF controller only. The actor must come from authenticated session
 * authority, and inputHash from the exact assigned input. SQL repeats live
 * membership/context checks and atomically persists the run, task and audit.
 * No public route or legacy run receives this authority implicitly. */
export class WorkloadTaskIssuer {
  readonly #lifetime: number;
  constructor(
    private readonly db: SupabaseClient,
    lifetimeSeconds = 300,
  ) {
    this.#lifetime = z.number().int().min(1).max(900).parse(lifetimeSeconds);
  }
  async issue(request: TaskIssueRequest): Promise<IssuedTask> {
    try {
      const input = issueSchema.parse(request);
      if (input.agentName === 'karya') throw new WorkloadTaskRefused();
      const declared: readonly string[] = AGENT_CONTRACTS[input.agentName].toolScopes;
      const selected = [...(input.scopes ?? declared)];
      if (selected.some((value) => !declared.includes(value))) throw new WorkloadTaskRefused();
      const secret = new TaskProof(randomBytes(32).toString('base64url'));
      const expiresAt = Date.now() + this.#lifetime * 1000;
      const { data, error } = await this.db.rpc('delegate_workload_task', {
        p_tenant_id: input.tenantId,
        p_actor_id: input.actorId,
        p_workload_id: input.workloadId,
        p_agent: input.agentName,
        p_estate_id: input.estateId,
        p_engagement_id: input.engagementId,
        p_correlation_id: input.correlationId,
        p_input_hash: input.inputHash,
        p_proof_hash: hashProof(secret.reveal()),
        p_scopes: selected,
        p_expires_at: new Date(expiresAt).toISOString(),
      });
      if (error) throw new WorkloadTaskRefused();
      const row = z.object({ run_id: z.uuid(), expires_at: timestamp }).strict().parse(data);
      if (Date.parse(row.expires_at) !== expiresAt || expiresAt <= Date.now())
        throw new WorkloadTaskRefused();
      return Object.freeze({ runId: row.run_id, expiresAt, proof: secret });
    } catch {
      throw new WorkloadTaskRefused();
    }
  }
  async revoke(
    tenantId: string,
    actorId: string,
    runId: string,
    correlationId: string,
  ): Promise<void> {
    try {
      const ids = z.array(z.uuid()).length(4).parse([tenantId, actorId, runId, correlationId]);
      const { data, error } = await this.db.rpc('revoke_workload_task', {
        p_tenant_id: ids[0],
        p_actor_id: ids[1],
        p_run_id: ids[2],
        p_correlation_id: ids[3],
      });
      if (
        error ||
        !z
          .object({ revoked: z.literal(true) })
          .strict()
          .safeParse(data).success
      )
        throw new WorkloadTaskRefused();
    } catch {
      throw new WorkloadTaskRefused();
    }
  }
}

const taskRow = z
  .object({
    run_id: z.uuid(),
    tenant_id: z.uuid(),
    workload_id: z.uuid(),
    agent_name: z.nativeEnum(AgentName),
    created_by: z.uuid(),
    estate_id: z.uuid().nullable(),
    engagement_id: z.uuid().nullable(),
    correlation_id: z.uuid(),
    input_hash: digest,
    scopes,
    expires_at: timestamp,
  })
  .strict();
export type TaskRecord = z.infer<typeof taskRow>;
export interface TaskLookup {
  readonly tenantId: string;
  readonly runId: string;
  readonly workloadId: string;
  readonly agentName: AgentName;
  readonly proofHash: string;
  readonly scope: string;
}
export interface WorkloadTaskStore {
  load(request: TaskLookup): Promise<TaskRecord | null>;
}
export class SupabaseWorkloadTaskStore implements WorkloadTaskStore {
  constructor(private readonly db: SupabaseClient) {}
  async load(request: TaskLookup): Promise<TaskRecord | null> {
    try {
      const { data, error } = await this.db.rpc('read_workload_task', {
        p_tenant_id: request.tenantId,
        p_run_id: request.runId,
        p_workload_id: request.workloadId,
        p_agent: request.agentName,
        p_proof_hash: request.proofHash,
        p_scope: request.scope,
      });
      if (error) throw new WorkloadTaskRefused();
      return data === null ? null : taskRow.parse(data);
    } catch {
      throw new WorkloadTaskRefused();
    }
  }
}
const requestSchema = z
  .object({
    tenantId: z.uuid(),
    runId: z.uuid(),
    agentName: z.nativeEnum(AgentName),
    workloadProof: z.string().min(1).max(16384),
    taskProof: proof,
  })
  .strict();
export type TaskAuthorizationRequest = z.infer<typeof requestSchema>;
export interface AuthorizedTask extends RegisteredWorkload {
  readonly runId: string;
  readonly createdBy: string;
  readonly estateId: string | null;
  readonly engagementId: string | null;
  readonly correlationId: string;
  readonly inputHash: string;
  readonly grantedScopes: readonly string[];
}

/** Invoke at EVERY tool operation with the server-selected required scope.
 * Identity, live task proof and declared permission are all required. Handlers
 * must use this context's tenant/estate, not fields from worker payloads.
 * This is not connector grant/approval authority; broker activation still needs
 * W4.4. No HTTP route is enabled by constructing this internal component. */
export class WorkloadTaskAuthority {
  constructor(
    private readonly workloads: Pick<WorkloadAuthenticator, 'authenticate'>,
    private readonly tasks: WorkloadTaskStore,
  ) {}
  async authorize(
    request: TaskAuthorizationRequest,
    requiredScope: string,
  ): Promise<AuthorizedTask> {
    try {
      const input = requestSchema.parse(request);
      const permission = scope.parse(requiredScope);
      const identity = await this.workloads.authenticate(
        input.workloadProof,
        input.tenantId,
        input.agentName,
        permission,
      );
      const row = taskRow.parse(
        await this.tasks.load({
          tenantId: identity.tenantId,
          runId: input.runId,
          workloadId: identity.workloadId,
          agentName: identity.agentName,
          proofHash: hashProof(input.taskProof),
          scope: permission,
        }),
      );
      const expiresAt = Math.min(identity.expiresAt, Date.parse(row.expires_at));
      if (
        identity.tenantId !== input.tenantId ||
        identity.agentName !== input.agentName ||
        row.tenant_id !== input.tenantId ||
        row.workload_id !== identity.workloadId ||
        row.run_id !== input.runId ||
        row.agent_name !== identity.agentName ||
        !row.scopes.includes(permission) ||
        !identity.declaredScopes.includes(permission) ||
        expiresAt <= Date.now()
      )
        throw new WorkloadTaskRefused();
      return Object.freeze({
        ...identity,
        expiresAt,
        runId: row.run_id,
        createdBy: row.created_by,
        estateId: row.estate_id,
        engagementId: row.engagement_id,
        correlationId: row.correlation_id,
        inputHash: row.input_hash,
        grantedScopes: Object.freeze(
          row.scopes.filter((value) => identity.declaredScopes.includes(value)),
        ),
      });
    } catch {
      throw new WorkloadTaskRefused();
    }
  }
}
