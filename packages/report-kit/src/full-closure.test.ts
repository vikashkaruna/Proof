import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, it, expect } from 'vitest';
import { zipSync, unzipSync } from 'fflate';
import {
  buildPramaanFullClosureArchive,
  verifyFullClosureSource,
  verifyPramaanFullClosureArchive,
  fullClosureMerkleRoot,
} from './full-closure.js';
import { fullClosureFixture, fullClosureSha } from './full-closure.test-helper.js';
describe('full closure exact recorded scope', () => {
  it('composes deterministic bytes and independently verifies all members, ledger and Merkle root', () => {
    const f = fullClosureFixture(),
      a = buildPramaanFullClosureArchive(f),
      b = buildPramaanFullClosureArchive(f);
    expect(a.archive.equals(b.archive)).toBe(true);
    expect(a.merkleRoot).toBe(fullClosureMerkleRoot(f.sourceSha256, f.source.components));
    const verified = verifyPramaanFullClosureArchive({ ...f, ...a });
    expect(verified.source).toEqual(f.source);
    expect(verified.manifest.members).toHaveLength(10);
  });
  it.each([
    'digest',
    'scope',
    'missing-kind',
    'duplicate',
    'ledger-hash',
    'ledger-link',
    'ledger-head',
    'scope-claim',
  ])('refuses %s', (kind) => {
    const f = fullClosureFixture();
    if (kind === 'scope') f.source.components[0]!.tenant_id = f.reportId;
    if (kind === 'missing-kind') f.source.components[4]!.kind = 'board_executive';
    if (kind === 'duplicate') f.source.components[1]!.id = f.source.components[0]!.id;
    if (kind === 'ledger-hash') f.source.ledger_chain[0]!.payload_text += 'edited';
    if (kind === 'ledger-link')
      Object.assign(f.source.ledger_chain[0]!, { previous_hash: 'a'.repeat(64) });
    if (kind === 'ledger-head') f.source.ledger_head = 'a'.repeat(64);
    if (kind === 'scope-claim') Object.assign(f.source, { independent_audit_asserted: true });
    const text = JSON.stringify(f.source);
    expect(() =>
      verifyFullClosureSource(text, kind === 'digest' ? 'a'.repeat(64) : fullClosureSha(text), f),
    ).toThrow();
  });
  it('refuses substituted version bytes and missing components', () => {
    const f = fullClosureFixture();
    f.members[0]!.bytes = Buffer.from('substituted');
    expect(() => buildPramaanFullClosureArchive(f)).toThrow('full_closure_exact_version_refused');
    f.members.pop();
    expect(() => buildPramaanFullClosureArchive(f)).toThrow('full_closure_members_refused');
  });
  it('refuses edited archive and a replacement manifest even with a new archive hash', () => {
    const f = fullClosureFixture(),
      a = buildPramaanFullClosureArchive(f);
    const files = unzipSync(a.archive);
    files['README.txt'] = Buffer.from('misrepresented');
    const edited = zipSync(files, { level: 0 });
    expect(() => verifyPramaanFullClosureArchive({ ...f, ...a, archive: edited })).toThrow(
      'full_closure_archive_digest_refused',
    );
    expect(() =>
      verifyPramaanFullClosureArchive({
        ...f,
        ...a,
        archive: edited,
        archiveSha256: fullClosureSha(edited),
      }),
    ).toThrow('full_closure_member_digest_refused');
  });
  it('refuses unexpected archive paths before extraction', () => {
    const f = fullClosureFixture(),
      a = buildPramaanFullClosureArchive(f),
      files = unzipSync(a.archive);
    files['../unsafe'] = Buffer.from('x');
    const edited = zipSync(files, { level: 0 });
    expect(() =>
      verifyPramaanFullClosureArchive({
        ...f,
        ...a,
        archive: edited,
        archiveSha256: fullClosureSha(edited),
      }),
    ).toThrow('full_closure_zip_members_refused');
  });
});

it('delivers a standalone offline verifier with successful and tampered digest cases', () => {
  const f = fullClosureFixture(),
    a = buildPramaanFullClosureArchive(f),
    files = unzipSync(a.archive);
  const folder = mkdtempSync(join(tmpdir(), 'axiom-full-offline-'));
  try {
    const script = join(folder, 'verify_full_closure.py'),
      archive = join(folder, 'closure.zip');
    writeFileSync(script, files['verify_full_closure.py']!);
    writeFileSync(archive, a.archive);
    const args = [
      script,
      archive,
      '--archive-sha256',
      a.archiveSha256,
      '--manifest-sha256',
      a.manifestSha256,
      '--tenant',
      f.tenantId,
      '--engagement',
      f.engagementId,
      '--report',
      f.reportId,
    ];
    const success = spawnSync('python3', args, { encoding: 'utf8', timeout: 10000 });
    expect(success.stderr).toBe('');
    expect(success.status).toBe(0);
    expect(success.stdout).toContain('VERIFIED: recorded bytes');
    args[args.indexOf(a.manifestSha256)] = 'a'.repeat(64);
    const refused = spawnSync('python3', args, { encoding: 'utf8', timeout: 10000 });
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain('REFUSED:');
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});
