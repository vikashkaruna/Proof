import { z } from 'zod';
export const button = 'rounded border border-slate-300 px-3 py-2 text-sm disabled:opacity-50';
export const field = 'w-full min-w-0 rounded border border-slate-300 px-3 py-2 text-sm';
export const panel = 'min-w-0 space-y-4 rounded-xl border border-slate-200 bg-white p-5';
const messages: Record<string, string> = {
  forbidden: 'Your current role does not permit this action. Refresh to check your access.',
  report_not_found: 'This report is unavailable or you no longer have access to it.',
  pack_not_found: 'This evidence pack is unavailable or you no longer have access to it.',
  report_storage_unavailable:
    'The archive could not be verified in storage. Retry when storage is available. No file was downloaded.',
  evidence_version_unavailable:
    'A selected evidence version is unavailable. Refresh the evidence list before preparing a new pack.',
  provider_verification_failed:
    'Storage verification failed. No verified artifact can be offered. Refresh the recorded state before trying again.',
  pack_capacity_unavailable:
    'The archive builder is busy. Wait briefly, then refresh the recorded state before trying again.',
  pack_deadline_exceeded:
    'The operation timed out. Refresh its recorded state before trying again; it may already have started.',
  report_persistence_unconfirmed:
    'The saved outcome could not be confirmed. Refresh its recorded state before trying again.',
  pack_not_released:
    'This pack has not been released. A founder must review and release the retained archive first.',
  provenance_unavailable:
    'A selected version has no supported collection provenance. Choose verified human-submitted evidence.',
  pack_size_exceeded:
    'The selected evidence exceeds the pack size limit. Choose fewer or smaller files.',
  not_approved: 'This content needs founder approval before an archive can be built.',
  manifest_changed:
    'The recorded content differs from this view. Refresh and review the current content.',
  build_already_started:
    'An archive build has already started. Refresh its recorded state and use recovery if it is pending.',
  storage_configuration_changed:
    'The storage configuration has changed. Ask your administrator to check the recorded archive destination.',
  invalid_report_record:
    'One or more recorded reports could not be verified against the audit ledger. Refresh to reload the verified ledger.',
};
export const failure = (error: unknown) =>
  error instanceof z.ZodError
    ? 'The server returned unreadable records. Refresh to try again.'
    : error instanceof Error
      ? (messages[error.message] ?? error.message)
      : 'Unable to complete the request.';
