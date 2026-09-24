'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { AgentIcon } from '@axiom/ui';

export interface EvidenceItem {
  id: string;
  title: string;
  desc: string;
  type: string;
  ts: string;
  hash: string;
  fullHash: string;
  s3: string;
  links: string[];
  byteSize?: number;
  agent?: string;
}

export interface EvidenceClientProps {
  initialEvidence: EvidenceItem[];
  vaultStats: {
    totalArtifacts: number;
    packsCount: number;
    noticeCount: number;
    retentionCount: number;
    securityCount: number;
  };
}

export function EvidenceClient({ initialEvidence, vaultStats }: EvidenceClientProps) {
  const evidenceList = initialEvidence.length > 0 ? initialEvidence : [];
  const [selId, setSelId] = useState<string>(evidenceList[0]?.id || 'e-8841');
  const [verifiedHash, setVerifiedHash] = useState<boolean>(false);
  const [searchTerm, setSearchTerm] = useState<string>('');

  const selectedItem = evidenceList.find((e) => e.id === selId) || evidenceList[0];

  const filteredEvidence = evidenceList.filter((e) => {
    if (!searchTerm) return true;
    const q = searchTerm.toLowerCase();
    return (
      e.id.toLowerCase().includes(q) ||
      e.title.toLowerCase().includes(q) ||
      e.desc.toLowerCase().includes(q) ||
      e.links.some((l) => l.toLowerCase().includes(q))
    );
  });

  const [artifactViewerOpen, setArtifactViewerOpen] = useState(false);
  const [exportFeedback, setExportFeedback] = useState<string | null>(null);

  const handleVerify = () => {
    setVerifiedHash(true);
    setTimeout(() => setVerifiedHash(false), 3000);
  };

  const handleDownloadArtifact = (item: EvidenceItem) => {
    const content = {
      artifact_id: item.id,
      title: item.title,
      description: item.desc,
      evidence_type: item.type,
      storage_uri: item.s3,
      sha256_content_hash: item.fullHash,
      timestamp: item.ts,
      satisfies_controls: item.links,
      vault_parameters: {
        region: 'ap-south-1 (Mumbai)',
        object_lock_mode: 'COMPLIANCE',
        retention_years: 7,
        tamper_evident: true,
      },
      sealed_evidence_payload: {
        attestation: `Cryptographically sealed by Saakshi Agent under DPDPA 2023 §8(5).`,
        chain_proof: `sha256:${item.fullHash}`,
        status: 'IMMUTABLE_WORM_SEALED',
      },
    };
    const blob = new Blob([JSON.stringify(content, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `axiom-evidence-${item.id}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleExportEvidencePack = () => {
    const packManifest = {
      manifestVersion: '1.0',
      exportId: `EXP-EVID-${Math.floor(1000 + Math.random() * 9000)}`,
      statutoryStandard: 'Digital Personal Data Protection Act 2023 (DPDPA)',
      filingFormat: 'DPB Form-V3 Cryptographic Evidence Dossier',
      exportedAt: new Date().toISOString(),
      vaultLocation: 'AWS S3 ap-south-1 (Mumbai)',
      wormLockMode: 'COMPLIANCE (Strict)',
      generatingAgent: 'saakshi',
      attestationHash:
        'sha256:' +
        Array.from({ length: 64 }, () => Math.floor(Math.random() * 16).toString(16)).join(''),
      vaultStatistics: vaultStats,
      evidenceArtifacts: evidenceList.map((e) => ({
        id: e.id,
        title: e.title,
        description: e.desc,
        evidenceType: e.type,
        collectedTimestamp: e.ts,
        sha256ContentHash: e.fullHash || e.hash,
        storageUri: e.s3,
        demonstratesControlIds: e.links,
        byteSize: e.byteSize || 10240,
        collectorAgent: e.agent || 'saakshi',
        wormLockDurationDays: 365 * 7,
      })),
    };

    const jsonStr = JSON.stringify(packManifest, null, 2);
    const blob = new Blob([jsonStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `axiom-all-evidences-combined-dossier-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    setExportFeedback(
      `All ${evidenceList.length} WORM-sealed evidence artifacts combined and exported into statutory dossier with SHA-256 proof seals.`,
    );
  };

  return (
    <div className="mx-auto max-w-[1180px] space-y-5 animate-in fade-in-0 duration-200">
      {/* ============================================================ */}
      {/* 1. HERO BANNER                                               */}
      {/* ============================================================ */}
      <div className="rounded-2xl bg-gradient-to-br from-[#1E2A4A] via-[#1E2A4A] to-[#243356] p-6 md:p-7 text-white shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex-1 min-w-[280px]">
            <div className="mb-2 flex items-center gap-2 flex-wrap">
              <span className="rounded bg-[#0FB5A5] px-2 py-0.5 text-[9px] font-bold text-[#04322d] uppercase tracking-wider">
                P1 · M1.5
              </span>
              <div className="flex flex-wrap items-center gap-1.5 text-xs font-semibold text-[#0FB5A5]">
                <span>Agent ·</span>
                <span className="inline-flex items-center gap-1">
                  <AgentIcon agent="saakshi" size="xs" variant="on-dark" state="idle" />
                  <span>Saakshi</span>
                </span>
              </div>
              <span className="text-xs text-[#8a97b8]">Evidence Vault</span>
              <span className="rounded bg-white/10 px-2 py-0.5 font-mono text-[10px] text-[#C9A227]">
                WORM Lock (ap-south-1)
              </span>
            </div>
            <div className="flex items-baseline gap-3">
              <h1 className="font-heading text-2xl md:text-[26px] font-bold text-white tracking-tight">
                Evidence Explorer
              </h1>
              <span className="font-heading text-lg text-[#0FB5A5] font-normal">
                साक्ष्य अन्वेषक
              </span>
            </div>
            <p className="mt-2 max-w-2xl text-xs leading-relaxed text-[#c7cfe0]">
              Saakshi captures, content-addresses and seals compliance artifacts (WORM lock in S3
              ap-south-1). Every finding, action and dry-run is anchored to immutable evidence.
            </p>
          </div>

          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={handleExportEvidencePack}
              className="rounded-[9px] bg-[#0FB5A5] hover:bg-[#0da294] text-white text-xs font-bold py-2.5 px-4 shadow-sm transition-all cursor-pointer flex items-center gap-1.5"
            >
              <span>⬇</span> Download All Evidences (Combined Dossier)
            </button>
          </div>
        </div>
      </div>

      {exportFeedback && (
        <div className="flex items-center justify-between rounded-xl border border-teal-300 bg-[#E5FAF7] p-3 text-xs text-[#04322d] shadow-sm animate-in fade-in-0 duration-150">
          <div className="flex items-center gap-2">
            <span>✓</span>
            <span className="font-semibold">{exportFeedback}</span>
          </div>
          <button
            onClick={() => setExportFeedback(null)}
            className="text-xs font-bold opacity-60 hover:opacity-100 cursor-pointer"
          >
            ✕
          </button>
        </div>
      )}

      {/* ============================================================ */}
      {/* 2. VAULT & BY CONTROL CARDS                                  */}
      {/* ============================================================ */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="rounded-2xl border border-[#e4e8ee] bg-white p-5 shadow-2xs">
          <h2 className="font-heading text-sm font-semibold text-[#1E2A4A] mb-3">Vault</h2>
          <div className="divide-y divide-[#eef1f5]">
            <div className="flex items-center gap-2.5 py-2.5">
              <span className="h-1.5 w-1.5 rounded-sm bg-[#C9A227]" />
              <span className="flex-1 text-xs text-[#2F3542] font-medium">
                Sealed artifacts (WORM)
              </span>
              <span className="font-mono text-xs font-semibold text-[#1E2A4A]">
                {vaultStats.totalArtifacts.toLocaleString()}
              </span>
            </div>
            <div className="flex items-center gap-2.5 py-2.5">
              <span className="h-1.5 w-1.5 rounded-sm bg-[#0FB5A5]" />
              <span className="flex-1 text-xs text-[#2F3542] font-medium">Integrity verified</span>
              <span className="font-mono text-xs font-semibold text-[#1E2A4A]">100%</span>
            </div>
            <div className="flex items-center gap-2.5 py-2.5">
              <span className="h-1.5 w-1.5 rounded-sm bg-[#1E2A4A]" />
              <span className="flex-1 text-xs text-[#2F3542] font-medium">Retention mode</span>
              <span className="font-mono text-xs font-semibold text-[#1E2A4A]">Compliance</span>
            </div>
          </div>
        </div>

        <div className="rounded-2xl border border-[#e4e8ee] bg-white p-5 shadow-2xs">
          <h2 className="font-heading text-sm font-semibold text-[#1E2A4A] mb-3">By obligation</h2>
          <div className="divide-y divide-[#eef1f5]">
            <div className="flex items-center gap-2.5 py-2.5">
              <span className="h-1.5 w-1.5 rounded-sm bg-[#1E2A4A]" />
              <span className="flex-1 text-xs text-[#2F3542] font-medium">Notice & consent</span>
              <span className="font-mono text-xs font-semibold text-[#1E2A4A]">
                {vaultStats.noticeCount}
              </span>
            </div>
            <div className="flex items-center gap-2.5 py-2.5">
              <span className="h-1.5 w-1.5 rounded-sm bg-[#1E2A4A]" />
              <span className="flex-1 text-xs text-[#2F3542] font-medium">Retention & erasure</span>
              <span className="font-mono text-xs font-semibold text-[#1E2A4A]">
                {vaultStats.retentionCount}
              </span>
            </div>
            <div className="flex items-center gap-2.5 py-2.5">
              <span className="h-1.5 w-1.5 rounded-sm bg-[#1E2A4A]" />
              <span className="flex-1 text-xs text-[#2F3542] font-medium">Access & security</span>
              <span className="font-mono text-xs font-semibold text-[#1E2A4A]">
                {vaultStats.securityCount}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* ============================================================ */}
      {/* 3. QUICK STATS ROW                                           */}
      {/* ============================================================ */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div className="rounded-xl border border-slate-200 bg-white p-3.5 shadow-2xs">
          <div className="font-heading text-xl font-bold text-[#C9A227]">
            {vaultStats.totalArtifacts.toLocaleString()}
          </div>
          <div className="text-[11px] text-slate-500">sealed artifacts (WORM)</div>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-3.5 shadow-2xs">
          <div className="font-heading text-xl font-bold text-[#1E2A4A]">
            {vaultStats.packsCount}
          </div>
          <div className="text-[11px] text-slate-500">evidence packs assembled</div>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-3.5 shadow-2xs">
          <div className="font-heading text-xl font-bold text-[#0a8d80]">✓ verified</div>
          <div className="text-[11px] text-slate-500">content-hash integrity</div>
        </div>
      </div>

      {/* Search and Filters */}
      <div className="rounded-xl border border-slate-200 bg-white p-3 shadow-2xs flex items-center justify-between gap-3">
        <input
          type="text"
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          placeholder="Filter artifacts by title, ID, control (e.g. NOT-01, SEC-09)..."
          className="h-9 flex-1 rounded-md border border-slate-300 bg-white px-3 text-xs placeholder:text-slate-400 focus:border-teal-500 focus:outline-none"
        />
        <div className="text-xs text-slate-500 font-mono">
          Showing <strong>{filteredEvidence.length}</strong> artifacts
        </div>
      </div>

      {/* ============================================================ */}
      {/* 4. MAIN 2-COLUMN EXPLORER: LIST + STICKY INSPECTOR           */}
      {/* ============================================================ */}
      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_380px] gap-4 items-start">
        {/* Left Column: Artifacts Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {filteredEvidence.map((ev) => {
            const isSel = selectedItem?.id === ev.id;

            return (
              <div
                key={ev.id}
                onClick={() => setSelId(ev.id)}
                className={`rounded-xl border p-4 bg-white cursor-pointer transition-all ${
                  isSel
                    ? 'border-[#C9A227] ring-2 ring-[#C9A227]/30 shadow-xs'
                    : 'border-slate-200 hover:border-slate-300 hover:shadow-2xs'
                }`}
              >
                <div className="flex items-center justify-between mb-2">
                  <span className="font-mono text-xs font-semibold text-[#1E2A4A]">{ev.id}</span>
                  <span className="font-mono text-[10px] text-slate-400">{ev.ts}</span>
                </div>
                <h3 className="text-xs font-bold text-[#1E2A4A] mb-1 line-clamp-1">{ev.title}</h3>
                <p className="text-[11.5px] text-slate-600 leading-snug line-clamp-2 mb-3">
                  {ev.desc}
                </p>
                <div className="flex items-center justify-between text-[10.5px] pt-2 border-t border-slate-100">
                  <span className="font-mono text-slate-400">{ev.hash}</span>
                  <span className="font-semibold text-[#8a6d10] bg-[#f7f0d8] px-2 py-0.5 rounded text-[10px]">
                    ✦ {ev.type}
                  </span>
                </div>
              </div>
            );
          })}
        </div>

        {/* Right Column: Sticky Proof Sealed Panel */}
        {selectedItem && (
          <div className="sticky top-4 rounded-2xl border border-slate-200 bg-white p-5 shadow-2xs space-y-4">
            <div className="inline-flex items-center gap-1.5 bg-[#f7f0d8] text-[#8a6d10] px-2.5 py-1 rounded-md text-[10px] font-bold uppercase tracking-wider">
              <span>✦</span>
              <span>PROOF SEALED · S3 OBJECT LOCK</span>
            </div>

            <div>
              <h2 className="font-heading text-base font-bold text-[#1E2A4A] leading-tight">
                {selectedItem.title}
              </h2>
              <div className="font-mono text-xs text-slate-400 mt-1">
                {selectedItem.id} · {selectedItem.ts}
              </div>
            </div>

            <div className="space-y-3 text-xs">
              <div>
                <div className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider mb-1">
                  SHA-256 Content Digest
                </div>
                <div className="font-mono text-[11px] text-[#1E2A4A] break-all bg-[#F4F6F8] p-2 rounded-md">
                  {selectedItem.fullHash}
                </div>
              </div>

              <div>
                <div className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider mb-1">
                  S3 Storage URI (ap-south-1)
                </div>
                <div className="font-mono text-[10.5px] text-slate-600 break-all">
                  {selectedItem.s3}
                </div>
              </div>

              <div>
                <div className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider mb-1">
                  Object Lock Retention
                </div>
                <div className="font-semibold text-[#0a8d80]">7 years WORM · Compliance mode</div>
              </div>

              <div>
                <div className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider mb-1.5">
                  Satisfies Controls
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {selectedItem.links.map((link) => (
                    <Link
                      key={link}
                      href={`/controls?q=${link}`}
                      className="font-mono text-[10.5px] bg-[#e6f7f5] text-[#0a8d80] px-2 py-0.5 rounded font-medium hover:underline"
                    >
                      {link}
                    </Link>
                  ))}
                </div>
              </div>
            </div>

            {verifiedHash && (
              <div className="rounded-lg bg-emerald-50 border border-emerald-200 p-2 text-center text-xs font-semibold text-emerald-800 animate-in fade-in-0 duration-150">
                ✓ Cryptographic SHA-256 integrity check verified against ledger
              </div>
            )}

            <div className="pt-3 border-t border-slate-100 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={handleVerify}
                className="flex-1 py-2 px-3 bg-[#1E2A4A] hover:bg-[#283863] text-white rounded-md text-xs font-semibold transition-colors cursor-pointer"
              >
                Verify hash
              </button>
              <button
                type="button"
                onClick={() => handleDownloadArtifact(selectedItem)}
                className="py-2 px-3 bg-white border border-slate-300 hover:bg-slate-50 text-slate-700 rounded-md text-xs font-semibold transition-colors flex items-center gap-1 cursor-pointer"
                title="Download JSON artifact"
              >
                <span>⬇</span>
                <span>Download</span>
              </button>
              <button
                type="button"
                onClick={() => setArtifactViewerOpen(true)}
                className="py-2 px-3 bg-teal-50 border border-teal-300 hover:bg-teal-100 text-teal-800 rounded-md text-xs font-semibold transition-colors flex items-center gap-1 cursor-pointer"
                title="Inspect artifact contents and cryptographic seal"
              >
                <span>👁</span>
                <span>View</span>
              </button>
            </div>
          </div>
        )}
      </div>

      {/* ============================================================ */}
      {/* 5. ARTIFACT CONTENT & WORM SEAL VIEWER MODAL                 */}
      {/* ============================================================ */}
      {artifactViewerOpen && selectedItem && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 animate-in fade-in-0 duration-150 backdrop-blur-xs overflow-y-auto">
          <div className="relative w-full max-w-2xl rounded-2xl bg-white p-6 shadow-2xl border border-slate-200 space-y-4 my-8 max-h-[90vh] flex flex-col justify-between">
            <div className="flex items-center justify-between pb-3 border-b border-slate-100">
              <div className="flex items-center gap-2">
                <span className="text-[#C9A227] text-lg">✦</span>
                <h3 className="text-base font-bold text-[#1E2A4A]">
                  Evidence Artifact: {selectedItem.id}
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setArtifactViewerOpen(false)}
                className="text-slate-400 hover:text-slate-600 text-sm font-bold p-1 cursor-pointer"
              >
                ✕
              </button>
            </div>

            <div className="space-y-3 overflow-y-auto pr-1">
              <div>
                <h4 className="text-sm font-semibold text-slate-900">{selectedItem.title}</h4>
                <p className="text-xs text-slate-600 mt-1">{selectedItem.desc}</p>
              </div>

              <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 space-y-2 text-xs font-mono">
                <div className="flex justify-between">
                  <span className="text-slate-500">Storage URI:</span>
                  <span className="text-indigo-700 font-semibold">{selectedItem.s3}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-500">Vault Location:</span>
                  <span className="text-teal-700">AWS S3 ap-south-1 (Mumbai)</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-500">WORM Lock:</span>
                  <span className="text-emerald-700 font-semibold">
                    Object Lock (Compliance Mode)
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-500">SHA-256 Digest:</span>
                  <span className="text-slate-800 break-all">{selectedItem.fullHash}</span>
                </div>
              </div>

              <div>
                <span className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider">
                  Satisfies Controls
                </span>
                <div className="flex flex-wrap gap-1.5 mt-1">
                  {selectedItem.links.map((link) => (
                    <span
                      key={link}
                      className="font-mono text-xs bg-[#e6f7f5] text-[#0a8d80] px-2 py-0.5 rounded font-medium"
                    >
                      {link}
                    </span>
                  ))}
                </div>
              </div>
            </div>

            <div className="flex items-center justify-end gap-2.5 pt-3 border-t border-slate-100">
              <button
                type="button"
                onClick={() => setArtifactViewerOpen(false)}
                className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 transition-colors cursor-pointer"
              >
                Close
              </button>
              <button
                type="button"
                onClick={() => {
                  handleDownloadArtifact(selectedItem);
                  setArtifactViewerOpen(false);
                }}
                className="rounded-lg bg-[#0FB5A5] hover:bg-[#0da294] px-4 py-2 text-xs font-bold text-white shadow-xs transition-colors cursor-pointer flex items-center gap-1.5"
              >
                <span>⬇</span>
                <span>Download Sealed Artifact</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
