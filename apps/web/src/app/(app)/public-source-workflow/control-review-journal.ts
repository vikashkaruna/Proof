import { z } from 'zod';
import { canonicalJson } from '@axiom/ledger';
import {
  parsePublicControlReviewSetRequestText,
  PUBLIC_CONTROL_REVIEW_MAX_BYTES,
} from '@axiom/types';

const uuid = z.uuid().transform((value) => value.toLowerCase());
export const controlReviewOperationSchema = z
  .object({
    tenantId: uuid,
    actorId: uuid,
    requestText: z.string().min(2).max(PUBLIC_CONTROL_REVIEW_MAX_BYTES),
  })
  .strict()
  .superRefine((value, ctx) => {
    try {
      parsePublicControlReviewSetRequestText(value.requestText);
    } catch {
      ctx.addIssue({ code: 'custom', message: 'Retained human review request is invalid' });
    }
  });
export type ControlReviewOperation = z.infer<typeof controlReviewOperationSchema>;
function prefix(tenantId: string, actorId: string) {
  return `axiom.public-control-review.operation.v1:${uuid.parse(tenantId)}:${uuid.parse(actorId)}:`;
}
function key(operation: ControlReviewOperation) {
  const request = parsePublicControlReviewSetRequestText(operation.requestText);
  return prefix(operation.tenantId, operation.actorId) + request.operationKey;
}
/** Independent immutable entries avoid one tab replacing another's unknown request.
 * This does not claim an atomic cross-tab mutex on browsers without Web Locks. */
export function readControlReviewOperations(storage: Storage, tenantId: string, actorId: string) {
  const start = prefix(tenantId, actorId),
    values: ControlReviewOperation[] = [];
  if (storage.length > 10000)
    throw new Error('Browser request storage cannot be inspected safely.');
  for (let index = 0; index < storage.length; index++) {
    const name = storage.key(index);
    if (!name?.startsWith(start)) continue;
    const raw = storage.getItem(name);
    if (raw === null) continue;
    if (new TextEncoder().encode(raw).byteLength > PUBLIC_CONTROL_REVIEW_MAX_BYTES * 2 + 1024)
      throw new Error('Retained review storage exceeds supported bounds.');
    const value = controlReviewOperationSchema.parse(JSON.parse(raw));
    if (
      value.tenantId !== tenantId.toLowerCase() ||
      value.actorId !== actorId.toLowerCase() ||
      key(value) !== name ||
      canonicalJson(value) !== raw
    )
      throw new Error('Retained review storage does not match its scope.');
    values.push(value);
    if (values.length > 128)
      throw new Error('Reconcile retained review requests before continuing.');
  }
  return values;
}
export function retainControlReviewOperation(storage: Storage, operation: ControlReviewOperation) {
  const value = controlReviewOperationSchema.parse(operation);
  const old = readControlReviewOperations(storage, value.tenantId, value.actorId);
  if (old.length)
    throw new Error('Reconcile the retained human review request before recording another.');
  const text = canonicalJson(value),
    name = key(value);
  if (storage.getItem(name) !== null)
    throw new Error('Another review request already owns this key.');
  storage.setItem(name, text);
  if (storage.getItem(name) !== text)
    throw new Error('Review request could not be retained. Nothing was sent.');
  const current = readControlReviewOperations(storage, value.tenantId, value.actorId);
  if (current.length !== 1 || canonicalJson(current[0]) !== text)
    throw new Error('Concurrent review requests are retained. Reconcile them before dispatch.');
  return value;
}
export function assertControlReviewOperation(storage: Storage, operation: ControlReviewOperation) {
  const value = controlReviewOperationSchema.parse(operation);
  // Also reject corrupt sibling entries; never remove or overwrite them.
  readControlReviewOperations(storage, value.tenantId, value.actorId);
  if (storage.getItem(key(value)) !== canonicalJson(value))
    throw new Error('Retained review request changed. Reload before continuing.');
}
/** Call only after positively verified recorded or cancelled receipt readback. */
export function clearResolvedControlReviewOperation(
  storage: Storage,
  operation: ControlReviewOperation,
) {
  assertControlReviewOperation(storage, operation);
  const name = key(operation);
  storage.removeItem(name);
  if (storage.getItem(name) !== null)
    throw new Error(
      'The resolved browser reference could not be cleared. Reconcile its saved receipt.',
    );
}
