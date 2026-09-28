#!/usr/bin/env tsx
/**
 * ==============================================================================
 * Axiom Proof — Sovereign Offline License Verification Utility
 * ==============================================================================
 * Verifies an air-gapped offline license token against the root public key.
 *
 * Usage:
 *   tsx scripts/verify-license.ts <TOKEN>
 *   or tsx scripts/verify-license.ts --file /path/to/license.txt
 *   or tsx scripts/verify-license.ts (reads AXIOM_OFFLINE_LICENSE from env)
 * ==============================================================================
 */

import { readFileSync, existsSync } from 'node:fs';
import { verifyOfflineLicense } from '../packages/config/src/license';

function parseArgs(args: string[]) {
  const result: { token?: string; file?: string } = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--file' && args[i + 1]) {
      result.file = args[i + 1];
      i++;
    } else if (!arg.startsWith('--')) {
      result.token = arg;
    }
  }
  return result;
}

function resolveToken(): string {
  const args = parseArgs(process.argv.slice(2));
  if (args.file) {
    if (!existsSync(args.file)) {
      console.error(`[-] Error: File not found: ${args.file}`);
      process.exit(1);
    }
    return readFileSync(args.file, 'utf-8').trim();
  }
  if (args.token) {
    return args.token.trim();
  }
  if (process.env.AXIOM_OFFLINE_LICENSE) {
    return process.env.AXIOM_OFFLINE_LICENSE.trim();
  }
  console.error('[-] Error: No license token provided. Pass as argument, --file <path>, or via AXIOM_OFFLINE_LICENSE env var.');
  process.exit(1);
}

async function main() {
  const token = resolveToken();
  const result = verifyOfflineLicense(token);

  console.log('======================================================================');
  console.log(' Axiom Proof — Sovereign Offline License Verification');
  console.log('======================================================================');

  if (!result.valid || !result.payload) {
    console.error(`[x] LICENSE VERIFICATION FAILED: ${result.error}`);
    process.exit(1);
  }

  const { payload, daysRemaining } = result;
  console.log('[✓] CRYPTOGRAPHIC SIGNATURE VALID (Signed by Axiom Minds Authority)');
  console.log(`License ID:     ${payload.licenseId}`);
  console.log(`Licensee:       ${payload.licensee}`);
  console.log(`Tier:           ${payload.tier}`);
  console.log(`Environment:    ${payload.environment}`);
  console.log(`Issued At:      ${payload.issuedAt}`);
  console.log(`Expires At:     ${payload.expiresAt} (${daysRemaining} days remaining)`);
  console.log(`Max Tenants:    ${payload.maxTenants}`);
  console.log(`Max Nodes:      ${payload.maxNodes}`);
  console.log(`Features:       ${payload.features.join(', ')}`);
  console.log('----------------------------------------------------------------------');
  console.log('STATUS: ACTIVE & VALID');
  console.log('======================================================================');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
