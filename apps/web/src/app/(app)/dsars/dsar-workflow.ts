import { z } from 'zod';

export const dsarRowSchema = z.object({
  id: z.uuid(),
  kind: z.enum(['access', 'correction', 'erasure', 'nominate', 'portability']),
  status: z.enum([
    'received',
    'identity_verification',
    'in_fulfilment',
    'completed',
    'rejected',
    'escalated',
  ]),
  data_principal_name: z.string().nullable(),
  data_principal_email: z.string().nullable(),
  data_principal_phone: z.string().nullable(),
  identity_verified: z.boolean(),
  identity_verification_method: z.string().nullable(),
  due_by: z.iso.datetime({ offset: true }),
  received_at: z.iso.datetime({ offset: true }),
  completed_at: z.iso.datetime({ offset: true }).nullable(),
  rejection_reason: z.string().nullable(),
  notes: z.string().nullable(),
});
export type DsarRow = z.infer<typeof dsarRowSchema>;
export type DsarAction = 'verify' | 'in_fulfilment' | 'completed' | 'rejected' | 'escalated';

// Presentation hints only. The BFF and database authorize every action again.
export function availableActions(row: DsarRow): DsarAction[] {
  if (row.status === 'received') return ['verify', 'rejected'];
  if (row.status === 'identity_verification') {
    return [row.identity_verified ? 'in_fulfilment' : 'verify', 'rejected', 'escalated'];
  }
  if (row.status === 'in_fulfilment') return ['completed', 'rejected', 'escalated'];
  return [];
}

export function deadlineLabel(row: DsarRow, now: number): string {
  if (row.status === 'completed' || row.status === 'rejected') return 'Closed';
  const delta = Date.parse(row.due_by) - now;
  if (delta < 0) return 'Overdue';
  return `${Math.ceil(delta / 86400000)} day(s) remaining`;
}

export function intakeBody(form: FormData) {
  const field = (key: string) => String(form.get(key) ?? '').trim();
  if (!field('principalEmail') && !field('principalPhone'))
    throw new Error('A principal email or phone is required.');
  return {
    kind: field('kind'),
    principalName: field('principalName') || undefined,
    principalEmail: field('principalEmail') || undefined,
    principalPhone: field('principalPhone') || undefined,
    dueDays: 30,
    notes: field('notes') || undefined,
  };
}

export function actionBody(action: DsarAction, form: FormData) {
  const note = String(form.get('note') ?? '').trim();
  if (action === 'verify') {
    const method = String(form.get('method') ?? '').trim();
    if (!method || method.length > 120)
      throw new Error('Enter the verification method (up to 120 characters).');
    return { method };
  }
  if (action === 'rejected' && !note) throw new Error('A rejection reason is required.');
  if (note.length > 2000) throw new Error('The note must be at most 2,000 characters.');
  const evidenceId = String(form.get('fulfilmentEvidenceId') ?? '').trim();
  if (action === 'completed' && !z.uuid().safeParse(evidenceId).success)
    throw new Error('Enter a valid fulfilment evidence UUID.');
  return {
    toStatus: action,
    note: note || undefined,
    fulfilmentEvidenceId: action === 'completed' ? evidenceId : undefined,
  };
}

export async function postDsar(
  tenantId: string,
  path: string,
  body: unknown,
  idempotencyKey: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const response = await fetch(`/api/bff/v1/dsars${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-tenant-id': tenantId,
        'Idempotency-Key': idempotencyKey,
      },
      body: JSON.stringify(body),
    });
    const payload: unknown = await response.json().catch(() => null);
    const refusal = z.object({ error: z.object({ code: z.string() }) }).safeParse(payload);
    if (refusal.success) return { ok: false, error: refusal.data.error.code };
    if (!response.ok) return { ok: false, error: `http_${response.status}` };
    const accepted = z.object({ data: z.object({ dsarId: z.uuid() }) }).safeParse(payload);
    if (!accepted.success)
      return {
        ok: false,
        error: 'Response could not be confirmed. Refresh the records before retrying.',
      };
    return { ok: true };
  } catch {
    return {
      ok: false,
      error:
        'Connection lost. Refresh the records to check whether the action was recorded before retrying.',
    };
  }
}
