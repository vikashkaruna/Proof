'use client';
import React, { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { canonicalJson } from '@axiom/ledger';
import type { SudhaarReviewAdoptionReceipt } from '@axiom/types';
import type { ConfirmedProposal } from './proposal-request';
import {
  REVIEW_ADOPTION_CHANGED,
  readReviewAdoptionJournal,
  retainReviewAdoptionJournal,
  reviewAdoptionJournalKey,
  submitReviewAdoption,
  type ReviewAdoptionJournal,
} from './review-adoption-request';
export function ReviewAdoptionPanel(props: {
  tenantId: string;
  actorId: string;
  operationKey: string;
  confirmed: ConfirmedProposal;
  onPending?: (pending: boolean) => void;
}) {
  return <Panel key={`${props.tenantId}:${props.actorId}:${props.operationKey}`} {...props} />;
}
function Panel({
  tenantId,
  actorId,
  operationKey,
  confirmed,
  onPending,
}: Parameters<typeof ReviewAdoptionPanel>[0]) {
  const [retained, setRetained] = useState<ReviewAdoptionJournal | null>(null),
    [ready, setReady] = useState(false),
    [reason, setReason] = useState(''),
    [ack, setAck] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null),
    [saved, setSaved] = useState<SudhaarReviewAdoptionReceipt | null>(null);
  const mounted = useRef(true),
    active = useRef(false);
  const key = reviewAdoptionJournalKey(tenantId, actorId);
  useEffect(() => {
    mounted.current = true;
    const refresh = () => {
      try {
        setRetained(readReviewAdoptionJournal(localStorage, tenantId, actorId));
        setReady(true);
      } catch {
        setReady(false);
        setError('The retained review request is unavailable. Preserve it for review.');
      }
    };
    const storage = (event: StorageEvent) => {
      if (event.key === null || event.key === key) refresh();
    };
    refresh();
    window.addEventListener('storage', storage);
    window.addEventListener(REVIEW_ADOPTION_CHANGED, refresh);
    return () => {
      mounted.current = false;
      window.removeEventListener('storage', storage);
      window.removeEventListener(REVIEW_ADOPTION_CHANGED, refresh);
    };
  }, [tenantId, actorId, key]);
  useEffect(() => {
    onPending?.((!!retained || busy) && !saved);
  }, [onPending, retained, busy, saved]);
  const submit = async () => {
    if (active.current || !ready || saved) return;
    active.current = true;
    setBusy(true);
    setError(null);
    try {
      if (!navigator.locks)
        throw new Error('Cross-tab request protection is unavailable. Use a supported browser.');
      await navigator.locks.request(key, { ifAvailable: true }, async (lock) => {
        if (!lock)
          throw new Error(
            'Another tab is saving review work. Wait and check the retained request.',
          );
        if (!mounted.current) return;
        const current = readReviewAdoptionJournal(localStorage, tenantId, actorId);
        if (
          current?.proposalOperationKey !== undefined &&
          current.proposalOperationKey !== operationKey
        )
          throw new Error(
            'A different review request remains pending. Return to that proposal to confirm it.',
          );
        if (retained && canonicalJson(retained) !== canonicalJson(current))
          throw new Error('The retained request changed in another tab. Check it before retrying.');
        const value = current ?? {
          version: 1 as const,
          tenantId,
          actorId,
          proposalOperationKey: operationKey,
          request: { adoptionKey: crypto.randomUUID(), acknowledgeReviewOnly: ack as true, reason },
        };
        const exact = retainReviewAdoptionJournal(localStorage, value);
        if (!mounted.current) return;
        const receipt = await submitReviewAdoption(exact);
        if (!mounted.current) return;
        if (
          canonicalJson(readReviewAdoptionJournal(localStorage, tenantId, actorId)) !==
          canonicalJson(exact)
        )
          throw new Error('The retained request changed while saving. Keep it for review.');
        const proof = confirmed.outputProof;
        if (
          canonicalJson(receipt.source) !== canonicalJson(confirmed.proposal.source) ||
          receipt.taskCount !== confirmed.proposal.review_tasks.length ||
          receipt.outputProof.runId !== proof.runId ||
          receipt.outputProof.inputHash !== proof.requestHash ||
          receipt.outputProof.outputHash !== proof.responseHash ||
          receipt.outputProof.requestedReceipt !== proof.requestedReceipt ||
          receipt.outputProof.startedReceipt !== proof.startedReceipt ||
          receipt.outputProof.completedReceipt !== proof.completedReceipt ||
          receipt.outputProof.settledReceipt !== proof.settledReceipt
        )
          throw new Error(
            'The saved review source could not be confirmed. Keep the retained request.',
          );
        setSaved(receipt);
      });
    } catch (cause) {
      if (mounted.current)
        setError(
          cause instanceof Error
            ? cause.message
            : 'Review work is unconfirmed. Keep the retained request.',
        );
    } finally {
      active.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  return (
    <section aria-label="Save review work" className="space-y-3 rounded-md border p-4">
      <h4 className="font-semibold">Save tasks for human review</h4>
      <p>
        This records review tasks and their source receipt. It does not create corrective actions,
        close findings, approve changes or permit execution.
      </p>
      {saved ? (
        <p role="status">
          Saved {saved.taskCount} review tasks · 0 corrective actions · Receipt{' '}
          {saved.adoptionReceipt}.{' '}
          <Link href={`/plans/${saved.planId}`}>Inspect saved review work</Link>
        </p>
      ) : (
        <>
          {retained ? (
            <p>
              The original review request is retained. Retry confirms the same saved work without
              creating a second plan.
            </p>
          ) : (
            <>
              <label className="block">
                Reason for saving this review
                <textarea
                  value={reason}
                  disabled={busy}
                  onChange={(event) => setReason(event.target.value)}
                  minLength={20}
                  maxLength={2000}
                  className="mt-1 block w-full rounded-md border p-2"
                />
              </label>
              <label className="flex gap-2">
                <input
                  type="checkbox"
                  checked={ack}
                  disabled={busy}
                  onChange={(event) => setAck(event.target.checked)}
                />
                I understand these are review tasks with no execution authority.
              </label>
            </>
          )}
          <button
            type="button"
            disabled={
              !ready ||
              busy ||
              (!retained && (!ack || reason.trim().length < 20)) ||
              (!!retained && retained.proposalOperationKey !== operationKey)
            }
            onClick={() => void submit()}
            className="rounded-md border px-3 py-2"
          >
            {busy
              ? 'Confirming review work…'
              : retained
                ? 'Retry retained review request'
                : 'Save review tasks'}
          </button>
        </>
      )}
      {error && (
        <p role="alert" className="rounded-md border border-red-200 p-3">
          {error}
        </p>
      )}
    </section>
  );
}
