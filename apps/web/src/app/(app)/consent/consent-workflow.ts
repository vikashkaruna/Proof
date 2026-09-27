import { z } from 'zod';

export const purposeSchema = z.object({
  id: z.uuid(),
  purpose_key: z.string(),
  name_en: z.string(),
  name_hi: z.string().nullable(),
  lawful_basis: z.enum(['consent', 'legitimate_uses']),
  notice_version: z.number().int().positive(),
  notice_en: z.string(),
  notice_hi: z.string().nullable(),
  is_active: z.boolean(),
});
export const recordSchema = z.object({
  id: z.uuid(),
  purpose_id: z.uuid(),
  principal_type: z.string(),
  principal_ref: z.string(),
  notice_version: z.number().int().positive(),
  notice_snapshot_sha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable()
    .optional(),
  language: z.enum(['en', 'hi']),
  channel: z.string(),
  status: z.enum(['granted', 'withdrawn']),
  granted_at: z.iso.datetime({ offset: true }),
  granted_by: z.uuid(),
  expires_at: z.iso.datetime({ offset: true }).nullable(),
  legal_hold: z.boolean(),
});
export const withdrawalSchema = z.object({
  id: z.uuid(),
  consent_record_id: z.uuid(),
  purpose_id: z.uuid(),
  principal_ref: z.string(),
  downstream_completed_at: z.string().nullable(),
  created_at: z.string(),
});
export const versionSchema = z.object({
  purpose_id: z.uuid(),
  notice_version: z.number().int().positive(),
  notice_en: z.string(),
  notice_hi: z.string().nullable(),
  snapshot_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  provenance: z.enum(['published', 'legacy_current']),
  created_at: z.string(),
});
export type Purpose = z.infer<typeof purposeSchema>;
export type ConsentRecord = z.infer<typeof recordSchema>;
export type Withdrawal = z.infer<typeof withdrawalSchema>;
export type NoticeVersion = z.infer<typeof versionSchema>;
export const listSchema = <T extends z.ZodType>(row: T) =>
  z.object({ data: z.array(row), meta: z.object({ hasMore: z.boolean() }) });

function mutationResult(path: string) {
  const uuid = z.uuid();
  const stamp = z.iso.datetime({ offset: true });
  let data: z.ZodType = z.never();
  if (path === '/purposes' || /^\/purposes\/[^/]+\/versions$/.test(path))
    data = z.object({ purpose_id: uuid, notice_version: z.number().int().positive() });
  else if (/^\/purposes\/[^/]+\/status$/.test(path))
    data = z.object({ purpose_id: uuid, is_active: z.boolean() });
  else if (path === '/records')
    data = z.object({
      consent_id: uuid,
      status: z.literal('granted'),
      notice_version: z.number().int().positive(),
      notice_snapshot_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    });
  else if (/^\/records\/[^/]+\/withdraw$/.test(path))
    data = z.object({ consent_id: uuid, withdrawal_id: uuid, withdrawn_at: stamp });
  else if (/^\/records\/[^/]+\/legal-hold$/.test(path))
    data = z.object({ consent_id: uuid, legal_hold: z.boolean() });
  else if (/^\/withdrawals\/[^/]+\/complete$/.test(path))
    data = z.object({ withdrawal_id: uuid, completed_at: stamp });
  return z.object({ data });
}

export async function consentRequest(
  tenantId: string,
  path: string,
  body?: unknown,
  key?: string,
  signal?: AbortSignal,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`/api/bff/v1/consent${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      signal,
      cache: 'no-store',
      headers: {
        'Content-Type': 'application/json',
        'x-tenant-id': tenantId,
        ...(key ? { 'Idempotency-Key': key } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    throw new Error(
      body === undefined
        ? 'Records could not be loaded. Refresh to retry.'
        : 'Connection lost. Refresh records to check whether the action was recorded before retrying.',
    );
  }
  const payload: unknown = await response.json().catch(() => null);
  const refusal = z.object({ error: z.object({ code: z.string() }) }).safeParse(payload);
  if (refusal.success) throw new Error(refusal.data.error.code);
  if (!response.ok) throw new Error(`Request failed (${response.status}).`);
  if (body !== undefined && !mutationResult(path).safeParse(payload).success)
    throw new Error('Response could not be confirmed. Refresh records before retrying.');
  return payload;
}

export function grantBody(form: FormData, purpose: Purpose | undefined, language: 'en' | 'hi') {
  if (!purpose?.is_active || purpose.lawful_basis !== 'consent')
    throw new Error('Select an active consent purpose.');
  if (!(language === 'hi' ? purpose.notice_hi : purpose.notice_en)?.trim())
    throw new Error('No reviewed notice is available in this language.');
  if (form.get('confirmed') !== 'on')
    throw new Error('Confirm the principal received this notice and consented.');
  const principalRef = String(form.get('principalRef') ?? '').trim();
  if (principalRef.length < 3 || principalRef.length > 320)
    throw new Error('Enter a principal identifier between 3 and 320 characters.');
  return {
    purposeId: purpose.id,
    expectedNoticeVersion: purpose.notice_version,
    principalType: String(form.get('principalType')),
    principalRef,
    language,
    channel: String(form.get('channel')),
  };
}
