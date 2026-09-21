import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AgentContractSchema, AGENT_CONTRACTS } from './agents';

const baseContract = {
  name: 'drishti' as const,
  displayName: 'Drishti',
  oneLiner: 'Discovery',
  autonomyLevel: 'L1' as const,
  canMutate: false,
  mutatesClientEstate: false,
  writesAxiomState: true,
  inputSchema: z.object({ tenantId: z.string().uuid() }),
  outputSchema: z.object({ findings: z.array(z.string()) }),
  toolScopes: [],
  escalationConditions: [],
  phase: 1,
};

describe('agent contracts', () => {
  it('requires actual Zod schemas at the contract boundary', () => {
    expect(AgentContractSchema.parse(baseContract).inputSchema).toBeInstanceOf(z.ZodType);
    expect(() => AgentContractSchema.parse({ ...baseContract, inputSchema: {} })).toThrow(
      'inputSchema must be a Zod schema',
    );
  });

  it('keeps the static roster aligned with runtime permissions', () => {
    expect(AGENT_CONTRACTS.sudhaar.toolScopes).toContain('plan.propose');
    expect(AGENT_CONTRACTS.sudhaar.toolScopes).not.toContain('plan.write');
    expect(AGENT_CONTRACTS.karya.canMutate).toBe(true);
    expect(AGENT_CONTRACTS.sudhaar.canMutate).toBe(false);
  });
});

/**
 * W7.0 · SEC-15 — the separation-of-duties contract, pinned.
 *
 * `04_Solution_Architecture.md §5.2` calls separation of duties "a genuine
 * security property, not a talking point". SEC-14 observes that today it is a
 * talking point: `tool_scopes` is declared here and again in the Python agent
 * modules, and repo-wide it is READ in exactly one place — to serialise it into
 * an API response for display. Nothing enforces it.
 *
 * Enforcement is W4.3. Until then these tests do the one thing that can be done
 * cheaply and is worth doing: stop the declarations drifting from the
 * architecture, and stop the specific grant that SEC-15 found.
 */
describe('agent tool scopes — SEC-15 · separation of duties', () => {
  const contracts = Object.values(AGENT_CONTRACTS);

  it('grants control_library.write to no agent', () => {
    // The control library is the definition of what compliance MEANS. It is
    // changed by a human accepting a proposed baseline delta, never by an
    // agent — least of all by one that ingests untrusted web content.
    for (const c of contracts) {
      expect(c.toolScopes, `${c.name} holds control_library.write`).not.toContain(
        'control_library.write',
      );
    }
  });

  it('gives Nazar read-only external access plus the right to PROPOSE', () => {
    expect(AGENT_CONTRACTS.nazar.toolScopes).toEqual([
      'http.read.government_sources',
      'regulatory_signal.write',
    ]);
    expect(AGENT_CONTRACTS.nazar.canMutate).toBe(false);
    expect(AGENT_CONTRACTS.nazar.autonomyLevel).toBe('L1');
  });

  it('keeps planning and execution in different hands (BR-1 maker-checker)', () => {
    // The headline claim is "Sudhaar can never execute". Today that holds
    // because Sudhaar has no code path to an executor, not because a
    // permission system prevents it — so pin the declaration at least.
    expect(AGENT_CONTRACTS.sudhaar.canMutate).toBe(false);
    expect(AGENT_CONTRACTS.karya.canMutate).toBe(true);
  });

  it('lets exactly one agent mutate a client estate', () => {
    const mutators = contracts.filter((c) => c.canMutate).map((c) => c.name);
    expect(mutators).toEqual(['karya']);
  });

  it('declares a scope list for every agent', () => {
    for (const c of contracts) {
      expect(Array.isArray(c.toolScopes), `${c.name} has no toolScopes`).toBe(true);
    }
  });
});

describe('explicit mutation metadata', () => {
  it('preserves the compatibility flag and distinguishes internal records from client writes', () => {
    for (const contract of Object.values(AGENT_CONTRACTS)) {
      expect(contract.mutatesClientEstate).toBe(contract.canMutate);
      expect(contract.mutatesClientEstate).toBe(contract.name === 'karya');
    }
    expect(() => AgentContractSchema.parse({ ...baseContract, canMutate: true })).toThrow(
      'canMutate must match mutatesClientEstate',
    );
    expect(AGENT_CONTRACTS.sudhaar.writesAxiomState).toBe(true);
    expect(AGENT_CONTRACTS.nazar.writesAxiomState).toBe(true);
    expect(AGENT_CONTRACTS.vibhaag.writesAxiomState).toBe(false);
    expect(AGENT_CONTRACTS.prativedan.toolScopes).toEqual([
      'findings.read',
      'evidence.read',
      'control_library.read',
      'report.write',
      'pdf.render',
    ]);
  });
});
