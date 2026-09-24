import { z } from 'zod';

/** Client roles an invitation may grant (C-W1-3). Internal roles are provisioned, never invited. */
export const InvitableRoleSchema = z.enum(['owner', 'admin', 'approver', 'reviewer', 'viewer']);
export type InvitableRole = z.infer<typeof InvitableRoleSchema>;

export const CreateInvitationRequestSchema = z
  .object({
    email: z.string().trim().toLowerCase().email().max(320),
    role: InvitableRoleSchema,
    approvalScopes: z.array(z.string().trim().min(1).max(64)).max(32).default([]),
    ttlHours: z.number().int().min(1).max(336).default(72),
  })
  .strict()
  .refine((v) => v.role === 'approver' || v.approvalScopes.length === 0, {
    message: 'Approval scopes apply only to approvers',
    path: ['approvalScopes'],
  });
export type CreateInvitationRequest = z.infer<typeof CreateInvitationRequestSchema>;

export const AcceptInvitationRequestSchema = z
  .object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) })
  .strict();

export const InvitationDeliverySchema = z.enum(['not_configured', 'pending', 'sent', 'failed']);

export const InvitationSchema = z.object({
  id: z.uuid(),
  tenant_id: z.uuid(),
  email: z.string(),
  role: InvitableRoleSchema,
  approval_scopes: z.array(z.string()),
  invited_by: z.uuid(),
  created_at: z.string(),
  expires_at: z.string(),
  accepted_at: z.string().nullable(),
  accepted_by: z.uuid().nullable(),
  revoked_at: z.string().nullable(),
  revoked_by: z.uuid().nullable(),
  delivery_status: InvitationDeliverySchema,
});
export type Invitation = z.infer<typeof InvitationSchema>;
