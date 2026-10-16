/** Pure, value-free diagnostics for the two registered website response boundaries. */
import { z } from 'zod';
const field = z.enum([
  'state',
  'tenantId',
  'actorId',
  'operationKey',
  'kind',
  'requestCodec',
  'requestText',
  'requestSha256',
  'snapshotCodec',
  'snapshotText',
  'snapshotSha256',
  'receipt',
  'id',
  'entryHash',
  'replayed',
  'estateId',
  'systemId',
  'rows',
  'nextCursor',
  'withdrawn',
  'inventoryCurrent',
  'index',
  'other',
]);
const code = z.enum([
  'invalid_type',
  'invalid_value',
  'invalid_format',
  'too_big',
  'too_small',
  'unrecognized_keys',
  'invalid_union',
  'invalid_key',
  'invalid_element',
  'not_multiple_of',
  'custom',
  'other',
]);
export const registeredResponseProbeSchema = z
  .object({
    version: z.literal(1),
    phase: z.enum(['target-submit', 'saved-targets']),
    stage: z.enum(['response-json', 'schema-parse']),
    errorClass: z.enum(['ZodError', 'SyntaxError', 'TypeError', 'Error', 'other']),
    mediaType: z.enum(['json', 'html', 'other', 'absent']),
    scope: z
      .object({
        tenantMatches: z.boolean(),
        actorMatches: z.boolean(),
        bodyKindMatches: z.boolean().nullable(),
        operationKeyMatches: z.boolean().nullable(),
      })
      .strict(),
    shape: z
      .object({
        topObject: z.boolean(),
        hasData: z.boolean(),
        hasError: z.boolean(),
        dataObject: z.boolean(),
        dataArray: z.boolean(),
        dataNull: z.boolean(),
        nestedData: z.boolean(),
        receiptObject: z.boolean(),
        rowsArray: z.boolean(),
        requestTextString: z.boolean(),
        snapshotTextString: z.boolean(),
      })
      .strict(),
    issues: z.array(z.object({ code, path: z.array(field).max(8) }).strict()).max(4),
  })
  .strict();
export type RegisteredResponseProbe = z.infer<typeof registeredResponseProbeSchema>;
const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
export function registeredResponseScope(
  headers: Record<string, string>,
  expected: { tenantId: string; actorId: string },
  bodyText?: string | null,
): RegisteredResponseProbe['scope'] {
  let body: Record<string, unknown> | undefined;
  try {
    body = object(JSON.parse(bodyText ?? 'null'));
  } catch {
    /* only match bits */
  }
  return {
    tenantMatches: headers['x-tenant-id'] === expected.tenantId,
    actorMatches: headers['x-expected-actor-id'] === expected.actorId,
    bodyKindMatches: bodyText == null ? null : body?.kind === 'register_target',
    operationKeyMatches:
      bodyText == null
        ? null
        : typeof body?.operationKey === 'string' &&
          headers['idempotency-key'] === body.operationKey,
  };
}
/** Run the original decode callback unchanged, and always rethrow its SAME error.
 * Diagnostic persistence failure must never replace or suppress that error. */
export async function probeRegisteredResponse<T>(
  response: { json(): Promise<unknown>; headers(): Record<string, string> },
  phase: RegisteredResponseProbe['phase'],
  scope: RegisteredResponseProbe['scope'],
  decode: (value: unknown) => T,
  retain: (probe: RegisteredResponseProbe) => void,
): Promise<T> {
  let stage: RegisteredResponseProbe['stage'] = 'response-json';
  let value: unknown;
  try {
    value = await response.json();
    stage = 'schema-parse';
    return decode(value);
  } catch (error) {
    try {
      const top = object(value),
        data = top?.data,
        row = object(data);
      const media = response.headers()['content-type']?.split(';', 1)[0]?.trim().toLowerCase();
      retain(
        registeredResponseProbeSchema.parse({
          version: 1,
          phase,
          stage,
          errorClass:
            error instanceof z.ZodError
              ? 'ZodError'
              : error instanceof SyntaxError
                ? 'SyntaxError'
                : error instanceof TypeError
                  ? 'TypeError'
                  : error instanceof Error
                    ? 'Error'
                    : 'other',
          mediaType: !media
            ? 'absent'
            : media === 'application/json' || /^application\/[a-z0-9.+-]+\+json$/.test(media)
              ? 'json'
              : media === 'text/html'
                ? 'html'
                : 'other',
          scope,
          shape: {
            topObject: !!top,
            hasData: !!top && Object.hasOwn(top, 'data'),
            hasError: !!top && Object.hasOwn(top, 'error'),
            dataObject: !!row,
            dataArray: Array.isArray(data),
            dataNull: data === null,
            nestedData: !!row && Object.hasOwn(row, 'data'),
            receiptObject: !!object(row?.receipt),
            rowsArray: Array.isArray(row?.rows),
            requestTextString: typeof row?.requestText === 'string',
            snapshotTextString: typeof row?.snapshotText === 'string',
          },
          issues:
            error instanceof z.ZodError
              ? error.issues.slice(0, 4).map((issue) => ({
                  code: code.safeParse(issue.code).success ? issue.code : 'other',
                  path: issue.path
                    .slice(0, 8)
                    .map((part) =>
                      typeof part === 'number'
                        ? 'index'
                        : field.safeParse(part).success
                          ? part
                          : 'other',
                    ),
                }))
              : [],
        }),
      );
    } catch {
      /* Original failure is authoritative, even if private IO fails. */
    }
    throw error;
  }
}
