import type { SupabaseClient } from '@supabase/supabase-js';
import type { TenantId } from '@axiom/types';
import type { JWTVerifyGetKey } from 'jose';
import { z } from 'zod';
import { AssessmentChannel } from './assessment-channel.js';
import {
  assessmentContainerFactory,
  assessmentContainerConfiguration,
  verifyAssessmentContainerRuntime,
} from './assessment-container.js';
import { AssessmentConfirmation } from './assessment-confirmation.js';
import { AssessmentController } from './assessment-controller.js';
import { AssessmentDispatch } from './assessment-dispatch.js';
import { AssessmentScheduling } from './assessment-scheduling.js';
import { AssessmentTools } from './assessment-tools.js';
import { DispatchKeyPolicy } from './dispatch-key-policy.js';
import { DispatchPolicyStore } from './dispatch-policy-store.js';
import {
  AwsDispatchKeyWrapper,
  GcpDispatchKeyWrapper,
  type DispatchAwsKmsPort,
  type DispatchGcpKmsPort,
} from './dispatch-key-wrappers.js';
import { JwtSvidVerifier, workloadTrustDomain } from './jwt-svid.js';
import { requireControllerIdentity } from './controller-identity.js';
import { WorkloadApiJwtTrust } from './workload-api-trust.js';
import { issuerNodeId, IssuerSyncHealth, SyncedWorkloadTrust } from './issuer-sync-health.js';
import { WorkloadAuthenticator, SupabaseWorkloadRegistrationStore } from './registration.js';
import { WorkloadTaskAuthority, SupabaseWorkloadTaskStore } from './tasks.js';
import { GoogleSchedulerIdentity, schedulerIdentityConfiguration } from './scheduler-identity.js';
import { localCustodyKeysConfiguration, localDispatchKeyWrapper } from './local-custody-client.js';

export const vmControllerConfiguration = z
  .object({
    schemaVersion: z.literal(1),
    tenantId: z.uuid().transform((s) => s.toLowerCase()),
    trustDomain: workloadTrustDomain,
    workloadSocket: z.literal('/run/workload/api.sock'),
    issuerNodeId,
    namespace: z
      .string()
      .min(1)
      .max(255)
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/)
      .refine((s) => s.trim() === s),
    launcher: assessmentContainerConfiguration,
    keys: z.union([
      z
        .object({
          provider: z.enum(['aws', 'gcp']),
          primary: z.string().max(500),
          retiring: z.array(z.string().max(500)).max(9),
        })
        .strict(),
      // Operator-run local key service; the controller only unwraps.
      localCustodyKeysConfiguration.extend({ workloadId: z.uuid() }).strict(),
    ]),
    scheduler: schedulerIdentityConfiguration,
  })
  .strict();

/** Trusted service construction, never request-provided configuration. One
 * configured tenant per controller instance; additional tenants use distinct
 * instances/policies. Test ports may replace provider IO but never the identity,
 * registration, task, SQL, launch or tenant-boundary implementation. */
export async function composeVmAssessmentController(
  configuration: unknown,
  db: SupabaseClient,
  ports: ControllerPorts & { schedulerKeys?: JWTVerifyGetKey } = {},
) {
  try {
    const config = vmControllerConfiguration.parse(configuration);
    // Scheduler identity is validated before any backend access.
    const identity = new GoogleSchedulerIdentity(config.scheduler, ports.schedulerKeys);
    const core = await composeControllerCore(config, db, ports);
    return Object.freeze({ ...core, identity });
  } catch {
    throw new Error('VM assessment controller configuration refused');
  }
}

/** Local co-located controller (operator-managed custody, D1/D2): local key
 * custody only, no cloud scheduler identity. Its only transport is the private
 * Unix socket (startAssessmentControllerSocket), whose OS permissions
 * authenticate the co-located scheduler. Everything else is the VM core. */
export const localControllerConfiguration = vmControllerConfiguration
  .omit({ scheduler: true, keys: true })
  .extend({ keys: localCustodyKeysConfiguration.extend({ workloadId: z.uuid() }).strict() })
  .strict();
export async function composeLocalAssessmentController(
  configuration: unknown,
  db: SupabaseClient,
  ports: ControllerPorts = {},
) {
  try {
    const config = localControllerConfiguration.parse(configuration);
    return Object.freeze(await composeControllerCore(config, db, ports));
  } catch {
    throw new Error('Local assessment controller configuration refused');
  }
}

type ControllerPorts = {
  awsKms?: DispatchAwsKmsPort;
  gcpKms?: DispatchGcpKmsPort;
  localWrapper?: typeof localDispatchKeyWrapper;
};
async function composeControllerCore(
  config: Omit<z.output<typeof vmControllerConfiguration>, 'scheduler'>,
  db: SupabaseClient,
  ports: ControllerPorts,
) {
  const tenant = config.tenantId as TenantId;
  const keys = config.keys;
  // Cloud key references are validated before any backend access.
  const policy =
    keys.provider === 'local'
      ? undefined
      : new DispatchKeyPolicy(
          keys.provider,
          new Map([[tenant, { primary: keys.primary, retiring: keys.retiring }]]),
        );
  const launch = assessmentContainerFactory(config.launcher);
  const health = new IssuerSyncHealth(config.issuerNodeId);
  if (health.domain !== config.trustDomain) throw new Error('node trust domain refused');
  const trust = new SyncedWorkloadTrust(
    new WorkloadApiJwtTrust({
      socketPath: config.workloadSocket,
      trustDomains: [config.trustDomain],
    }),
    health,
  );
  // Preflight is read-only. Never publish a key policy or register/activate a
  // workload merely because this process starts. Every tool rechecks trust.
  await verifyAssessmentContainerRuntime(config.launcher);
  await requireControllerIdentity(
    { socketPath: config.workloadSocket, trustDomain: config.trustDomain },
    trust,
  );
  let dispatch: AssessmentDispatch;
  if (keys.provider === 'local') {
    const wrapper = (ports.localWrapper ?? localDispatchKeyWrapper)(keys, {
      tenantId: tenant,
      workloadId: keys.workloadId.toLowerCase(),
      role: 'controller',
    });
    // Claims go through claim_local_assessment_dispatch with these pins.
    dispatch = new AssessmentDispatch(db, wrapper, new Map(), undefined, keys.custody);
  } else {
    if (!policy) throw new Error('key policy refused');
    const revision = await new DispatchPolicyStore(db).currentRevision(policy, tenant);
    const wrapper =
      keys.provider === 'aws'
        ? new AwsDispatchKeyWrapper(policy, ports.awsKms)
        : new GcpDispatchKeyWrapper(policy, ports.gcpKms);
    dispatch = new AssessmentDispatch(db, wrapper, new Map([[tenant, revision]]));
  }
  const requireTenant = (value: string) => {
    if (z.uuid().parse(value).toLowerCase() !== tenant) throw new Error('tenant refused');
  };
  const authority = new WorkloadTaskAuthority(
    new WorkloadAuthenticator(
      new JwtSvidVerifier(
        {
          audience: 'axiom-assessment-tools',
          trustDomains: [config.trustDomain],
          maxLifetimeSeconds: 300,
        },
        trust,
      ),
      new SupabaseWorkloadRegistrationStore(db),
    ),
    new SupabaseWorkloadTaskStore(db),
  );
  const tools = new AssessmentTools(authority, db);
  const channel = new AssessmentChannel(
    launch,
    tools,
    `spiffe://${config.trustDomain}/agent/parikshan`,
  );
  const controller = new AssessmentController(
    {
      resolve: async (tenantId, jobId) => {
        requireTenant(tenantId);
        return dispatch.resolve(tenantId, jobId);
      },
      claim: async (tenantId, jobId) => {
        requireTenant(tenantId);
        await health.requireFresh();
        return dispatch.claim(tenantId, jobId);
      },
    },
    {
      async run(...args: Parameters<AssessmentChannel['run']>) {
        // Expiry after a claim requires reconciliation, never a claim reset.
        await health.requireFresh();
        return channel.run(...args);
      },
    },
    new AssessmentConfirmation(db),
  );
  const scheduling = new AssessmentScheduling(db, {
    tenantId: tenant,
    namespace: config.namespace,
  });
  return { controller, scheduling };
}
