/**
 * W2 Parity Services: ROPA records, Policy drafts, Playbooks, and Classification reviews.
 * Enforces tenant boundary, schema validation, RPC security definer calls, and immutable ledger audit.
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { EvidenceError, type EvidenceDatabase } from './evidence-ingestion.js';

export const createRopaRecordInputSchema = z
  .object({
    estateId: z.string().uuid().nullable().optional(),
    engagementId: z.string().uuid().nullable().optional(),
    purposeName: z.string().trim().min(1).max(200),
    legalBasis: z.enum([
      'consent',
      'statutory',
      'contract',
      'legitimate_interest',
      'employment',
      'vital_interest',
    ]),
    dataCategories: z.array(z.string().trim().min(1)).min(1).max(50),
    dataPrincipals: z.array(z.string().trim().min(1)).min(1).max(20),
    recipients: z.array(z.string().trim().min(1)).max(50).default([]),
    crossBorderTransfers: z.boolean().default(false),
    destinationCountries: z.array(z.string().trim().min(1)).max(50).default([]),
    retentionPeriodMonths: z.number().int().min(1).max(1200),
    securityMeasures: z.string().trim().min(1).max(2000),
    dpiaRequired: z.boolean().default(false),
  })
  .strict();
export type CreateRopaRecordInput = z.infer<typeof createRopaRecordInputSchema>;

export const createPolicyDraftInputSchema = z
  .object({
    title: z.string().trim().min(1).max(300),
    category: z.enum([
      'data_protection',
      'retention',
      'breach_response',
      'access_control',
      'vendor_management',
      'acceptable_use',
      'privacy_notice',
    ]),
    summary: z.string().trim().min(1).max(2000),
    content: z.string().min(1).max(5242880),
    controlCitations: z.array(z.string().trim().min(1)).max(50).default([]),
  })
  .strict();
export type CreatePolicyDraftInput = z.infer<typeof createPolicyDraftInputSchema>;

export const reviewPolicyDraftInputSchema = z
  .object({
    decision: z.enum(['approved', 'rejected']),
    expectedHash: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();
export type ReviewPolicyDraftInput = z.infer<typeof reviewPolicyDraftInputSchema>;

export const createPlaybookEntryInputSchema = z
  .object({
    title: z.string().trim().min(1).max(300),
    kind: z.enum([
      'incident_response',
      'dsar_fulfillment',
      'breach_notification',
      'vendor_audit',
      'consent_revocation',
      'continuous_monitoring',
    ]),
    triggerCondition: z.string().trim().min(1).max(1000),
    targetAgent: z.enum([
      'drishti',
      'vibhaag',
      'parikshan',
      'saakshi',
      'sudhaar',
      'karya',
      'lekha',
      'nazar',
      'prativedan',
      'sanket',
    ]),
    steps: z.array(z.record(z.string(), z.unknown())).min(1).max(50),
    requiresHumanApproval: z.boolean().default(true),
  })
  .strict();
export type CreatePlaybookEntryInput = z.infer<typeof createPlaybookEntryInputSchema>;

export const submitClassificationReviewInputSchema = z
  .object({
    estateId: z.string().uuid().nullable().optional(),
    systemId: z.string().trim().min(1).max(200),
    resourcePath: z.string().trim().min(1).max(1000),
    sensitivityLevel: z.enum(['public', 'internal', 'confidential', 'restricted', 'critical_pii']),
    detectedCategories: z.array(z.string().trim().min(1)).min(1).max(50),
    confidenceScore: z.number().min(0).max(100),
    decision: z.enum(['confirmed', 'adjusted', 'overridden', 'dismissed']),
    adjustedSensitivity: z
      .enum(['public', 'internal', 'confidential', 'restricted', 'critical_pii'])
      .nullable()
      .optional(),
    justification: z.string().trim().min(1).max(2000),
  })
  .strict();
export type SubmitClassificationReviewInput = z.infer<typeof submitClassificationReviewInputSchema>;

export class W2ParityService {
  constructor(
    private readonly db: EvidenceDatabase,
    private readonly writer: Pick<EvidenceDatabase, 'rpc'> = db,
  ) {}

  private async rpc(name: string, args: Record<string, unknown>, signal?: AbortSignal) {
    const query = this.writer.rpc(name, args);
    const { data, error } = signal ? await query.abortSignal(signal) : await query;
    if (error) {
      throw new EvidenceError('database_unavailable', 503);
    }
    return data as Record<string, unknown>;
  }

  // ─── 1. ROPA Records ──────────────────────────────────────────────────
  async createRopaRecord(
    tenantId: string,
    actorId: string,
    input: CreateRopaRecordInput,
    correlationId: string = randomUUID(),
    signal?: AbortSignal,
  ) {
    const result = await this.rpc(
      'create_ropa_record',
      {
        p_tenant_id: tenantId,
        p_actor_id: actorId,
        p_estate_id: input.estateId ?? null,
        p_engagement_id: input.engagementId ?? null,
        p_purpose_name: input.purposeName,
        p_legal_basis: input.legalBasis,
        p_data_categories: input.dataCategories,
        p_data_principals: input.dataPrincipals,
        p_recipients: input.recipients,
        p_cross_border: input.crossBorderTransfers,
        p_destination_countries: input.destinationCountries,
        p_retention_months: input.retentionPeriodMonths,
        p_security_measures: input.securityMeasures,
        p_dpia_required: input.dpiaRequired,
        p_correlation_id: correlationId,
      },
      signal,
    );

    if (result.error === 'forbidden') {
      throw new EvidenceError('forbidden', 403);
    }
    if (result.error === 'estate_not_found') {
      throw new EvidenceError('estate_not_found', 404);
    }
    if (result.error === 'engagement_not_found') {
      throw new EvidenceError('engagement_not_found', 404);
    }
    if (result.error) {
      throw new EvidenceError(String(result.error), 400);
    }
    return result;
  }

  async listRopaRecords(tenantId: string, signal?: AbortSignal) {
    const query = this.db
      .from('ropa_records')
      .select('*')
      .eq('tenant_id', tenantId)
      .order('created_at', { ascending: false });
    const { data, error } = signal ? await query.abortSignal(signal) : await query;
    if (error) {
      throw new EvidenceError('database_unavailable', 503);
    }
    return data ?? [];
  }

  // ─── 2. Policy Drafts ─────────────────────────────────────────────────
  async createPolicyDraft(
    tenantId: string,
    actorId: string,
    input: CreatePolicyDraftInput,
    correlationId: string = randomUUID(),
    signal?: AbortSignal,
  ) {
    const result = await this.rpc(
      'create_policy_draft',
      {
        p_tenant_id: tenantId,
        p_actor_id: actorId,
        p_title: input.title,
        p_category: input.category,
        p_summary: input.summary,
        p_content: input.content,
        p_citations: input.controlCitations,
        p_correlation_id: correlationId,
      },
      signal,
    );

    if (result.error === 'forbidden') {
      throw new EvidenceError('forbidden', 403);
    }
    if (result.error) {
      throw new EvidenceError(String(result.error), 400);
    }
    return result;
  }

  async reviewPolicyDraft(
    tenantId: string,
    actorId: string,
    draftId: string,
    input: ReviewPolicyDraftInput,
    correlationId: string = randomUUID(),
    signal?: AbortSignal,
  ) {
    const result = await this.rpc(
      'review_policy_draft',
      {
        p_tenant_id: tenantId,
        p_actor_id: actorId,
        p_draft_id: draftId,
        p_decision: input.decision,
        p_expected_hash: input.expectedHash,
        p_correlation_id: correlationId,
      },
      signal,
    );

    if (result.error === 'founder_authority_required') {
      throw new EvidenceError('founder_authority_required', 403);
    }
    if (result.error === 'draft_not_found') {
      throw new EvidenceError('draft_not_found', 404);
    }
    if (result.error === 'digest_mismatch') {
      throw new EvidenceError('digest_mismatch', 409);
    }
    if (result.error === 'invalid_draft_state') {
      throw new EvidenceError('invalid_draft_state', 409);
    }
    if (result.error) {
      throw new EvidenceError(String(result.error), 400);
    }
    return result;
  }

  async listPolicyDrafts(tenantId: string, signal?: AbortSignal) {
    const query = this.db
      .from('policy_drafts')
      .select('*')
      .eq('tenant_id', tenantId)
      .order('created_at', { ascending: false });
    const { data, error } = signal ? await query.abortSignal(signal) : await query;
    if (error) {
      throw new EvidenceError('database_unavailable', 503);
    }
    return data ?? [];
  }

  // ─── 3. Playbook Entries ──────────────────────────────────────────────
  async createPlaybookEntry(
    tenantId: string,
    actorId: string,
    input: CreatePlaybookEntryInput,
    correlationId: string = randomUUID(),
    signal?: AbortSignal,
  ) {
    const result = await this.rpc(
      'create_playbook_entry',
      {
        p_tenant_id: tenantId,
        p_actor_id: actorId,
        p_title: input.title,
        p_kind: input.kind,
        p_trigger: input.triggerCondition,
        p_target_agent: input.targetAgent,
        p_steps: input.steps,
        p_requires_approval: input.requiresHumanApproval,
        p_correlation_id: correlationId,
      },
      signal,
    );

    if (result.error === 'forbidden') {
      throw new EvidenceError('forbidden', 403);
    }
    if (result.error) {
      throw new EvidenceError(String(result.error), 400);
    }
    return result;
  }

  async listPlaybookEntries(tenantId: string, signal?: AbortSignal) {
    const query = this.db
      .from('playbook_entries')
      .select('*')
      .eq('tenant_id', tenantId)
      .order('created_at', { ascending: false });
    const { data, error } = signal ? await query.abortSignal(signal) : await query;
    if (error) {
      throw new EvidenceError('database_unavailable', 503);
    }
    return data ?? [];
  }

  // ─── 4. Classification Reviews ────────────────────────────────────────
  async submitClassificationReview(
    tenantId: string,
    actorId: string,
    input: SubmitClassificationReviewInput,
    correlationId: string = randomUUID(),
    signal?: AbortSignal,
  ) {
    const result = await this.rpc(
      'submit_classification_review',
      {
        p_tenant_id: tenantId,
        p_actor_id: actorId,
        p_estate_id: input.estateId ?? null,
        p_system_id: input.systemId,
        p_resource_path: input.resourcePath,
        p_sensitivity_level: input.sensitivityLevel,
        p_categories: input.detectedCategories,
        p_confidence: input.confidenceScore,
        p_decision: input.decision,
        p_adjusted_sensitivity: input.adjustedSensitivity ?? null,
        p_justification: input.justification,
        p_correlation_id: correlationId,
      },
      signal,
    );

    if (result.error === 'forbidden') {
      throw new EvidenceError('forbidden', 403);
    }
    if (result.error === 'estate_not_found') {
      throw new EvidenceError('estate_not_found', 404);
    }
    if (result.error) {
      throw new EvidenceError(String(result.error), 400);
    }
    return result;
  }

  async listClassificationReviews(tenantId: string, signal?: AbortSignal) {
    const query = this.db
      .from('classification_reviews')
      .select('*')
      .eq('tenant_id', tenantId)
      .order('created_at', { ascending: false });
    const { data, error } = signal ? await query.abortSignal(signal) : await query;
    if (error) {
      throw new EvidenceError('database_unavailable', 503);
    }
    return data ?? [];
  }
}
