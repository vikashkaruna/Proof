import { z } from 'zod';
const buttonBase =
  'inline-flex min-h-10 max-w-full items-center justify-center gap-2 rounded-md border px-3 py-2 text-center text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50';
export const button = `${buttonBase} border-slate-300 bg-white text-slate-700 hover:bg-mist-100`;
export const primaryButton = `${buttonBase} border-indigo-500 bg-indigo-500 text-white hover:bg-indigo-600`;
export const approvalButton = `${buttonBase} border-teal-500 bg-teal-500 text-indigo-900 hover:bg-teal-400`;
export const dangerButton = `${buttonBase} border-ember-600 bg-white text-ember-700 hover:bg-ember-50`;
export const field = 'w-full min-w-0 rounded border border-slate-300 px-3 py-2 text-sm';
export const panel = 'min-w-0 space-y-4 rounded-xl border border-slate-200 bg-white p-5';
const messages: Record<string, string> = {
  owner_coverage_explanation_required:
    'An owner must record explanations for incomplete public-page coverage in the assessment’s Public source review before a new report can be requested. These explanations remain unverified; existing reports are preserved.',
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
