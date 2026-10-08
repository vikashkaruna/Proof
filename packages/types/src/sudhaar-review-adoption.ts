import { z } from 'zod';
import { sudhaarSourceSchema, sudhaarReviewTaskSchema } from './sudhaar-proposal';
const uuid = z.uuid().transform((value) => value.toLowerCase());
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const receipt = z
  .string()
  .regex(/^[1-9][0-9]{0,18}$/)
  .refine((value) => /^[1-9][0-9]{0,18}$/.test(value) && BigInt(value) <= 9223372036854775807n);
export const sudhaarReviewAdoptionRequestSchema = z
  .object({
    adoptionKey: uuid,
    acknowledgeReviewOnly: z.literal(true),
    reason: z.string().trim().min(20).max(2000),
  })
  .strict();
export type SudhaarReviewAdoptionRequest = z.infer<typeof sudhaarReviewAdoptionRequestSchema>;
export const sudhaarReviewAdoptionReceiptSchema = z
  .object({
    tenantId: uuid,
    actorId: uuid,
    proposalOperationKey: uuid,
    adoptionKey: uuid,
    planId: uuid,
    requestHash: hash,
    adoptionReceipt: receipt,
    purpose: z.literal('source_review'),
    status: z.literal('review'),
    taskCount: z.number().int().min(1).max(500),
    actionCount: z.literal(0),
    executionAllowed: z.literal(false),
    source: sudhaarSourceSchema,
    outputProof: z
      .object({
        runId: uuid,
        inputHash: hash,
        outputHash: hash,
        requestedReceipt: receipt,
        startedReceipt: receipt,
        completedReceipt: receipt,
        settledReceipt: receipt,
      })
      .strict(),
  })
  .strict()
  .superRefine((value, context) => {
    const proof = value.outputProof;
    if (
      [
        proof.requestedReceipt,
        proof.startedReceipt,
        proof.completedReceipt,
        proof.settledReceipt,
        value.adoptionReceipt,
      ].some((value) => !receipt.safeParse(value).success)
    )
      return;
    if (!(
      BigInt(proof.requestedReceipt) < BigInt(proof.startedReceipt) &&
      BigInt(proof.startedReceipt) < BigInt(proof.completedReceipt) &&
      BigInt(proof.completedReceipt) < BigInt(proof.settledReceipt) &&
      BigInt(proof.settledReceipt) < BigInt(value.adoptionReceipt)
    ))
      context.addIssue({ code: 'custom', message: 'Review adoption receipts are inconsistent' });
  });
export type SudhaarReviewAdoptionReceipt = z.infer<typeof sudhaarReviewAdoptionReceiptSchema>;
/** Persisted human review work remains separate from corrective action authority. */
export const persistedSudhaarReviewTasksSchema = z
  .array(sudhaarReviewTaskSchema)
  .min(1)
  .max(500)
  .superRefine((value, context) => {
    if (
      new Set(value.map((task) => task.sequence)).size !== value.length ||
      new Set(value.map((task) => task.finding_id)).size !== value.length ||
      value.some((task) => task.sequence > value.length)
    )
      context.addIssue({
        code: 'custom',
        message: 'Recorded review tasks are incomplete or ambiguous',
      });
  });
