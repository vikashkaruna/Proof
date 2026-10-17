import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildLibrarySeed,
  buildLibrarySeedForVersion,
  buildRuntimeMirror,
  controls,
  DEFAULT_LIBRARY_VERSION,
  KNOWN_LIBRARY_VERSIONS,
  LIBRARY_VERSION,
  PUBLIC_CONTROL_CATALOGUE_V2_MANIFEST_TEXT,
  resolveControlLibrary,
  runtimeMirrorFileName,
} from '../../index';
import { controls_0_2_0 } from './controls';

const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
const dataDir = join(__dirname, '../../../../../services/agent-runtime/src/axiom/data');

/**
 * Published 0.1.1 bytes, pinned before 0.2.0 was authored (2026-10-17, branch
 * base origin/staging 3e525eb9). Historical assessments and reports verify
 * against these; adding a version must never move them.
 */
const PINNED_0_1_1 = {
  seed: 'b13d69819e2984fc2a48ba393770a5a376bc94d8da7ad5cf3d1bb6dfa2d37555',
  controls: '4d226c487e78383b759314edb0893a7d42930e08a44c8ec8b9c7a8e075589964',
  // Also embedded in migration 0134 and public-evidence-mapping-v2.test.ts.
  publicEvidenceManifest: '3bdf816d71e132b23f849f5d5b497d8f0a8874afa124aed31be8652ec6ab31c6',
  runtimeMirror: '948627fb1b60a59918d2196b81babbf26251ad76842db82f465f829731e9b648',
};

describe('published 0.1.1 is byte-identical after 0.2.0 exists', () => {
  it('keeps the default version at 0.1.1', () => {
    expect(LIBRARY_VERSION).toBe('0.1.1');
    expect(DEFAULT_LIBRARY_VERSION).toBe('0.1.1');
  });

  it('keeps the seed, controls and public-evidence manifest hashes', () => {
    expect(sha(JSON.stringify(buildLibrarySeed()))).toBe(PINNED_0_1_1.seed);
    expect(sha(JSON.stringify(controls))).toBe(PINNED_0_1_1.controls);
    expect(sha(PUBLIC_CONTROL_CATALOGUE_V2_MANIFEST_TEXT)).toBe(
      PINNED_0_1_1.publicEvidenceManifest,
    );
  });

  it('resolves 0.1.1 by version to the same seed bytes as the legacy builder', () => {
    expect(JSON.stringify(buildLibrarySeedForVersion('0.1.1'))).toBe(
      JSON.stringify(buildLibrarySeed()),
    );
    expect(resolveControlLibrary('0.1.1').controls).toBe(controls);
  });

  it('keeps the committed 0.1.1 runtime mirror bytes', () => {
    const text = readFileSync(join(dataDir, 'controls.json'), 'utf8');
    expect(sha(text)).toBe(PINNED_0_1_1.runtimeMirror);
    expect(JSON.stringify(buildRuntimeMirror('0.1.1'), null, 2)).toBe(text);
  });

  it('building 0.2.0 does not mutate any 0.1.1 control object', () => {
    for (const [i, c] of controls_0_2_0.entries()) expect(c).not.toBe(controls[i]);
    expect(sha(JSON.stringify(controls))).toBe(PINNED_0_1_1.controls);
  });
});

describe('TS / Python mirror parity per version', () => {
  it.each(KNOWN_LIBRARY_VERSIONS.map((v) => [v]))(
    'committed mirror for %s equals the TypeScript source',
    (version) => {
      const text = readFileSync(join(dataDir, runtimeMirrorFileName(version)), 'utf8');
      expect(text).toBe(JSON.stringify(buildRuntimeMirror(version), null, 2));
      const parsed = JSON.parse(text) as {
        version: string;
        controls: { library_version: string }[];
      };
      expect(parsed.version).toBe(version);
      expect(parsed.controls.every((c) => c.library_version === version)).toBe(true);
    },
  );

  it('names version mirrors without moving the historical file', () => {
    expect(runtimeMirrorFileName('0.1.1')).toBe('controls.json');
    expect(runtimeMirrorFileName('0.2.0')).toBe('controls-0.2.0.json');
    expect(() => runtimeMirrorFileName('9.9.9')).toThrow('Unknown control library version');
  });
});
