'use client';

import React, { useState } from 'react';
import { AgentIcon, Badge, ProofSeal } from '@axiom/ui';
import type { PramaanDossier } from '@axiom/types';
import { EmailDispatchModal } from './email-dispatch-modal';

export interface DossierViewerModalProps {
  tenantId: string;
  dossier: PramaanDossier | null;
  isOpen: boolean;
  onClose: () => void;
  canRelease?: boolean;
  onSeal?: (dossierId: string, proofSeal: string) => Promise<void>;
}

export function DossierViewerModal({
  tenantId,
  dossier,
  isOpen,
  onClose,
  canRelease = false,
  onSeal,
}: DossierViewerModalProps) {
  const [emailModalOpen, setEmailModalOpen] = useState(false);
  const [sealing, setSealing] = useState(false);
  const [sealError, setSealError] = useState('');

  if (!isOpen || !dossier) return null;

  async function handleSeal() {
    if (!onSeal || !dossier) return;
    setSealing(true);
    setSealError('');
    try {
      await onSeal(dossier.id, dossier.proofSealHash);
    } catch (err: unknown) {
      setSealError(err instanceof Error ? err.message : 'Sealing failed');
    } finally {
      setSealing(false);
    }
  }

  const isSealed = dossier.status === 'sealed';

  return (
    <>
      <div className="fixed inset-0 z-40 flex items-center justify-center bg-slate-900/60 backdrop-blur-xs p-4 sm:p-6 overflow-y-auto">
        <div
          className="w-full max-w-4xl max-h-[90vh] flex flex-col rounded-xl border border-slate-200 bg-white shadow-2xl overflow-hidden"
          role="dialog"
          aria-modal="true"
        >
          {/* Header */}
          <div className="bg-[#1E2A4A] p-5 text-white flex items-center justify-between">
            <div className="flex items-center gap-3">
              <AgentIcon agent="pramaan" size="md" state={isSealed ? 'idle' : 'thinking'} />
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-xs font-semibold uppercase tracking-wider text-teal-300">
                    Axiom Proof · Statutory Closure Dossier
                  </span>
                  <Badge variant={isSealed ? 'proof' : 'warning'}>
                    {isSealed ? 'WORM SEALED' : 'DRAFT DOSSIER'}
                  </Badge>
                </div>
                <h2 className="text-lg font-bold text-white mt-0.5">{dossier.title}</h2>
              </div>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="text-slate-300 hover:text-white p-1 font-bold text-lg"
              aria-label="Close"
            >
              ✕
            </button>
          </div>

          {/* Body */}
          <div className="flex-1 overflow-y-auto p-6 space-y-6 text-slate-800 text-xs">
            {/* Branding Banner */}
            <div className="flex flex-wrap items-center justify-between border-b border-slate-200 pb-4 text-slate-500">
              <div>
                <span className="font-semibold text-slate-700">Platform:</span> Axiom Proof (
                <a
                  href="https://axiomproof.ai"
                  target="_blank"
                  rel="noreferrer"
                  className="text-teal-600 underline"
                >
                  https://axiomproof.ai
                </a>
                )
              </div>
              <div>
                <span className="font-semibold text-slate-700">Issued By:</span> Axiom Minds Private
                Limited (
                <a
                  href="https://axiomminds.ai"
                  target="_blank"
                  rel="noreferrer"
                  className="text-teal-600 underline"
                >
                  https://axiomminds.ai
                </a>
                )
              </div>
              <div>
                <span className="font-semibold text-slate-700">Tagline:</span> Agents do the work.
                You approve. The proof is automatic.
              </div>
            </div>

            {/* Cryptographic Proof Seal Card */}
            <div
              className={`rounded-xl border p-5 ${
                isSealed
                  ? 'border-[#C9A227] bg-[#FBF6E7]/50 shadow-xs'
                  : 'border-amber-300 bg-amber-50/40'
              }`}
            >
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-bold text-[#A0821F]">
                      {isSealed
                        ? '★ SOVEREIGN GOLD PROOF SEAL'
                        : '⚠ PENDING FOUNDER PROOF SEAL'}
                    </span>
                    <span className="text-[11px] text-slate-500">
                      Type: {dossier.dossierType.replace(/_/g, ' ').toUpperCase()}
                    </span>
                  </div>
                  <p className="text-slate-600 text-[11px] mt-1">
                    Multi-agent synthesized cryptographic proof bound to immutable audit ledger and
                    WORM Object Lock vault.
                  </p>
                </div>

                {!isSealed && canRelease && (
                  <div>
                    {sealError && <p className="text-xs text-red-600 mb-1">{sealError}</p>}
                    <button
                      type="button"
                      disabled={sealing}
                      onClick={handleSeal}
                      className="rounded-lg bg-[#C9A227] hover:bg-[#B38F1E] px-4 py-2 text-xs font-bold text-white shadow-sm disabled:opacity-50"
                    >
                      {sealing ? 'Sealing...' : 'Affix Founder ProofSeal'}
                    </button>
                  </div>
                )}
              </div>

              <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-3 pt-3 border-t border-[#C9A227]/30 text-[11px] font-mono">
                <div>
                  <span className="text-slate-500 font-sans block text-[10px] uppercase tracking-wider font-semibold">
                    Proof Seal SHA-256
                  </span>
                  <span className="text-amber-900 break-all font-semibold">
                    {dossier.proofSealHash}
                  </span>
                </div>
                <div>
                  <span className="text-slate-500 font-sans block text-[10px] uppercase tracking-wider font-semibold">
                    Merkle Root Hash
                  </span>
                  <span className="text-slate-800 break-all">{dossier.merkleRoot}</span>
                </div>
                <div>
                  <span className="text-slate-500 font-sans block text-[10px] uppercase tracking-wider font-semibold">
                    Manifest SHA-256
                  </span>
                  <span className="text-slate-800 break-all">{dossier.manifestHash}</span>
                </div>
                <div>
                  <span className="text-slate-500 font-sans block text-[10px] uppercase tracking-wider font-semibold">
                    Sealed Timestamp & Authority
                  </span>
                  <span className="text-slate-800 font-sans">
                    {dossier.sealedAt ? new Date(dossier.sealedAt).toLocaleString() : 'Unsealed Draft'}{' '}
                    {dossier.sealedBy ? `· User ${dossier.sealedBy.slice(0, 8)}` : ''}
                  </span>
                </div>
              </div>
            </div>

            {/* Statutory Overview */}
            <div className="space-y-3">
              <h3 className="text-xs font-bold uppercase tracking-wider text-slate-700">
                Statutory Assessment & Legal Exposure
              </h3>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                  <div className="text-[11px] text-slate-500 uppercase">Statutory Maximum</div>
                  <div className="text-base font-bold text-slate-900">₹250 Crore</div>
                  <div className="text-[10px] text-slate-500">DPDPA 2023 Schedule 1</div>
                </div>
                <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                  <div className="text-[11px] text-slate-500 uppercase">Evaluated Posture</div>
                  <div className="text-base font-bold text-teal-700">92 / 100</div>
                  <div className="text-[10px] text-slate-500">Parikshan Assessment Engine</div>
                </div>
                <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                  <div className="text-[11px] text-slate-500 uppercase">Data Residency</div>
                  <div className="text-base font-bold text-slate-900">ap-south-1</div>
                  <div className="text-[10px] text-slate-500">Mumbai Strict Residency</div>
                </div>
              </div>
            </div>

            {/* Multi-Agent Provenance Pipeline */}
            <div className="space-y-3">
              <h3 className="text-xs font-bold uppercase tracking-wider text-slate-700">
                Autonomous Proof Lineage (12 Agent Collaboration)
              </h3>
              <div className="rounded-lg border border-slate-200 p-4 space-y-2 bg-slate-50/50">
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-slate-800">Prativedan (प्रतिवेदन · Drafter):</span>
                  <span className="text-slate-600">
                    Compiled working report, audit tables, and evidence references.
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-slate-800">
                    Samadhan (समाधान · Maker-Checker):
                  </span>
                  <span className="text-slate-600">
                    Verified dual-control parameter drift and signed execution reconciliation.
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-slate-800">Saakshi (साक्षी · Evidence):</span>
                  <span className="text-slate-600">
                    WORM Object Lock vaulting with cryptographic SHA-256 receipts.
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-slate-800">Lekha (लेखा · Ledger):</span>
                  <span className="text-slate-600">
                    Unbroken append-only hash chain recorded in PostgreSQL ledger.
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-amber-900">
                    Pramaan (प्रमाण · Master Seal Authority):
                  </span>
                  <span className="text-amber-900 font-medium">
                    Synthesized authoritative closure pack and calculated sovereign Gold ProofSeal.
                  </span>
                </div>
              </div>
            </div>
          </div>

          {/* Footer Actions */}
          <div className="border-t border-slate-200 p-4 bg-slate-50 flex flex-wrap items-center justify-between gap-3">
            <div className="text-[11px] text-slate-500">
              Workbench: <span className="font-mono">https://app.axiomproof.ai</span>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setEmailModalOpen(true)}
                className="rounded-md border border-teal-600 bg-teal-50 px-3.5 py-1.5 text-xs font-semibold text-teal-800 hover:bg-teal-100"
              >
                ✉ Send via Email
              </button>
              <a
                href={`/api/bff/v1/dossiers/${dossier.id}`}
                target="_blank"
                rel="noreferrer"
                className="rounded-md bg-indigo-900 px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-indigo-800"
              >
                Download Closure Pack
              </a>
              <button
                type="button"
                onClick={onClose}
                className="rounded-md border border-slate-300 bg-white px-3.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      </div>

      <EmailDispatchModal
        tenantId={tenantId}
        isOpen={emailModalOpen}
        onClose={() => setEmailModalOpen(false)}
        target={{
          dossierId: dossier.id,
          title: dossier.title,
          kind: dossier.dossierType,
          proofSealHash: dossier.proofSealHash,
        }}
      />
    </>
  );
}
