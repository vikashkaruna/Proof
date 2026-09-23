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
import { WorkloadApiJwtTrust } from './workload-api-trust.js';
import { issuerNodeId, IssuerSyncHealth, SyncedWorkloadTrust } from './issuer-sync-health.js';
import { WorkloadAuthenticator, SupabaseWorkloadRegistrationStore } from './registration.js';
import { WorkloadTaskAuthority, SupabaseWorkloadTaskStore } from './tasks.js';
import { GoogleSchedulerIdentity, schedulerIdentityConfiguration } from './scheduler-identity.js';

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
    keys: z
      .object({
        provider: z.enum(['aws', 'gcp']),
        primary: z.string().max(500),
        retiring: z.array(z.string().max(500)).max(9),
      })
      .strict(),
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
  ports: {
    awsKms?: DispatchAwsKmsPort;
    gcpKms?: DispatchGcpKmsPort;
    schedulerKeys?: JWTVerifyGetKey;
  } = {},
) {
  try {
    const config = vmControllerConfiguration.parse(configuration);
    const tenant = config.tenantId as TenantId;
    const policy = new DispatchKeyPolicy(
      config.keys.provider,
      new Map([[tenant, { primary: config.keys.primary, retiring: config.keys.retiring }]]),
    );
    const launch = assessmentContainerFactory(config.launcher);
    const identity = new GoogleSchedulerIdentity(config.scheduler, ports.schedulerKeys);
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
    const revision = await new DispatchPolicyStore(db).currentRevision(policy, tenant);
    if (!(await trust.load(config.trustDomain))) throw new Error('trust unavailable');
    const wrapper =
      config.keys.provider === 'aws'
        ? new AwsDispatchKeyWrapper(policy, ports.awsKms)
        : new GcpDispatchKeyWrapper(policy, ports.gcpKms);
    const dispatch = new AssessmentDispatch(db, wrapper, new Map([[tenant, revision]]));
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
    return Object.freeze({ controller, scheduling, identity });
  } catch {
    throw new Error('VM assessment controller configuration refused');
  }
}
