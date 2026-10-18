/** Explicit local synthetic deployment only. No enrollment or credential minting. */
import { loadEnv } from '@axiom/config';
import type { ApprovalEngine } from '@axiom/approval-engine';
import { JwtSvidVerifier } from '../workloads/jwt-svid.js';
import { WorkloadApiJwtTrust } from '../workloads/workload-api-trust.js';
import {
  readOwnedSyntheticConfiguration,
  ownedTargetControllerFactory,
} from './owned-synthetic-composition.js';
import { OwnedExecutionBroker } from './owned-execution-broker.js';
export function createConfiguredOwnedExecution(
  approval: Pick<ApprovalEngine, 'sign'>,
  source: NodeJS.ProcessEnv = process.env,
) {
  if (source.AXIOM_OWNED_EXECUTION_ENABLED !== 'true') return null;
  const config = readOwnedSyntheticConfiguration(source);
  if (!config || !source.AXIOM_OWNED_EXECUTION_TRUST_SOCKET) return null;
  try {
    const trust = new WorkloadApiJwtTrust({
      socketPath: source.AXIOM_OWNED_EXECUTION_TRUST_SOCKET,
      trustDomains: ['local.axiomproof.test'],
    });
    const env = loadEnv(source);
    return new OwnedExecutionBroker({
      approval,
      identity: new JwtSvidVerifier(
        {
          audience: 'axiom-owned-synthetic-execution',
          trustDomains: ['local.axiomproof.test'],
          maxLifetimeSeconds: 300,
        },
        trust,
      ),
      target: ownedTargetControllerFactory(
        env.SUPABASE_URL,
        env.SUPABASE_ANON_KEY,
        config.targetKey,
      ),
    });
  } catch {
    return null;
  }
}
