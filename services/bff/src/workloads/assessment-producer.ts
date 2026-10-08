import { canonicalAssessmentInput } from './assessment-input.js';
import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createSupabaseAdmin, createHumanActionWriter } from '@axiom/supabase';
import {
  AssessmentRequestSchema,
  AssessmentQuestionnaireSchema,
  ASSESSMENT_REQUEST_MAX_BYTES,
  type AssessmentRequest,
  type TenantId,
} from '@axiom/types';
import { z } from 'zod';
import { readControllerFile, controllerFilePath } from './controller-files.js';
import { AssessmentDispatch } from './assessment-dispatch.js';
import { DispatchKeyPolicy } from './dispatch-key-policy.js';
import { DispatchPolicyStore } from './dispatch-policy-store.js';
import {
  AwsDispatchKeyWrapper,
  GcpDispatchKeyWrapper,
  type DispatchAwsKmsPort,
  type DispatchGcpKmsPort,
} from './dispatch-key-wrappers.js';
import { DispatchRefused, type DispatchKeyWrapper } from './dispatch-payload.js';
import { workloadTrustDomain } from './jwt-svid.js';
import { readOriginalAssessmentRequest } from '../routes/assessment-original-request.js';

export class AssessmentQuestionnaireRefused extends Error {
  constructor() {
    super('Questionnaire does not match the pinned library');
  }
}
export class AssessmentContextRefused extends Error {
  constructor(readonly code: 'assessment_engagement_not_found' | 'assessment_already_recorded') {
    super('Assessment context refused');
  }
}

const uuid = z.uuid().transform((value) => value.toLowerCase());
export const assessmentProducerConfiguration = z
  .object({
    schemaVersion: z.literal(1),
    tenants: z
      .array(
        z
          .object({
            tenantId: uuid,
            workloadId: uuid,
            trustDomain: workloadTrustDomain,
            keys: z
              .object({
                provider: z.enum(['aws', 'gcp']),
                primary: z.string().max(500),
                retiring: z.array(z.string().max(500)).max(9),
              })
              .strict(),
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict();
const engagementSchema = z.object({
  id: uuid,
  tenant_id: uuid,
  estate_id: uuid.nullable(),
  library_version: z.string().min(1).max(200),
  status: z.string(),
});
const controlSchema = z.object({
  id: z.string().min(1).max(200),
  library_version: z.string(),
  title: z.string().optional(),
  assessment_questions: z
    .array(z.object({ id: z.string().min(1).max(200), type: z.string() }).passthrough())
    .max(5000),
});
export interface AssessmentRequestProducer {
  request(
    tenantId: string,
    actorId: string,
    request: AssessmentRequest,
  ): Promise<{ job_id: string; run_id: string; expires_at: string }>;
}

/** Trusted human producer only. Returned facade cannot claim/decrypt/launch/confirm.
 * Configuration never comes from HTTP; startup never publishes policy/registers work. */
export async function composeAssessmentProducer(
  configuration: unknown,
  db: SupabaseClient = createSupabaseAdmin(),
  ports: {
    awsKms?: DispatchAwsKmsPort;
    gcpKms?: DispatchGcpKmsPort;
    writer?: () => SupabaseClient;
  } = {},
): Promise<AssessmentRequestProducer> {
  try {
    const config = assessmentProducerConfiguration.parse(configuration);
    const registry = new Map<
      string,
      { workloadId: string; dispatch: Pick<AssessmentDispatch, 'enqueue' | 'recover'> }
    >();
    const ownedKeys = new Set<string>();
    for (const tenant of config.tenants) {
      if (registry.has(tenant.tenantId)) throw new DispatchRefused();
      for (const ref of [tenant.keys.primary, ...tenant.keys.retiring]) {
        if (ownedKeys.has(ref)) throw new DispatchRefused();
        ownedKeys.add(ref);
      }
      const id = tenant.tenantId as TenantId;
      const policy = new DispatchKeyPolicy(
        tenant.keys.provider,
        new Map([[id, { primary: tenant.keys.primary, retiring: tenant.keys.retiring }]]),
      );
      const revision = await new DispatchPolicyStore(db).currentRevision(policy, id);
      const registration = await db
        .from('workload_identities')
        .select('id,tenant_id,agent_name,spiffe_id,status')
        .eq('tenant_id', id)
        .eq('id', tenant.workloadId)
        .abortSignal(AbortSignal.timeout(10000))
        .single();
      if (registration.error) throw new DispatchRefused();
      z.object({
        id: z.literal(tenant.workloadId),
        tenant_id: z.literal(id),
        agent_name: z.literal('parikshan'),
        spiffe_id: z.literal(`spiffe://${tenant.trustDomain}/agent/parikshan`),
        status: z.literal('active'),
      }).parse(registration.data);
      const provider =
        tenant.keys.provider === 'aws'
          ? new AwsDispatchKeyWrapper(policy, ports.awsKms)
          : new GcpDispatchKeyWrapper(policy, ports.gcpKms);
      const wrapOnly: DispatchKeyWrapper = {
        policyFingerprint: (value) => provider.policyFingerprint(value),
        wrap: (...args) => provider.wrap(...args),
        unwrap: async () => {
          throw new DispatchRefused();
        },
      };
      const dispatch = new AssessmentDispatch(
        db,
        wrapOnly,
        new Map([[id, revision]]),
        ports.writer ?? createHumanActionWriter,
      );
      registry.set(id, {
        workloadId: tenant.workloadId,
        dispatch: {
          enqueue: dispatch.enqueue.bind(dispatch),
          recover: dispatch.recover.bind(dispatch),
        },
      });
    }
    return Object.freeze({
      async request(tenantValue: string, actorValue: string, value: AssessmentRequest) {
        const tenantId = uuid.parse(tenantValue),
          actorId = uuid.parse(actorValue),
          input = AssessmentRequestSchema.parse(value),
          jobId = input.operationKey.toLowerCase(),
          engagementId = input.engagementId.toLowerCase();
        const configured = registry.get(tenantId);
        if (!configured) throw new DispatchRefused();
        const signal = AbortSignal.timeout(10000);
        const read = await db
          .from('engagements')
          .select('id,tenant_id,estate_id,library_version,status')
          .eq('tenant_id', tenantId)
          .eq('id', engagementId)
          .abortSignal(signal)
          .maybeSingle();
        if (read.error) throw new DispatchRefused();
        if (!read.data) throw new AssessmentContextRefused('assessment_engagement_not_found');
        const engagement = engagementSchema.parse(read.data);
        if (engagement.id !== engagementId || engagement.tenant_id !== tenantId)
          throw new DispatchRefused();
        // Recovery authority is the verified immutable original human receipt,
        // never a browser-supplied version hint or today's engagement settings.
        const jobRead = await db
          .from('assessment_dispatch_jobs')
          .select(
            'id,tenant_id,run_id,actor_id,workload_id,estate_id,engagement_id,correlation_id,input_hash',
          )
          .eq('tenant_id', tenantId)
          .eq('id', jobId)
          .abortSignal(signal)
          .maybeSingle();
        if (jobRead.error) throw new DispatchRefused();
        let requestLibraryVersion = engagement.library_version;
        if (jobRead.data) {
          const job = z
            .object({
              id: z.literal(jobId),
              tenant_id: z.literal(tenantId),
              run_id: uuid,
              actor_id: z.literal(actorId),
              workload_id: z.literal(configured.workloadId),
              estate_id: z.literal(engagement.estate_id),
              engagement_id: z.literal(engagementId),
              correlation_id: z.literal(jobId),
              input_hash: z.string().regex(/^[a-f0-9]{64}$/),
            })
            .parse(jobRead.data);
          const runRead = await db
            .from('agent_runs')
            .select('id,tenant_id,agent,engagement_id,correlation_id,input_redacted_hash,metadata')
            .eq('tenant_id', tenantId)
            .eq('id', job.run_id)
            .abortSignal(signal)
            .single();
          if (runRead.error) throw new DispatchRefused();
          const run = z
            .object({
              id: uuid,
              tenant_id: uuid,
              agent: z.literal('parikshan'),
              engagement_id: uuid,
              correlation_id: uuid,
              input_redacted_hash: z.string().regex(/^[a-f0-9]{64}$/),
              metadata: z.record(z.string(), z.unknown()),
            })
            .parse(runRead.data);
          const original = await readOriginalAssessmentRequest(db, job, run);
          if (original) requestLibraryVersion = original.libraryVersion;
        }
        const inputJson = canonicalAssessmentInput(
          tenantId,
          engagementId,
          requestLibraryVersion,
          input,
        );
        if (Buffer.byteLength(inputJson, 'utf8') > ASSESSMENT_REQUEST_MAX_BYTES)
          throw new DispatchRefused();
        const context = {
          jobId,
          tenantId,
          actorId,
          workloadId: configured.workloadId,
          estateId: engagement.estate_id,
          engagementId,
          correlationId: jobId,
          inputHash: createHash('sha256').update(inputJson, 'utf8').digest('hex'),
        };
        const recovered = await configured.dispatch.recover(context, input.expectedQuestionnaire);
        if (recovered) return recovered;
        const hasDeclarations =
          Object.values(input.answers).some((row) =>
            Object.values(row).some((answer) => answer !== null),
          ) || Object.values(input.applicability).some((flag) => flag !== null);
        if (hasDeclarations && !input.expectedQuestionnaire)
          throw new AssessmentQuestionnaireRefused();
        if (
          input.expectedQuestionnaire &&
          input.expectedQuestionnaire.libraryVersion !== engagement.library_version
        )
          throw new AssessmentQuestionnaireRefused();
        const findingsRead = await db
          .from('findings')
          .select('id', { count: 'exact' })
          .eq('tenant_id', tenantId)
          .eq('engagement_id', engagementId)
          .abortSignal(signal)
          .limit(1);
        if (
          findingsRead.error ||
          !Number.isSafeInteger(findingsRead.count) ||
          findingsRead.count! < 0
        )
          throw new DispatchRefused();
        if (!['intake', 'assessment'].includes(engagement.status) || findingsRead.count !== 0)
          throw new AssessmentContextRefused('assessment_already_recorded');
        const [libraryRead, controlsRead] = await Promise.all([
          db
            .from('control_libraries')
            .select('version,status,control_count')
            .eq('version', engagement.library_version)
            .abortSignal(signal)
            .single(),
          db
            .from('controls')
            .select('id,title,library_version,assessment_questions', { count: 'exact' })
            .eq('library_version', engagement.library_version)
            .order('id')
            .abortSignal(signal)
            .limit(501),
        ]);
        if (libraryRead.error || controlsRead.error) throw new DispatchRefused();
        const library = z
          .object({
            version: z.literal(engagement.library_version),
            status: z.enum(['published', 'deprecated']),
            control_count: z.number().int().min(1).max(500),
          })
          .parse(libraryRead.data);
        const controls = z.array(controlSchema).min(1).max(500).parse(controlsRead.data);
        if (
          controlsRead.count !== controls.length ||
          controls.length !== library.control_count ||
          new Set(controls.map((row) => row.id)).size !== controls.length ||
          controls.some((row) => row.library_version !== engagement.library_version) ||
          controls.reduce((sum, row) => sum + row.assessment_questions.length, 0) > 5000
        )
          throw new DispatchRefused();
        const known = new Map(
          controls.map((row) => [
            row.id,
            new Set(
              row.assessment_questions
                .filter((question) => question.type === 'boolean')
                .map((question) => question.id),
            ),
          ]),
        );
        if (
          controls.some(
            (row) =>
              new Set(row.assessment_questions.map((q) => q.id)).size !==
              row.assessment_questions.length,
          )
        )
          throw new DispatchRefused();
        for (const [controlId, questions] of Object.entries(input.answers)) {
          const source = known.get(controlId);
          if (!source || Object.keys(questions).some((key) => !source.has(key)))
            throw new AssessmentQuestionnaireRefused();
        }
        if (input.expectedQuestionnaire) {
          const projection = {
            libraryVersion: engagement.library_version,
            controls: controls.map((row) => ({
              id: row.id,
              title: row.title,
              questions: row.assessment_questions.map((question) => ({
                id: question.id,
                prompt: question.prompt,
                type: question.type,
              })),
            })),
          };
          const checked = AssessmentQuestionnaireSchema.safeParse({
            tenantId,
            engagementId,
            ...projection,
            questionnaireDigest: input.expectedQuestionnaire.questionnaireDigest,
            digestScope: 'ordered_questionnaire_projection_v1',
            declarationsVerified: false,
          });
          if (
            !checked.success ||
            createHash('sha256').update(canonicalJson(projection), 'utf8').digest('hex') !==
              input.expectedQuestionnaire.questionnaireDigest
          )
            throw new AssessmentQuestionnaireRefused();
        }
        return configured.dispatch.enqueue(context, inputJson, input.expectedQuestionnaire);
      },
    });
  } catch {
    throw new Error('Assessment producer configuration refused');
  }
}

/** Missing deployment configuration deliberately withholds enqueue capability.
 * Configured invalid files/policies fail startup; never silently fall back to a mock. */
export async function loadAssessmentProducer(
  filename: string | undefined,
): Promise<AssessmentRequestProducer | undefined> {
  if (filename === undefined) return undefined;
  let bytes: Buffer | undefined;
  try {
    controllerFilePath.parse(filename);
    bytes = await readControllerFile(filename);
    return await composeAssessmentProducer(JSON.parse(bytes.toString('utf8')));
  } catch {
    throw new Error('Assessment producer startup refused');
  } finally {
    bytes?.fill(0);
  }
}
