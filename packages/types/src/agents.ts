import { z } from 'zod';
import { AgentName } from './enums';

/**
 * Per-agent contracts. Each agent declares:
 *   - Its inputs (typed)
 *   - Its outputs (typed)
 *   - Its tool permissions
 *   - Its autonomy ceiling (per Doc 04 §5.2)
 *   - The escalation conditions under which it pauses for human review
 *
 * The agent runtime uses these contracts to validate inputs and outputs
 * at runtime, and the workbench UI uses them to render the right review
 * surface for each agent's output.
 */

export const AgentContractSchema = z
  .object({
    name: z.nativeEnum(AgentName),
    displayName: z.string(),
    oneLiner: z.string(),
    // 'L0' = L0 agent-assisted, etc. Per Doc 04 §5.2
    autonomyLevel: z.enum(['L0', 'L1', 'L2', 'L3', 'L4']),
    // Compatibility alias for mutatesClientEstate; neither field grants authority.
    canMutate: z.boolean(),
    mutatesClientEstate: z.boolean(),
    // Produces changes to Axiom domain records; excludes ordinary run telemetry.
    // This metadata grants no database credentials or execution permission.
    writesAxiomState: z.boolean(),
    // The Zod schema of inputs the agent accepts
    inputSchema: z.custom<z.ZodTypeAny>(
      (value) => value instanceof z.ZodType,
      'inputSchema must be a Zod schema',
    ),
    // The Zod schema of outputs the agent returns
    outputSchema: z.custom<z.ZodTypeAny>(
      (value) => value instanceof z.ZodType,
      'outputSchema must be a Zod schema',
    ),
    // Tool permission scopes (e.g. 'connector.read.postgres', 'evidence.write')
    toolScopes: z.array(z.string()),
    // When the agent must pause for human review
    escalationConditions: z.array(z.string()),
    // Phase at which the agent becomes operationally relevant
    phase: z.number().int().min(0).max(5),
  })
  .refine((contract) => contract.canMutate === contract.mutatesClientEstate, {
    message: 'canMutate must match mutatesClientEstate',
    path: ['canMutate'],
  });
export type AgentContract = z.infer<typeof AgentContractSchema>;

// The roster of contracts is static at compile-time. Each agent's
// implementation in services/agent-runtime is responsible for actually
// enforcing its contract.

export const AGENT_CONTRACTS: Record<AgentName, AgentContract> = {
  drishti: {
    name: 'drishti',
    displayName: 'Drishti',
    oneLiner: "I find what you didn't know you had.",
    autonomyLevel: 'L1', // L2 with read-only connectors in Phase 2
    canMutate: false,
    mutatesClientEstate: false,
    writesAxiomState: true,
    inputSchema: z.unknown(),
    outputSchema: z.unknown(),
    toolScopes: ['connector.read', 'inventory.write', 'evidence.write'],
    escalationConditions: [
      'discovers_health_data',
      'discovers_children_data',
      'cross_border_transfer_detected',
    ],
    phase: 1,
  },
  vibhaag: {
    name: 'vibhaag',
    displayName: 'Vibhaag',
    oneLiner: 'I tell you what kind of data it is.',
    autonomyLevel: 'L1',
    canMutate: false,
    mutatesClientEstate: false,
    writesAxiomState: false,
    inputSchema: z.unknown(),
    outputSchema: z.unknown(),
    toolScopes: [], // Operates on discovery output only
    escalationConditions: ['low_confidence_classification', 'ambiguous_field'],
    phase: 1,
  },
  parikshan: {
    name: 'parikshan',
    displayName: 'Parikshan',
    oneLiner: 'I measure you against the law.',
    autonomyLevel: 'L1',
    canMutate: false,
    mutatesClientEstate: false,
    writesAxiomState: true,
    inputSchema: z.unknown(),
    outputSchema: z.unknown(),
    toolScopes: ['control_library.read', 'findings.write'],
    escalationConditions: ['novel_finding_pattern', 'control_version_mismatch'],
    phase: 0,
  },
  saakshi: {
    name: 'saakshi',
    displayName: 'Saakshi',
    oneLiner: 'I am your witness.',
    autonomyLevel: 'L1',
    canMutate: false,
    mutatesClientEstate: false,
    writesAxiomState: true,
    inputSchema: z.unknown(),
    outputSchema: z.unknown(),
    toolScopes: ['evidence.write', 's3.write_worm'],
    escalationConditions: ['large_evidence_artifact', 'pii_in_artifact'],
    phase: 1,
  },
  sudhaar: {
    name: 'sudhaar',
    displayName: 'Sudhaar',
    oneLiner: 'I propose the fix. You decide.',
    autonomyLevel: 'L1',
    canMutate: false, // Planning agent holds NO write credentials (ADR-3)
    mutatesClientEstate: false,
    writesAxiomState: true,
    inputSchema: z.unknown(),
    outputSchema: z.unknown(),
    toolScopes: ['findings.read', 'control_library.read', 'plan.propose'],
    escalationConditions: [
      'novel_remediation_pattern',
      'high_blast_radius',
      'cross_tenant_pattern',
    ],
    phase: 1,
  },
  karya: {
    name: 'karya',
    displayName: 'Karya',
    oneLiner: 'I only act on your approval.',
    autonomyLevel: 'L2', // Requires approval token (ADR-2)
    canMutate: true,
    mutatesClientEstate: true,
    writesAxiomState: true,
    inputSchema: z.unknown(),
    outputSchema: z.unknown(),
    toolScopes: [
      'connector.write', // Scoped, time-bound, revocable
      'evidence.write',
      'rollback.execute',
    ],
    escalationConditions: [
      'blast_radius_exceeded',
      'token_invalid',
      'token_expired',
      'token_revoked',
      'kill_switch_active',
    ],
    phase: 3,
  },
  lekha: {
    name: 'lekha',
    displayName: 'Lekha',
    oneLiner: 'I remember everything, forever.',
    autonomyLevel: 'L1',
    canMutate: false, // Only appends to the ledger
    mutatesClientEstate: false,
    writesAxiomState: true,
    inputSchema: z.unknown(),
    outputSchema: z.unknown(),
    toolScopes: ['ledger.append', 'ledger.read'],
    escalationConditions: ['chain_verification_failure'],
    phase: 2,
  },
  nazar: {
    name: 'nazar',
    displayName: 'Nazar',
    oneLiner: "I watch the law so you don't have to.",
    autonomyLevel: 'L1',
    canMutate: false,
    mutatesClientEstate: false,
    writesAxiomState: true,
    inputSchema: z.unknown(),
    outputSchema: z.unknown(),
    // SEC-15: Nazar previously held `control_library.write`. The architecture
    // (04 §5.2) grants it "external sources read" only, and the implementation
    // granted more. That is the wrong shape at any time and actively dangerous
    // after W7.0: the control library is the definition of what compliance
    // MEANS, so letting an L1 agent that ingests untrusted government web pages
    // write to it turns a poisoned or misread gazette page into a silent change
    // to every client's posture, with no human in the loop.
    //
    // Its correct scope is to PROPOSE. It writes a `regulatory_signals` row; a
    // human accepts it; only then is a new baseline and library version cut.
    // Same maker-checker pattern as Sudhaar/Karya, applied to the rulebook.
    toolScopes: ['http.read.government_sources', 'regulatory_signal.write'],
    escalationConditions: ['regulatory_change_detected'],
    phase: 2,
  },
  prativedan: {
    name: 'prativedan',
    displayName: 'Prativedan',
    oneLiner: 'I turn findings into documents.',
    autonomyLevel: 'L1',
    canMutate: false,
    mutatesClientEstate: false,
    writesAxiomState: true,
    inputSchema: z.unknown(),
    outputSchema: z.unknown(),
    toolScopes: [
      'findings.read',
      'evidence.read',
      'control_library.read',
      'report.write',
      'pdf.render',
    ],
    escalationConditions: ['report_includes_unverified_claim'],
    phase: 0,
  },
  sanket: {
    name: 'sanket',
    displayName: 'Sanket',
    oneLiner: "I find who's about to buy.",
    autonomyLevel: 'L1', // Internal GTM only
    canMutate: false,
    mutatesClientEstate: false,
    writesAxiomState: false,
    inputSchema: z.unknown(),
    outputSchema: z.unknown(),
    toolScopes: ['http.read.public_sources'],
    escalationConditions: ['high_intent_signal'],
    phase: 4,
  },
};
