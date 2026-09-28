'use client';

import React, { useState } from 'react';
import { AgentIcon, Badge } from '@axiom/ui';
import { reportRequest } from './report-request';

export interface EmailDispatchModalProps {
  tenantId: string;
  isOpen: boolean;
  onClose: () => void;
  onDispatched?: () => void;
  target: {
    reportId?: string;
    dossierId?: string;
    title: string;
    kind: string;
    proofSealHash?: string;
  };
}

export function EmailDispatchModal({
  tenantId,
  isOpen,
  onClose,
  onDispatched,
  target,
}: EmailDispatchModalProps) {
  const [recipientEmail, setRecipientEmail] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [successMessage, setSuccessMessage] = useState('');

  if (!isOpen) return null;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!recipientEmail || !recipientEmail.includes('@')) {
      setError('Please provide a valid recipient email address.');
      return;
    }

    setBusy(true);
    setError('');
    setSuccessMessage('');

    try {
      const response = await reportRequest(tenantId, '/reports/email/dispatch', {
        body: {
          recipientEmail: recipientEmail.trim(),
          reportId: target.reportId,
          dossierId: target.dossierId,
          notes: notes.trim() || undefined,
        },
      });

      const result = (await response.json()) as {
        status: string;
        dispatchId?: string;
        providerMessageId?: string;
      };

      setSuccessMessage(
        `Email successfully queued (${result.status === 'simulated' ? 'Simulated Sandbox' : 'Delivered via Resend'}). Dispatch ID: ${result.dispatchId?.slice(0, 8)}`,
      );
      if (onDispatched) onDispatched();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Dispatch failed';
      setError(message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 backdrop-blur-xs p-4">
      <div
        className="w-full max-w-lg rounded-xl border border-slate-200 bg-white p-6 shadow-xl"
        role="dialog"
        aria-modal="true"
        aria-labelledby="dispatch-dialog-title"
      >
        <div className="flex items-center justify-between border-b border-slate-100 pb-3">
          <div className="flex items-center gap-2">
            <AgentIcon agent="pramaan" size="sm" state="idle" />
            <h2 id="dispatch-dialog-title" className="text-base font-semibold text-slate-900">
              Dispatch Statutory Compliance Report
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-slate-400 hover:text-slate-600 font-bold p-1"
            aria-label="Close dialog"
          >
            ✕
          </button>
        </div>

        <div className="mt-4 space-y-4">
          <div className="rounded-lg border border-slate-200 bg-slate-50/70 p-3.5 text-xs text-slate-700">
            <div className="flex items-center justify-between mb-1">
              <span className="font-semibold text-slate-900">{target.title}</span>
              {target.proofSealHash ? (
                <Badge variant="proof">Gold ProofSeal</Badge>
              ) : (
                <Badge variant="indigo">{target.kind.toUpperCase()}</Badge>
              )}
            </div>
            {target.proofSealHash && (
              <p className="font-mono text-[11px] text-amber-900 break-all mt-1">
                Seal: {target.proofSealHash}
              </p>
            )}
          </div>

          {/* Institutional Delivery Notice */}
          <div className="rounded-lg border border-teal-200 bg-teal-50/50 p-3 text-xs text-teal-900">
            <div className="font-semibold flex items-center gap-1.5 mb-1">
              <span className="h-2 w-2 rounded-full bg-teal-500 inline-block" />
              Verified Institutional Dispatch Architecture
            </div>
            <p className="text-[11px] text-teal-800 leading-relaxed">
              Dispatched from <strong>platform@axiomproof.ai</strong> with CC to{' '}
              <strong>sales@axiomproof.ai</strong> and BCC to{' '}
              <strong>founder@axiomminds.ai</strong>. Fully branded under Axiom Minds Private Limited
              and Axiom Proof compliance credentials.
            </p>
          </div>

          {successMessage ? (
            <div className="rounded-lg border border-green-200 bg-green-50 p-4 text-xs text-green-800 space-y-3">
              <p className="font-semibold">✓ Dispatch Succeeded</p>
              <p>{successMessage}</p>
              <div className="pt-2">
                <button
                  type="button"
                  onClick={onClose}
                  className="rounded-md bg-green-700 px-4 py-2 text-xs font-medium text-white hover:bg-green-800"
                >
                  Done
                </button>
              </div>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              {error && (
                <div className="rounded-md border border-red-200 bg-red-50 p-3 text-xs text-red-700">
                  {error}
                </div>
              )}

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  Recipient Email Address *
                </label>
                <input
                  type="email"
                  required
                  placeholder="e.g. dpo@organization.com or auditor@firm.com"
                  className="w-full rounded-md border border-slate-300 px-3 py-2 text-xs text-slate-900 placeholder-slate-400 focus:border-teal-500 focus:outline-none focus:ring-1 focus:ring-teal-500"
                  value={recipientEmail}
                  disabled={busy}
                  onChange={(e) => setRecipientEmail(e.target.value)}
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  Reviewer / DPO Notes (Included in Cover)
                </label>
                <textarea
                  rows={3}
                  maxLength={2000}
                  placeholder="e.g. Approved by Audit Committee for submission to Data Protection Board of India."
                  className="w-full rounded-md border border-slate-300 px-3 py-2 text-xs text-slate-900 placeholder-slate-400 focus:border-teal-500 focus:outline-none focus:ring-1 focus:ring-teal-500"
                  value={notes}
                  disabled={busy}
                  onChange={(e) => setNotes(e.target.value)}
                />
              </div>

              <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-100">
                <button
                  type="button"
                  onClick={onClose}
                  disabled={busy}
                  className="rounded-md border border-slate-300 bg-white px-4 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={busy || !recipientEmail}
                  className="rounded-md bg-teal-600 px-4 py-2 text-xs font-medium text-white hover:bg-teal-700 shadow-sm disabled:opacity-50"
                >
                  {busy ? 'Dispatching…' : 'Send via Verified Email'}
                </button>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
