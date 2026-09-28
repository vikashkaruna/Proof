#!/usr/bin/env tsx
/**
 * ==============================================================================
 * Axiom Proof — Sovereign Offline License Minting Utility
 * ==============================================================================
 * Mints cryptographically signed, air-gapped offline license tokens for
 * on-premise enterprise deployments (W10).
 *
 * Usage:
 *   tsx scripts/mint-license.ts \
 *     --licensee "Acme Corp Sovereign Intranet" \
 *     --tier enterprise-airgapped \
 *     --days 365 \
 *     --max-tenants 10 \
 *     --max-nodes 100 \
 *     --features "evidence_vault_worm,offline_llm,airgapped_mfa,multi_regulator_bfsi,standing_policies"
 * ==============================================================================
 */

import {
  mintOfflineLicense,
  verifyOfflineLicense,
  type OfflineLicensePayload,
  type OfflineLicenseTier,
} from '../packages/config/src/license';

// Default Axiom Minds Root Authority Private Key for minting sovereign licenses
const AXIOM_ROOT_AUTHORITY_PRIVATE_KEY =
  process.env.AXIOM_LICENSE_AUTHORITY_PRIVATE_KEY ||
  `-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEIM+Xo6dK7vqEwOeJ8a19E9qrLHsyqXCiAVJwJ7WpMsxg
-----END PRIVATE KEY-----`;

function parseArgs(args: string[]) {
  const result: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith('--')) {
        result[key] = next;
        i++;
      } else {
        result[key] = 'true';
      }
    }
  }
  return result;
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));

  const licensee = flags.licensee || 'Axiom Proof Sovereign Customer';
  const tier = (flags.tier as OfflineLicenseTier) || 'enterprise-airgapped';
  const days = parseInt(flags.days || '365', 10);
  const maxTenants = parseInt(flags['max-tenants'] || '10', 10);
  const maxNodes = parseInt(flags['max-nodes'] || '50', 10);
  const features = flags.features
    ? flags.features.split(',').map((f) => f.trim())
    : [
        'evidence_vault_worm',
        'offline_llm',
        'airgapped_mfa',
        'multi_regulator_bfsi',
        'standing_policies',
        'continuous_monitoring',
      ];

  const now = new Date();
  const expiresAt = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
  const licenseId = `LIC-${now.getFullYear()}-${Math.random().toString(36).substring(2, 10).toUpperCase()}`;

  const payload: OfflineLicensePayload = {
    licenseId,
    licensee,
    environment: 'onprem',
    tier,
    issuedAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
    maxTenants,
    maxNodes,
    features,
  };

  const token = mintOfflineLicense(payload, AXIOM_ROOT_AUTHORITY_PRIVATE_KEY);
  const verifyResult = verifyOfflineLicense(token);

  if (!verifyResult.valid) {
    console.error('[-] Self-verification of minted token failed:', verifyResult.error);
    process.exit(1);
  }

  console.log('======================================================================');
  console.log(' Axiom Proof — Sovereign Offline License Minted');
  console.log('======================================================================');
  console.log(`License ID:     ${payload.licenseId}`);
  console.log(`Licensee:       ${payload.licensee}`);
  console.log(`Tier:           ${payload.tier}`);
  console.log(`Environment:    ${payload.environment}`);
  console.log(`Issued At:      ${payload.issuedAt}`);
  console.log(`Expires At:     ${payload.expiresAt} (${days} days)`);
  console.log(`Max Tenants:    ${payload.maxTenants}`);
  console.log(`Max Nodes:      ${payload.maxNodes}`);
  console.log(`Features:       ${payload.features.join(', ')}`);
  console.log('----------------------------------------------------------------------');
  console.log('OFFLINE LICENSE TOKEN (Set AXIOM_OFFLINE_LICENSE in .env.onprem):');
  console.log(token);
  console.log('======================================================================');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
