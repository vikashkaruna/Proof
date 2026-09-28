import { BRAND } from '@axiom/config';
import { CONTROL_LIBRARY_COUNT } from '@axiom/control-library';
import type { AgentName } from '@axiom/types';
import {
  AgentPill,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
  Badge,
} from '@axiom/ui';

export const metadata = { title: 'Agents' };

const AGENTS: Array<{
  name: AgentName;
  persona: string;
  one: string;
  long: string;
  autonomy: string;
  scopes: string[];
}> = [
  {
    name: 'drishti',
    persona: 'Discovery',
    one: "I find what you didn't know you had.",
    long: 'Drishti runs discovery across your systems — initially via interview-driven walkthroughs in Phase 1, then through live read-only connectors (PostgreSQL, MySQL, Google Workspace, M365, S3) in Phase 2. It produces a complete inventory of where personal data lives, how it flows, and where it crosses borders.',
    autonomy: 'L1 → L2 (read)',
    scopes: ['connector.read', 'inventory.write', 'evidence.write'],
  },
  {
    name: 'vibhaag',
    persona: 'Classification',
    one: 'I tell you what kind of data it is.',
    long: "Vibhaag takes Drishti's output and classifies each field by DPDPA category — name, contact, government ID, financial, health, children's data, biometric, cross-border. Confidence scores are produced; low-confidence fields are routed to a human review queue.",
    autonomy: 'L1',
    scopes: [],
  },
  {
    name: 'parikshan',
    persona: 'Assessment',
    one: 'I measure you against the law.',
    long: `Parikshan runs the gap assessment against the versioned control library (${CONTROL_LIBRARY_COUNT} controls in v0.1.0). It scores each control, weights the risk, and produces a posture score and an estimated statutory exposure. It also produces SDF self-assessments.`,
    autonomy: 'L1',
    scopes: ['control_library.read', 'findings.write'],
  },
  {
    name: 'saakshi',
    persona: 'Evidence',
    one: 'I am your witness.',
    long: 'Saakshi seals every piece of supporting evidence — policies, screenshots, configs, attestations — with a content hash and stores it in the WORM-locked evidence vault. Each artifact is linked to the controls it demonstrates.',
    autonomy: 'L1',
    scopes: ['evidence.write', 's3.write_worm'],
  },
  {
    name: 'sudhaar',
    persona: 'Remediation',
    one: 'I propose the fix. You decide.',
    long: 'Sudhaar converts each finding into a typed, parameterised remediation action with a risk score, blast radius, dependency order, and a mandatory generated rollback plan. Sudhaar holds NO write credentials (ADR-3) — it can propose, never execute.',
    autonomy: 'L1',
    scopes: ['findings.read', 'control_library.read', 'plan.write'],
  },
  {
    name: 'karya',
    persona: 'Execution',
    one: 'I only act on your approval.',
    long: 'Karya is the only mutating agent. It executes ONLY actions covered by a signed, scope-bound approval token validated per action (not per batch). Every step logs pre- and post-state to the evidence vault; the post-execution verification agent confirms the gap actually closed.',
    autonomy: 'L2 (requires approval token)',
    scopes: ['connector.write', 'evidence.write', 'rollback.execute'],
  },
  {
    name: 'lekha',
    persona: 'Audit',
    one: 'I remember everything, forever.',
    long: 'Lekha writes the immutable, hash-chained audit ledger. Every agent action, every human approval, every state change — recorded in order, with a chain verifiable end-to-end by any independent reviewer. The chain is the product.',
    autonomy: 'L1',
    scopes: ['ledger.append', 'ledger.read'],
  },
  {
    name: 'nazar',
    persona: 'Regulatory watch',
    one: "I watch the law so you don't have to.",
    long: "Nazar monitors MeitY notifications, the Data Protection Board's orders, and the gazette. When a regulatory change is detected, Nazar maps it to affected controls in the library and raises a re-assessment prompt.",
    autonomy: 'L1',
    scopes: ['http.read.government_sources', 'control_library.write'],
  },
  {
    name: 'prativedan',
    persona: 'Reporting',
    one: 'I turn findings into documents.',
    long: 'Prativedan generates Board reports, auditor packs, and DPB-ready submissions. Every claim in a report is traceable to a specific evidence artifact. The founder reviews and signs off before any report reaches a client.',
    autonomy: 'L1',
    scopes: ['report.write', 'pdf.render'],
  },
  {
    name: 'sanket',
    persona: 'Market signal',
    one: "I find who's about to buy.",
    long: "Sanket reads public sources (hiring posts, tender notices, regulatory filings) for buying-intent signals relevant to DPDPA. Internal-only — used to fuel the founder's GTM, not a customer-facing product.",
    autonomy: 'L1 (internal)',
    scopes: ['http.read.public_sources'],
  },
  {
    name: 'samadhan',
    persona: 'Maker-Checker & Reconciler',
    one: 'I prove that execution matched your plan and your approval.',
    long: 'Samadhan enforces dual-control maker-checker integrity over Karya executions. It reconciles post-execution reality against approved scope, detects parameter-level drift, sweeps unexecuted actions back to approved status, and cryptographically signs the reconciliation statement with an approval-keyed HMAC.',
    autonomy: 'L1',
    scopes: ['plan.read', 'batch.read', 'reconciliation.write', 'ledger.append'],
  },
  {
    name: 'pramaan',
    persona: 'Statutory Closure & Proof Attestation',
    one: 'I turn findings, ledgers, and evidence into unassailable, auditor-ready proof.',
    long: 'Pramaan is the master synthesis authority for statutory closure. It aggregates findings, remediation tokens, execution batches, Saakshi WORM evidence manifests, and Lekha Merkle root hashes into an authoritative closure pack sealed with the Gold ProofSeal under Founder co-signature.',
    autonomy: 'L1',
    scopes: [
      'findings.read',
      'plan.read',
      'reconciliation.read',
      'evidence.read',
      'ledger.read',
      'dossier.write',
      'pdf.render',
    ],
  },
] as const;

import { AgentsInteractiveRoster } from './agents-interactive-roster';

export default function AgentsPage() {
  return (
    <main className="mx-auto max-w-5xl px-4 py-16 sm:px-6">
      <Badge variant="indigo">12 agents</Badge>
      <h1 className="mt-2 font-heading text-3xl font-semibold tracking-tight text-indigo-500 sm:text-4xl">
        The {BRAND.name} agent roster
      </h1>
      <p className="mt-3 max-w-2xl text-lg text-slate-600">
        Each agent has a contract, an autonomy ceiling, declared tool permissions, and explicit
        escalation conditions. The agents are versioned services with their own prompt registry and
        model assignments.
      </p>

      <div className="mt-10">
        <AgentsInteractiveRoster agents={AGENTS} />
      </div>
    </main>
  );
}
