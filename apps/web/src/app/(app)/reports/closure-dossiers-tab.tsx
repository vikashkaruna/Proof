'use client';

import React, { useEffect, useState, useCallback } from 'react';
import { AgentIcon, Badge, ProofSeal } from '@axiom/ui';
import type { PramaanDossier, DossierType } from '@axiom/types';
import { reportRequest } from './report-request';
import { DossierViewerModal } from './dossier-viewer-modal';
import { EmailDispatchModal } from './email-dispatch-modal';

export interface ClosureDossiersTabProps {
  tenantId: string;
  canRelease: boolean;
  canPrepare: boolean;
}

export function ClosureDossiersTab({ tenantId, canRelease, canPrepare }: ClosureDossiersTabProps) {
  const [dossiers, setDossiers] = useState<PramaanDossier[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selectedDossier, setSelectedDossier] = useState<PramaanDossier | null>(null);
  const [emailTarget, setEmailTarget] = useState<PramaanDossier | null>(null);

  // Synthesize form state
  const [showSynthesize, setShowSynthesize] = useState(false);
  const [title, setTitle] = useState('');
  const [dossierType, setDossierType] = useState<DossierType>('board_executive');
  const [engagementId, setEngagementId] = useState('');
  const [synthesizing, setSynthesizing] = useState(false);
  const [synthesizeError, setSynthesizeError] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    void reportRequest(tenantId, '/dossiers?limit=25', { signal: controller.signal })
      .then((res) => res.json())
      .then((data: unknown) => {
        if (!controller.signal.aborted) {
          const parsed = data as { dossiers?: PramaanDossier[] };
          setDossiers(parsed.dossiers || []);
        }
      })
      .catch((err: unknown) => {
        if (!controller.signal.aborted) {
          setError(err instanceof Error ? err.message : 'Unable to load dossiers');
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setLoading(false);
        }
      });
    return () => controller.abort();
  }, [tenantId]);

  const refreshDossiers = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await reportRequest(tenantId, '/dossiers?limit=25');
      const data = (await res.json()) as { dossiers?: PramaanDossier[] };
      setDossiers(data.dossiers || []);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Unable to load dossiers');
    } finally {
      setLoading(false);
    }
  }, [tenantId]);

  async function handleSynthesize(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) {
      setSynthesizeError('Title is required');
      return;
    }
    // Fallback uuid if none entered
    const targetEngagement = engagementId.trim() || '11111111-1111-4111-8111-111111111111';

    setSynthesizing(true);
    setSynthesizeError('');

    try {
      const res = await reportRequest(
        tenantId,
        `/engagements/${targetEngagement}/closure/pramaan`,
        {
          body: {
            dossierType,
            title: title.trim(),
            metadata: {
              synthesizedVia: 'workbench_reports',
              timestamp: new Date().toISOString(),
            },
          },
        },
      );
      const newDossier = (await res.json()) as PramaanDossier;
      setShowSynthesize(false);
      setTitle('');
      await refreshDossiers();
      setSelectedDossier(newDossier);
    } catch (err: unknown) {
      setSynthesizeError(err instanceof Error ? err.message : 'Synthesis failed');
    } finally {
      setSynthesizing(false);
    }
  }

  async function handleSealDossier(dossierId: string, proofSeal: string) {
    await reportRequest(tenantId, `/dossiers/${dossierId}/seal`, {
      body: { expectedProofSeal: proofSeal },
    });
    await refreshDossiers();
    if (selectedDossier && selectedDossier.id === dossierId) {
      setSelectedDossier({
        ...selectedDossier,
        status: 'sealed',
        sealedAt: new Date().toISOString(),
      });
    }
  }

  return (
    <div className="space-y-6">
      {/* Banner / Header */}
      <div className="rounded-xl border border-[#C9A227]/40 bg-gradient-to-r from-[#FBF6E7] to-white p-5 shadow-xs">
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
          <div className="flex items-start gap-3">
            <AgentIcon agent="pramaan" size="md" state="idle" />
            <div>
              <div className="flex items-center gap-2">
                <span className="text-xs font-bold uppercase tracking-wider text-[#A0821F]">
                  Pramaan · प्रमाण · Statutory Closure & Proof Attestation
                </span>
                <Badge variant="proof">Level 1 Authority</Badge>
              </div>
              <h2 className="text-base font-bold text-slate-900 mt-0.5">
                Statutory Proof Dossiers & Sovereign Seal
              </h2>
              <p className="text-xs text-slate-600 mt-1 max-w-2xl">
                Master synthesis authority for the CLOSURE phase. Aggregates findings, remediation
                actions, Samadhan maker-checker certificates, Saakshi WORM evidence, and Lekha audit
                ledger roots into authoritative, offline-verifiable proof packs.
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={() => setShowSynthesize(true)}
            className="rounded-lg bg-[#1E2A4A] px-4 py-2 text-xs font-semibold text-white shadow-sm hover:bg-[#2B3A60] transition-colors self-start md:self-auto"
          >
            + Synthesize Closure Dossier
          </button>
        </div>
      </div>

      {/* Synthesis Modal */}
      {showSynthesize && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 backdrop-blur-xs p-4">
          <div className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-6 shadow-xl">
            <div className="flex items-center justify-between border-b border-slate-100 pb-3">
              <div className="flex items-center gap-2">
                <AgentIcon agent="pramaan" size="sm" state="working" />
                <h3 className="text-sm font-bold text-slate-900">
                  Synthesize Statutory Closure Dossier
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setShowSynthesize(false)}
                className="text-slate-400 hover:text-slate-600 font-bold p-1"
              >
                ✕
              </button>
            </div>

            <form onSubmit={handleSynthesize} className="mt-4 space-y-4">
              {synthesizeError && (
                <div className="rounded-md border border-red-200 bg-red-50 p-2 text-xs text-red-700">
                  {synthesizeError}
                </div>
              )}

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  Dossier Title *
                </label>
                <input
                  type="text"
                  required
                  placeholder="e.g. FY2026 Annual Statutory DPDPA Proof Dossier"
                  className="w-full rounded-md border border-slate-300 px-3 py-2 text-xs text-slate-900 focus:border-teal-500 focus:outline-none focus:ring-1 focus:ring-teal-500"
                  value={title}
                  disabled={synthesizing}
                  onChange={(e) => setTitle(e.target.value)}
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  Dossier Format / Target *
                </label>
                <select
                  className="w-full rounded-md border border-slate-300 px-3 py-2 text-xs text-slate-900 focus:border-teal-500 focus:outline-none focus:ring-1 focus:ring-teal-500"
                  value={dossierType}
                  disabled={synthesizing}
                  onChange={(e) => setDossierType(e.target.value as DossierType)}
                >
                  <option value="board_executive">Board Executive Closure Pack</option>
                  <option value="dpb_statutory">DPB Statutory Submission Dossier</option>
                  <option value="auditor_assurance">Independent Auditor Assurance Pack</option>
                  <option value="technical_register">Technical Remediation Register</option>
                  <option value="full_closure">Comprehensive Full Closure Dossier</option>
                </select>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  Engagement UUID (Optional, defaults to active engagement)
                </label>
                <input
                  type="text"
                  placeholder="11111111-1111-4111-8111-111111111111"
                  className="w-full rounded-md border border-slate-300 px-3 py-2 text-xs text-slate-900 focus:border-teal-500 focus:outline-none focus:ring-1 focus:ring-teal-500 font-mono"
                  value={engagementId}
                  disabled={synthesizing}
                  onChange={(e) => setEngagementId(e.target.value)}
                />
              </div>

              <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-100">
                <button
                  type="button"
                  onClick={() => setShowSynthesize(false)}
                  disabled={synthesizing}
                  className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={synthesizing}
                  className="rounded-md bg-teal-600 px-4 py-1.5 text-xs font-semibold text-white hover:bg-teal-700 shadow-sm disabled:opacity-50"
                >
                  {synthesizing ? 'Synthesizing…' : 'Synthesize Dossier'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Dossiers List */}
      <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-xs">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-semibold text-slate-900">
            Historical Statutory Dossiers ({dossiers.length})
          </h3>
          <button
            type="button"
            onClick={() => void refreshDossiers()}
            disabled={loading}
            className="text-xs text-teal-600 hover:text-teal-800 font-medium"
          >
            Refresh
          </button>
        </div>

        {loading ? (
          <p className="text-xs text-slate-500 py-6 text-center">Loading statutory dossiers…</p>
        ) : error ? (
          <p className="text-xs text-red-600 py-4">{error}</p>
        ) : dossiers.length === 0 ? (
          <div className="text-center py-8 border border-dashed border-slate-200 rounded-lg">
            <p className="text-xs text-slate-500">No closure dossiers synthesized yet.</p>
            <button
              type="button"
              onClick={() => setShowSynthesize(true)}
              className="mt-2 text-xs font-semibold text-teal-600 hover:underline"
            >
              Synthesize your first closure dossier
            </button>
          </div>
        ) : (
          <div className="divide-y divide-slate-100">
            {dossiers.map((dossier) => {
              const isSealed = dossier.status === 'sealed';
              return (
                <div
                  key={dossier.id}
                  className="py-3.5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 hover:bg-slate-50/50 px-2 rounded-lg transition-colors"
                >
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-slate-900 text-xs">{dossier.title}</span>
                      <Badge variant={isSealed ? 'proof' : 'warning'}>
                        {isSealed ? 'WORM SEALED' : 'DRAFT'}
                      </Badge>
                      <span className="text-[11px] text-slate-500 uppercase">
                        {dossier.dossierType.replace(/_/g, ' ')}
                      </span>
                    </div>
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-slate-500">
                      <span>Created: {new Date(dossier.createdAt).toLocaleDateString()}</span>
                      <span className="font-mono">
                        ProofSeal: {dossier.proofSealHash.slice(0, 16)}…
                      </span>
                      {dossier.sealedAt && (
                        <span className="text-amber-800 font-medium">
                          Sealed: {new Date(dossier.sealedAt).toLocaleDateString()}
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center gap-2 self-start sm:self-auto">
                    <button
                      type="button"
                      onClick={() => setSelectedDossier(dossier)}
                      className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 shadow-xs"
                    >
                      View Dossier
                    </button>
                    <button
                      type="button"
                      onClick={() => setEmailTarget(dossier)}
                      className="rounded-md border border-teal-200 bg-teal-50 px-3 py-1.5 text-xs font-semibold text-teal-800 hover:bg-teal-100"
                    >
                      ✉ Email
                    </button>
                    <a
                      href={`/api/bff/v1/dossiers/${dossier.id}`}
                      target="_blank"
                      rel="noreferrer"
                      className="rounded-md bg-slate-800 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-900 shadow-xs"
                    >
                      Download
                    </a>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* View Modal */}
      <DossierViewerModal
        tenantId={tenantId}
        dossier={selectedDossier}
        isOpen={Boolean(selectedDossier)}
        onClose={() => setSelectedDossier(null)}
        canRelease={canRelease}
        onSeal={handleSealDossier}
      />

      {/* Email Modal */}
      <EmailDispatchModal
        tenantId={tenantId}
        isOpen={Boolean(emailTarget)}
        onClose={() => setEmailTarget(null)}
        target={{
          dossierId: emailTarget?.id,
          title: emailTarget?.title || '',
          kind: emailTarget?.dossierType || '',
          proofSealHash: emailTarget?.proofSealHash,
        }}
      />
    </div>
  );
}
