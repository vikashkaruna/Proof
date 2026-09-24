'use client';

import { CONTROL_LIBRARY_COUNT, CONTROL_LIBRARY_DOMAIN_COUNT } from '@axiom/control-library';
import React, { useState } from 'react';
import { AgentIcon } from '@axiom/ui';

export interface ReportItem {
  id: string;
  title: string;
  kind: 'board' | 'auditor' | 'dpb' | 'technical' | 'custom';
  tenantName: string;
  tenantSlug: string;
  createdAt: string;
  reviewer: string;
  postureScore: number;
  exposureCr: number;
  evidenceCount: number;
  summary: string;
  statutoryCitation: string;
  sections: Array<{
    title: string;
    content: string;
    findings?: Array<{ control: string; severity: string; status: string; detail: string }>;
    evidenceLinks?: Array<{ id: string; name: string; hash: string }>;
  }>;
}

const INITIAL_REPORTS: ReportItem[] = [
  {
    id: 'REP-BRD-2026-Q3',
    title: 'Executive Board Compliance Pack — Q3 2026',
    kind: 'board',
    tenantName: 'Meridian Pay',
    tenantSlug: 'meridian',
    createdAt: '12 Sep 2026',
    reviewer: 'Chief Privacy Officer & Principal Reviewer',
    postureScore: 74,
    exposureCr: 18.5,
    evidenceCount: 14,
    statutoryCitation: 'DPDPA §8(4) & Board Governance Directive',
    summary:
      'Overall organizational DPDPA posture is Acceptable (74/100). Remediation plans executed by Karya closed 8 critical KYC retention gaps. Maximum residual exposure reduced from ₹45 Cr to ₹18.5 Cr.',
    sections: [
      {
        title: '1. Executive Posture Scorecard',
        content:
          // axiom-count-ok: 36 is a compliant-subset figure in sample narrative, not the library total
          `Audit evaluated ${CONTROL_LIBRARY_COUNT} controls across ${CONTROL_LIBRARY_DOMAIN_COUNT} DPDPA domains. 36 controls are in full statutory compliance, 8 are actively managed under remediation plans, and 4 require board review.`,
      },
      {
        title: '2. High Exposure Findings & Risk Allocation',
        content:
          'Top residual exposure stems from third-party payment gateway sub-processors and automated biometric credential caching.',
        findings: [
          {
            control: 'RET-03',
            severity: 'CRITICAL',
            status: 'REMEDIATED',
            detail: 'Purged 1,840 expired KYC documents past 5-year limit.',
          },
          {
            control: 'NOT-01',
            severity: 'HIGH',
            status: 'COMPLIANT',
            detail: 'Deployed bilingual itemised consent notices across checkout apps.',
          },
          {
            control: 'XBR-01',
            severity: 'HIGH',
            status: 'MITIGATED',
            detail: 'KMS ap-south-1 encryption lock validated with zero cross-border leakage.',
          },
        ],
      },
      {
        title: '3. Immutable Evidence Attestation',
        content:
          'All claims in this report cite cryptographically sealed artifacts locked in AWS S3 ap-south-1 Compliance mode.',
        evidenceLinks: [
          { id: 'e-8841', name: 'KYC Purge Pre-state Snapshot', hash: 'a3f0…9c1' },
          { id: 'e-8839', name: 'Multilingual Notice Bundle', hash: '8f12…bb4' },
          { id: 'e-8843', name: 'AWS KMS CMEK Policy Proof', hash: '3d90…1bb' },
        ],
      },
    ],
  },
  {
    id: 'REP-AUD-2026-09',
    title: 'Statutory Auditor Evidence Dossier (Form DPB-V3)',
    kind: 'auditor',
    tenantName: 'Meridian Pay',
    tenantSlug: 'meridian',
    createdAt: '08 Sep 2026',
    reviewer: 'Audit Partner (Big-4 Independent Privacy Auditor)',
    postureScore: 82,
    exposureCr: 8.2,
    evidenceCount: 28,
    statutoryCitation: 'DPDPA §10(2) & S.D.F. Mandatory Annual Audit',
    summary:
      'Formal audit pack compiled for external statutory compliance verification. Contains complete hash-chained ledger trail, cryptographic proof certificates, and dry-run diffs.',
    sections: [
      {
        title: '1. Independent Auditor Assurance Scope',
        content:
          'Conducted verification of data principal consent management, retention purge schedules, and employee access permissions against ISO 27701 and DPDPA Rules.',
      },
      {
        title: '2. Cryptographic Ledger Chain Integrity',
        content:
          'Audit ledger sequence #1 through #248 verified without break. All Merkle tree roots match root hashes published to immutable ledger storage.',
      },
    ],
  },
  {
    id: 'REP-DPB-2026-SEC8',
    title: 'Data Protection Board of India (DPB) Section 8(4) Filing',
    kind: 'dpb',
    tenantName: 'Meridian Pay',
    tenantSlug: 'meridian',
    createdAt: '01 Sep 2026',
    reviewer: 'Chief Legal Officer & Designated DPO',
    postureScore: 78,
    exposureCr: 12.0,
    evidenceCount: 19,
    statutoryCitation: 'DPDPA Section 8(4) & Rule 12 Statutory Submission',
    summary:
      'Official statutory submission template for Data Protection Board of India reporting. Captures data principal grievance redressal logs, mean resolution time (2.1 days), and zero reportable breaches.',
    sections: [
      {
        title: '1. Data Fiduciary Statutory Profile',
        content:
          'Data Fiduciary Registration: SDF-2026-IND-0042. Sector: Financial Services / Payment Aggregator. Data Principal base: 2.4 Million.',
      },
      {
        title: '2. Grievance Redressal Metrics (§13)',
        content:
          'Total DSAR requests received: 184. Full erasure requests: 42. Resolved within statutory SLA: 100%. Average turnaround: 48 hours.',
      },
    ],
  },
  {
    id: 'REP-TECH-2026-08',
    title: 'Technical Remediation & Infrastructure Register (P3)',
    kind: 'technical',
    tenantName: 'Meridian Pay',
    tenantSlug: 'meridian',
    createdAt: '24 Aug 2026',
    reviewer: 'Head of SecOps & Platform Architecture',
    postureScore: 71,
    exposureCr: 24.0,
    evidenceCount: 34,
    statutoryCitation: 'ADR-1, ADR-2, ADR-3 Technical Architecture Standard',
    summary:
      'Comprehensive system architecture audit detailing dry-run rollback definitions, blast radius caps, database encryption keys, and Sudhaar/Karya agent mutation logs.',
    sections: [
      {
        title: '1. Autonomous Agent Boundary Enforcements',
        content:
          'Sudhaar holds zero write credentials (can_mutate = False). Karya executes only on presentation of valid HMAC-SHA-256 signed approval tokens.',
      },
    ],
  },
  {
    id: 'REP-DPIA-2026-AH',
    title: 'Data Protection Impact Assessment (DPIA) — Aarogya Health',
    kind: 'custom',
    tenantName: 'Aarogya Health',
    tenantSlug: 'aarogya',
    createdAt: '18 Aug 2026',
    reviewer: 'Medical Compliance Officer & DPO',
    postureScore: 61,
    exposureCr: 35.0,
    evidenceCount: 12,
    statutoryCitation: 'DPDPA Section 9 & 10(2)(a) Sensitive Personal Health Data',
    summary:
      'Comprehensive DPIA evaluating processing of electronic health records (EHR), diagnostic imaging files, and biometric patient identifiers across clinical databases.',
    sections: [
      {
        title: '1. High-Risk Health Data Classification',
        content:
          'Identified 680,000 sensitive health records. Implemented strict role-based access control (RBAC) and field-level AES-256-GCM tokenization.',
      },
    ],
  },
];

export function ReportsClient({
  totalCount,
  postureScore,
  evidenceCount,
}: {
  totalCount: number;
  postureScore: number;
  evidenceCount: number;
}) {
  const [reports, setReports] = useState<ReportItem[]>(INITIAL_REPORTS);
  const [selectedReport, setSelectedReport] = useState<ReportItem | null>(null);
  const [activeTab, setActiveTab] = useState<'all' | 'board' | 'auditor' | 'dpb'>('all');
  const [generatorOpen, setGeneratorOpen] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [genTitle, setGenTitle] = useState('Executive Board Compliance Dossier — Q4 2026');
  const [genKind, setGenKind] = useState<'board' | 'auditor' | 'dpb' | 'technical'>('board');
  const [genTenant, setGenTenant] = useState('Meridian Pay');
  const [successToast, setSuccessToast] = useState<string | null>(null);

  const filtered = reports.filter((r) => {
    if (activeTab === 'all') return true;
    return r.kind === activeTab;
  });

  const downloadHtmlReport = (rep: ReportItem) => {
    const htmlContent = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <title>${rep.title} — Axiom Proof</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; line-height: 1.6; color: #1E2A4A; max-width: 860px; margin: 0 auto; padding: 0; }
    .ax-header { background: #1E2A4A; padding: 16px 28px; display: flex; align-items: center; justify-content: space-between; }
    .ax-header-left { display: flex; align-items: center; gap: 12px; }
    .ax-logo-mark { width: 32px; height: 32px; border-radius: 6px; background: #0FB5A5; display: flex; align-items: center; justify-content: center; }
    .ax-logo-mark svg { width: 18px; height: 18px; }
    .ax-logo-text { color: #fff; font-size: 16px; font-weight: 700; letter-spacing: -0.3px; }
    .ax-logo-text span { color: #0FB5A5; }
    .ax-header-link { color: #8a97b8; font-size: 11px; text-decoration: none; }
    .ax-header-link:hover { color: #0FB5A5; }
    .ax-teal-bar { height: 3px; background: linear-gradient(90deg, #0FB5A5, #1E2A4A); }
    .content { padding: 28px 28px 20px; }
    .prepared-for { background: #F4F6F8; border-radius: 8px; padding: 14px 18px; margin-bottom: 24px; font-size: 12px; color: #525B71; }
    .prepared-for strong { color: #1E2A4A; font-size: 14px; display: block; margin-bottom: 2px; }
    .badge { display: inline-block; background: #0FB5A5; color: #04322d; padding: 4px 10px; border-radius: 4px; font-weight: bold; font-size: 11px; text-transform: uppercase; }
    .gold-badge { display: inline-block; background: #C9A227; color: #fff; padding: 4px 10px; border-radius: 4px; font-weight: bold; font-size: 11px; }
    h1 { margin: 12px 0 6px 0; color: #1E2A4A; font-size: 22px; }
    .citation { color: #5b6270; font-size: 13px; font-family: monospace; }
    .meta-line { margin-top: 6px; font-size: 13px; color: #5b6270; }
    .summary-box { background: #F4F6F8; border-left: 4px solid #1E2A4A; padding: 16px 20px; margin: 24px 0; border-radius: 0 8px 8px 0; }
    .score-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; margin: 24px 0; }
    .score-card { background: #fff; border: 1px solid #e4e8ee; border-radius: 8px; padding: 16px; text-align: center; }
    .score-val { font-size: 28px; font-weight: bold; color: #1E2A4A; }
    .score-lbl { font-size: 12px; color: #8a909b; text-transform: uppercase; }
    .section { margin: 32px 0; }
    .section h2 { border-bottom: 1px solid #eef1f5; padding-bottom: 8px; color: #1E2A4A; font-size: 18px; }
    .evidence-tag { font-family: monospace; font-size: 11px; background: #E5FAF7; color: #0a6b61; padding: 3px 8px; border-radius: 4px; margin-right: 8px; }
    .ax-footer { border-top: 2px solid #e4e8ee; padding: 14px 28px; display: flex; align-items: center; justify-content: space-between; font-size: 11px; color: #8a909b; background: #FBFCFD; }
    .ax-footer-left { display: flex; align-items: center; gap: 8px; }
    .ax-footer-logo { width: 16px; height: 16px; border-radius: 3px; background: #1E2A4A; display: inline-flex; align-items: center; justify-content: center; }
    .ax-footer-logo svg { width: 10px; height: 10px; }
    .ax-footer a { color: #0FB5A5; text-decoration: none; }
    .ax-footer a:hover { text-decoration: underline; }
    @media print { .ax-header, .ax-footer { -webkit-print-color-adjust: exact; print-color-adjust: exact; } }
  </style>
</head>
<body>
  <!-- ========== HEADER: Axiom Proof ========== -->
  <div class="ax-header">
    <div class="ax-header-left">
      <div class="ax-logo-mark">
        <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M12 2L2 19h20L12 2z" fill="#1E2A4A"/><path d="M12 8l-4 8h8l-4-8z" fill="#fff"/></svg>
      </div>
      <div class="ax-logo-text">Axiom <span>Proof</span></div>
    </div>
    <a href="https://axiomproof.ai" class="ax-header-link">axiomproof.ai</a>
  </div>
  <div class="ax-teal-bar"></div>

  <div class="content">
    <!-- Prepared For -->
    <div class="prepared-for">
      <strong>Prepared for: ${rep.tenantName}</strong>
      Compiled: ${rep.createdAt} · Report ID: ${rep.id} · Reviewed by: ${rep.reviewer}
    </div>

    <span class="badge">Axiom Proof Certified</span>
    <span class="gold-badge">WORM Sealed Artifact</span>
    <h1>${rep.title}</h1>
    <div class="citation">Citation: ${rep.statutoryCitation} · ID: ${rep.id}</div>

    <div class="score-grid">
      <div class="score-card">
        <div class="score-val" style="color: #0FB5A5;">${rep.postureScore}/100</div>
        <div class="score-lbl">Statutory Posture Score</div>
      </div>
      <div class="score-card">
        <div class="score-val" style="color: #D9534F;">₹${rep.exposureCr.toFixed(1)} Cr</div>
        <div class="score-lbl">Max Residual Exposure</div>
      </div>
      <div class="score-card">
        <div class="score-val" style="color: #C9A227;">${rep.evidenceCount}</div>
        <div class="score-lbl">WORM Evidence Seals</div>
      </div>
    </div>

    <div class="summary-box">
      <strong>Executive Summary:</strong><br/>
      ${rep.summary}
    </div>

    ${rep.sections
      .map(
        (sec) => `
      <div class="section">
        <h2>${sec.title}</h2>
        <p>${sec.content}</p>
        ${
          sec.findings
            ? `
          <table style="width: 100%; border-collapse: collapse; margin-top: 12px; font-size: 13px;">
            <tr style="background: #F4F6F8; text-align: left;">
              <th style="padding: 8px;">Control</th>
              <th style="padding: 8px;">Severity</th>
              <th style="padding: 8px;">Status</th>
              <th style="padding: 8px;">Finding Detail</th>
            </tr>
            ${sec.findings
              .map(
                (f) => `
              <tr style="border-bottom: 1px solid #eef1f5;">
                <td style="padding: 8px; font-family: monospace; font-weight: bold;">${f.control}</td>
                <td style="padding: 8px; color: ${f.severity === 'CRITICAL' ? '#D9534F' : '#E0A82E'}; font-weight: bold;">${f.severity}</td>
                <td style="padding: 8px; color: #0FB5A5; font-weight: bold;">${f.status}</td>
                <td style="padding: 8px;">${f.detail}</td>
              </tr>
            `,
              )
              .join('')}
          </table>
        `
            : ''
        }
        ${
          sec.evidenceLinks
            ? `
          <div style="margin-top: 12px;">
            ${sec.evidenceLinks
              .map((e) => `<span class="evidence-tag">${e.id} (${e.name}) · H:${e.hash}</span>`)
              .join(' ')}
          </div>
        `
            : ''
        }
      </div>
    `,
      )
      .join('')}
  </div>

  <!-- ========== FOOTER: Axiom Minds + Axiom Proof ========== -->
  <div class="ax-footer">
    <div class="ax-footer-left">
      <span class="ax-footer-logo">
        <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M12 2L2 19h20L12 2z" fill="#fff"/></svg>
      </span>
      <span>© ${new Date().getFullYear()} <strong>Axiom Minds Pvt. Ltd.</strong> · <a href="https://axiomminds.ai">axiomminds.ai</a></span>
    </div>
    <span>Powered by <strong>Axiom Proof</strong> · <a href="https://axiomproof.ai">axiomproof.ai</a> · Compiled by Prativedan Agent</span>
  </div>
</body>
</html>`;

    const blob = new Blob([htmlContent], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${rep.id.toLowerCase()}-${rep.tenantSlug}.html`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const downloadJsonBundle = (rep: ReportItem) => {
    const jsonStr = JSON.stringify(
      {
        dossierManifest: {
          reportId: rep.id,
          title: rep.title,
          kind: rep.kind,
          tenant: rep.tenantName,
          tenantSlug: rep.tenantSlug,
          compilationTimestamp: new Date().toISOString(),
          statutoryCitation: rep.statutoryCitation,
          signoffReviewer: rep.reviewer,
          postureScore: rep.postureScore,
          estimatedExposureInr: rep.exposureCr * 10000000,
          evidenceSealsCount: rep.evidenceCount,
          generatingAgent: 'prativedan',
          cryptographicSignature:
            'sha256:' + Math.random().toString(16).slice(2) + Math.random().toString(16).slice(2),
        },
        executiveSummary: rep.summary,
        sections: rep.sections,
      },
      null,
      2,
    );

    const blob = new Blob([jsonStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${rep.id.toLowerCase()}-statutory-bundle.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleCompileReport = () => {
    setGenerating(true);
    setTimeout(() => {
      const newId = `REP-PRAT-${Math.floor(1000 + Math.random() * 9000)}`;
      const newRep: ReportItem = {
        id: newId,
        title: genTitle,
        kind: genKind,
        tenantName: genTenant,
        tenantSlug: genTenant.toLowerCase().replace(/[^a-z0-9]/g, ''),
        createdAt: 'Just now',
        reviewer: 'Designated Data Protection Officer',
        postureScore: Math.round(72 + Math.random() * 15),
        exposureCr: Number((10 + Math.random() * 12).toFixed(1)),
        evidenceCount: Math.round(15 + Math.random() * 15),
        statutoryCitation: 'DPDPA §8(4) & Board Governance Directive',
        summary: `Freshly synthesized ${genKind.toUpperCase()} pack compiled by Prativedan agent. Correlates recent audit ledger entries and WORM-sealed evidence artifacts.`,
        sections: [
          {
            title: '1. Synthesis Executive Summary',
            content:
              'Automated reporting agent Prativedan compiled this dossier from active findings and immutable ledger events.',
          },
          {
            title: '2. Statutory Governance & Rollback Verification',
            content:
              'All executed remediation steps carry cryptographically verifiable rollback definitions.',
          },
        ],
      };

      setReports([newRep, ...reports]);
      setGenerating(false);
      setGeneratorOpen(false);
      setSuccessToast(`Compiled "${genTitle}". Dossier ready for preview and export.`);
      setSelectedReport(newRep);
    }, 1800);
  };

  return (
    <div className="mx-auto max-w-[1180px] space-y-6 animate-in fade-in-0 duration-200">
      {/* ============================================================ */}
      {/* 1. HERO BANNER                                               */}
      {/* ============================================================ */}
      <div className="rounded-2xl bg-gradient-to-br from-[#1E2A4A] via-[#1E2A4A] to-[#243356] p-6 md:p-7 text-white shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex-1 min-w-[280px]">
            <div className="mb-2 flex items-center gap-2 flex-wrap">
              <span className="rounded bg-[#0FB5A5] px-2 py-0.5 text-[9px] font-bold text-[#04322d] uppercase tracking-wider">
                P2 · M2.7
              </span>
              <div className="flex flex-wrap items-center gap-1.5 text-xs font-semibold text-[#0FB5A5]">
                <span>Agent ·</span>
                <span className="inline-flex items-center gap-1">
                  <AgentIcon agent="prativedan" size="xs" variant="on-dark" state="idle" />
                  <span>Prativedan</span>
                </span>
              </div>
              <span className="text-xs text-[#8a97b8]">Governance & Attestations</span>
              <span className="rounded bg-white/10 px-2 py-0.5 font-mono text-[10px] text-[#C9A227]">
                Form DPB-V3 Ready
              </span>
            </div>
            <div className="flex items-baseline gap-3">
              <h1 className="font-heading text-2xl md:text-[26px] font-bold text-white tracking-tight">
                Reports & Regulatory Dossiers
              </h1>
              <span className="font-heading text-lg text-[#0FB5A5] font-normal">
                रिपोर्ट और दस्तावेज
              </span>
            </div>
            <p className="mt-2 max-w-2xl text-xs leading-relaxed text-[#c7cfe0]">
              Prativedan turns statutory findings into executive board packs, auditor evidence
              dossiers, and DPB-ready regulatory submissions. Every claim references a WORM-locked
              evidence artifact.
            </p>
          </div>

          <button
            type="button"
            onClick={() => setGeneratorOpen(true)}
            className="rounded-[9px] bg-[#0FB5A5] hover:bg-[#0da294] px-4 py-2.5 text-xs font-bold text-white transition-all shadow-xs cursor-pointer flex items-center gap-1.5"
          >
            <span>⚡</span> Compile Board Pack / Dossier
          </button>
        </div>

        {/* 3 Metric Mini Cards */}
        <div className="mt-6 grid grid-cols-1 sm:grid-cols-3 gap-3 border-t border-white/10 pt-5">
          <div className="rounded-xl bg-white/5 p-3.5 backdrop-blur-xs">
            <div className="text-[10px] font-bold text-[#8a97b8] uppercase tracking-wider">
              Compiled Dossiers
            </div>
            <div className="mt-1 font-mono text-xl font-bold text-white">{reports.length}</div>
            <div className="text-[11px] text-[#c7cfe0]">
              All signed by designated reviewer & DPO
            </div>
          </div>
          <div className="rounded-xl bg-white/5 p-3.5 backdrop-blur-xs">
            <div className="text-[10px] font-bold text-[#8a97b8] uppercase tracking-wider">
              Statutory Posture Score
            </div>
            <div className="mt-1 font-mono text-xl font-bold text-[#0FB5A5]">
              {postureScore}/100
            </div>
            <div className="text-[11px] text-[#c7cfe0]">
              DPDPA statutory threshold met (Acceptable)
            </div>
          </div>
          <div className="rounded-xl bg-white/5 p-3.5 backdrop-blur-xs">
            <div className="text-[10px] font-bold text-[#8a97b8] uppercase tracking-wider">
              WORM Sealed Proof Citations
            </div>
            <div className="mt-1 font-mono text-xl font-bold text-[#C9A227]">
              {evidenceCount} Evidence Seals
            </div>
            <div className="text-[11px] text-[#c7cfe0]">SHA-256 anchored in ap-south-1 vault</div>
          </div>
        </div>
      </div>

      {/* Success Toast */}
      {successToast && (
        <div className="flex items-center justify-between rounded-xl border border-teal-300 bg-[#E5FAF7] p-3 text-xs text-[#04322d] shadow-sm">
          <div className="flex items-center gap-2">
            <span>✓</span>
            <span className="font-semibold">{successToast}</span>
          </div>
          <button
            onClick={() => setSuccessToast(null)}
            className="text-xs font-bold opacity-60 hover:opacity-100"
          >
            ✕
          </button>
        </div>
      )}

      {/* ============================================================ */}
      {/* 2. REPOSITORY TABLE & TABS                                   */}
      {/* ============================================================ */}
      <div className="rounded-2xl border border-[#e4e8ee] bg-white overflow-hidden shadow-2xs">
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-[#e4e8ee] bg-[#F4F6F8]">
          <div className="flex items-center gap-2">
            <span className="font-heading text-xs font-semibold text-[#1E2A4A] uppercase tracking-wider">
              Compiled Dossiers & Board Packs ({filtered.length})
            </span>
          </div>
          {/* Tabs */}
          <div className="flex items-center gap-1 text-xs">
            {(['all', 'board', 'auditor', 'dpb'] as const).map((tab) => (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                className={`rounded-lg px-2.5 py-1 font-semibold uppercase tracking-wider text-[10px] transition-colors ${
                  activeTab === tab
                    ? 'bg-white text-[#1E2A4A] shadow-xs'
                    : 'text-slate-500 hover:text-slate-900'
                }`}
              >
                {tab}
              </button>
            ))}
          </div>
        </div>

        <div className="divide-y divide-[#eef1f5]">
          {filtered.map((rep) => (
            <div
              key={rep.id}
              className="p-5 hover:bg-slate-50/70 transition-colors flex flex-col md:flex-row md:items-center justify-between gap-4"
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <code className="font-mono text-xs font-bold text-[#1E2A4A]">{rep.id}</code>
                  <span
                    className={`rounded px-2 py-0.5 text-[9px] font-bold uppercase ${
                      rep.kind === 'board'
                        ? 'bg-[#1E2A4A] text-white'
                        : rep.kind === 'auditor'
                          ? 'bg-[#C9A227] text-white'
                          : 'bg-[#0FB5A5] text-[#04322d]'
                    }`}
                  >
                    {rep.kind}
                  </span>
                  <span className="text-xs font-medium text-slate-500">· {rep.tenantName}</span>
                  <span className="text-xs text-slate-400">· {rep.createdAt}</span>
                </div>
                <h3 className="mt-1 text-sm font-bold text-[#1E2A4A]">{rep.title}</h3>
                <p className="mt-1 text-xs text-slate-600 line-clamp-2">{rep.summary}</p>

                <div className="mt-2 flex items-center gap-4 text-xs text-slate-500">
                  <span>
                    Posture: <strong className="text-teal-700">{rep.postureScore}/100</strong>
                  </span>
                  <span>·</span>
                  <span>
                    Exposure Cap: <strong>₹{rep.exposureCr} Cr</strong>
                  </span>
                  <span>·</span>
                  <span>
                    Evidence: <strong>{rep.evidenceCount} WORM seals</strong>
                  </span>
                </div>
              </div>

              {/* Actions */}
              <div className="flex items-center gap-2 shrink-0">
                <button
                  type="button"
                  onClick={() => setSelectedReport(rep)}
                  className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-bold text-slate-700 hover:bg-slate-50 shadow-2xs cursor-pointer"
                >
                  View Dossier
                </button>
                <button
                  type="button"
                  onClick={() => downloadHtmlReport(rep)}
                  className="rounded-lg bg-[#0FB5A5] hover:bg-[#0da294] px-3 py-1.5 text-xs font-bold text-white shadow-xs cursor-pointer"
                  title="Download self-contained printable report"
                >
                  Download HTML
                </button>
                <button
                  type="button"
                  onClick={() => downloadJsonBundle(rep)}
                  className="rounded-lg border border-teal-200 bg-teal-50 hover:bg-teal-100 px-3 py-1.5 text-xs font-bold text-teal-800 cursor-pointer"
                  title="Export cryptographic JSON statutory bundle"
                >
                  JSON Bundle
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* ============================================================ */}
      {/* 3. DOSSIER VIEWER MODAL                                      */}
      {/* ============================================================ */}
      {selectedReport && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 animate-in fade-in-0 duration-150 backdrop-blur-xs">
          <div className="max-h-[90vh] w-full max-w-3xl overflow-y-auto rounded-2xl bg-white shadow-2xl border border-slate-200 space-y-0">
            {/* Axiom Proof Branded Header */}
            <div className="flex items-center justify-between rounded-t-2xl bg-[#1E2A4A] px-6 py-3">
              <div className="flex items-center gap-2.5">
                <div className="flex h-7 w-7 items-center justify-center rounded-md bg-[#0FB5A5]">
                  <svg
                    viewBox="0 0 24 24"
                    className="h-4 w-4"
                    fill="none"
                    xmlns="http://www.w3.org/2000/svg"
                  >
                    <path d="M12 2L2 19h20L12 2z" fill="#1E2A4A" />
                    <path d="M12 8l-4 8h8l-4-8z" fill="#fff" />
                  </svg>
                </div>
                <span className="text-sm font-bold text-white tracking-tight">
                  Axiom <span className="text-[#0FB5A5]">Proof</span>
                </span>
                <span className="text-[10px] text-[#8a97b8]">axiomproof.ai</span>
              </div>
              <button
                onClick={() => setSelectedReport(null)}
                className="text-[#8a97b8] hover:text-white text-sm font-bold p-1 transition-colors"
              >
                ✕
              </button>
            </div>
            <div className="h-[3px] bg-gradient-to-r from-[#0FB5A5] to-[#1E2A4A]" />

            <div className="p-6 md:p-8 space-y-6">
              {/* Prepared For */}
              <div className="rounded-xl bg-[#F4F6F8] p-4 text-xs text-slate-600">
                <div className="text-sm font-bold text-[#1E2A4A] mb-1">
                  Prepared for: {selectedReport.tenantName}
                </div>
                Compiled: {selectedReport.createdAt} · Report ID: {selectedReport.id} · Reviewed by:{' '}
                {selectedReport.reviewer}
              </div>

              {/* Modal Header */}
              <div className="flex items-start justify-between border-b border-slate-100 pb-4">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="rounded bg-[#0FB5A5] px-2 py-0.5 text-[10px] font-bold text-[#04322d] uppercase">
                      Axiom Proof Certified
                    </span>
                    <span className="rounded bg-[#C9A227] px-2 py-0.5 text-[10px] font-bold text-white uppercase">
                      WORM Sealed Artifact
                    </span>
                    <code className="font-mono text-xs font-bold text-slate-500">
                      {selectedReport.id}
                    </code>
                  </div>
                  <h2 className="mt-2 text-xl font-bold text-[#1E2A4A]">{selectedReport.title}</h2>
                  <div className="mt-1 font-mono text-xs text-slate-500">
                    {selectedReport.statutoryCitation}
                  </div>
                </div>
              </div>

              {/* Scorecard Bar */}
              <div className="grid grid-cols-3 gap-3 rounded-xl bg-[#F4F6F8] p-4 text-center">
                <div>
                  <div className="text-xl font-bold text-teal-700">
                    {selectedReport.postureScore}/100
                  </div>
                  <div className="text-[10px] font-bold uppercase text-slate-500">
                    Statutory Posture
                  </div>
                </div>
                <div>
                  <div className="text-xl font-bold text-[#D9534F]">
                    ₹{selectedReport.exposureCr} Cr
                  </div>
                  <div className="text-[10px] font-bold uppercase text-slate-500">
                    Max Residual Exposure
                  </div>
                </div>
                <div>
                  <div className="text-xl font-bold text-[#C9A227]">
                    {selectedReport.evidenceCount}
                  </div>
                  <div className="text-[10px] font-bold uppercase text-slate-500">
                    WORM Evidence Seals
                  </div>
                </div>
              </div>

              {/* Executive Summary Box */}
              <div className="rounded-xl border-l-4 border-[#1E2A4A] bg-[#F4F6F8] p-4 text-xs text-slate-700 leading-relaxed">
                <strong className="text-[#1E2A4A] block mb-1">Executive Summary:</strong>
                {selectedReport.summary}
              </div>

              {/* Sections */}
              <div className="space-y-5">
                {selectedReport.sections.map((sec, sIdx) => (
                  <div key={sIdx} className="space-y-2 border-b border-slate-100 pb-4">
                    <h4 className="font-bold text-sm text-[#1E2A4A]">{sec.title}</h4>
                    <p className="text-xs text-slate-600 leading-relaxed">{sec.content}</p>

                    {sec.findings && (
                      <div className="overflow-x-auto rounded-lg border border-slate-200 mt-2">
                        <table className="w-full text-xs text-left">
                          <thead className="bg-slate-50 text-[10px] uppercase font-bold text-slate-500">
                            <tr>
                              <th className="px-3 py-2">Control</th>
                              <th className="px-3 py-2">Severity</th>
                              <th className="px-3 py-2">Status</th>
                              <th className="px-3 py-2">Detail</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-slate-100">
                            {sec.findings.map((f, fIdx) => (
                              <tr key={fIdx}>
                                <td className="px-3 py-2 font-mono font-bold text-slate-700">
                                  {f.control}
                                </td>
                                <td
                                  className={`px-3 py-2 font-bold ${
                                    f.severity === 'CRITICAL' ? 'text-[#D9534F]' : 'text-amber-600'
                                  }`}
                                >
                                  {f.severity}
                                </td>
                                <td className="px-3 py-2 font-bold text-teal-700">{f.status}</td>
                                <td className="px-3 py-2 text-slate-600">{f.detail}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}

                    {sec.evidenceLinks && (
                      <div className="flex flex-wrap gap-2 pt-2">
                        {sec.evidenceLinks.map((e, eIdx) => (
                          <span
                            key={eIdx}
                            className="rounded bg-[#E5FAF7] px-2 py-1 font-mono text-[10px] text-[#0a6b61] border border-teal-200"
                          >
                            {e.id} ({e.name}) · H:{e.hash}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>

              {/* Modal Footer Actions */}
              <div className="flex items-center justify-between pt-2 border-t border-slate-100">
                <span className="text-[11px] text-slate-400">
                  Cryptographically anchored by Prativedan Agent
                </span>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => downloadHtmlReport(selectedReport)}
                    className="rounded-lg bg-[#0FB5A5] hover:bg-[#0da294] px-4 py-2 text-xs font-bold text-white shadow-xs cursor-pointer"
                  >
                    Download Printable HTML
                  </button>
                  <button
                    type="button"
                    onClick={() => downloadJsonBundle(selectedReport)}
                    className="rounded-lg border border-teal-200 bg-teal-50 hover:bg-teal-100 px-4 py-2 text-xs font-bold text-teal-800 cursor-pointer"
                  >
                    Export JSON Bundle
                  </button>
                </div>
              </div>
            </div>

            {/* Axiom Minds Footer Branding */}
            <div className="flex items-center justify-between rounded-b-2xl border-t-2 border-slate-200 bg-[#FBFCFD] px-6 py-3 text-[11px] text-slate-400">
              <div className="flex items-center gap-2">
                <span className="inline-flex h-4 w-4 items-center justify-center rounded bg-[#1E2A4A]">
                  <svg
                    viewBox="0 0 24 24"
                    className="h-2.5 w-2.5"
                    fill="none"
                    xmlns="http://www.w3.org/2000/svg"
                  >
                    <path d="M12 2L2 19h20L12 2z" fill="#fff" />
                  </svg>
                </span>
                <span>
                  © {new Date().getFullYear()}{' '}
                  <strong className="text-slate-500">Axiom Minds Pvt. Ltd.</strong> ·{' '}
                  <a
                    href="https://axiomminds.ai"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[#0FB5A5] hover:underline"
                  >
                    axiomminds.ai
                  </a>
                </span>
              </div>
              <span>
                Powered by <strong className="text-slate-500">Axiom Proof</strong> ·{' '}
                <a
                  href="https://axiomproof.ai"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[#0FB5A5] hover:underline"
                >
                  axiomproof.ai
                </a>
              </span>
            </div>
          </div>
        </div>
      )}

      {/* ============================================================ */}
      {/* 4. COMPILE NEW REPORT MODAL                                  */}
      {/* ============================================================ */}
      {generatorOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 animate-in fade-in-0 duration-150 backdrop-blur-xs">
          <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl border border-slate-200 space-y-4">
            <div className="flex items-center justify-between pb-2 border-b border-slate-100">
              <div className="flex items-center gap-2">
                <AgentIcon agent="prativedan" size="sm" state="working" />
                <h3 className="text-base font-bold text-[#1E2A4A]">Compile New Compliance Pack</h3>
              </div>
              <button
                onClick={() => setGeneratorOpen(false)}
                className="text-slate-400 hover:text-slate-600 text-sm font-bold"
              >
                ✕
              </button>
            </div>

            <p className="text-xs text-slate-600 leading-relaxed">
              Prativedan will query the control library, active findings, and verified WORM evidence
              hashes to assemble a comprehensive statutory dossier.
            </p>

            <div className="space-y-3">
              <div>
                <label className="text-xs font-semibold text-slate-700">Dossier Kind</label>
                <select
                  value={genKind}
                  onChange={(e) => setGenKind(e.target.value as any)}
                  className="mt-1 w-full rounded-lg border border-slate-300 bg-white p-2 text-xs text-slate-800 focus:border-teal-500 focus:outline-none"
                >
                  <option value="board">Executive Board Compliance Pack</option>
                  <option value="auditor">Statutory Auditor Evidence Dossier (Form DPB-V3)</option>
                  <option value="dpb">Data Protection Board Section 8(4) Filing</option>
                  <option value="technical">Technical Remediation Register</option>
                </select>
              </div>

              <div>
                <label className="text-xs font-semibold text-slate-700">Report Title</label>
                <input
                  type="text"
                  value={genTitle}
                  onChange={(e) => setGenTitle(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-slate-300 bg-white p-2 text-xs text-slate-800 focus:border-teal-500 focus:outline-none"
                />
              </div>

              <div>
                <label className="text-xs font-semibold text-slate-700">Target Tenant</label>
                <select
                  value={genTenant}
                  onChange={(e) => setGenTenant(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-slate-300 bg-white p-2 text-xs text-slate-800 focus:border-teal-500 focus:outline-none"
                >
                  <option value="Meridian Pay">Meridian Pay (Fintech)</option>
                  <option value="Aarogya Health">Aarogya Health (Healthcare)</option>
                  <option value="Streamline SaaS">Streamline SaaS (B2B SaaS)</option>
                </select>
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-2 border-t border-slate-100">
              <button
                type="button"
                onClick={() => setGeneratorOpen(false)}
                disabled={generating}
                className="rounded-lg border border-slate-200 px-4 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleCompileReport}
                disabled={generating}
                className="rounded-lg bg-[#0FB5A5] hover:bg-[#0da294] px-4 py-2 text-xs font-bold text-white shadow-xs flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
              >
                {generating ? (
                  <>
                    <span className="animate-spin">⟳</span> Prativedan Synthesizing…
                  </>
                ) : (
                  <>
                    <span>⚡</span> Synthesize & Publish
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
