import { spawn } from 'node:child_process';
import { afterEach, expect, it, vi } from 'vitest';
import { prativedanContainerFactory } from './prativedan-container.js';
vi.mock('node:child_process', () => ({ spawn: vi.fn() }));
afterEach(() => vi.clearAllMocks());
it('launches distinct fixed processes with no credential/workload mounts or ambient env', () => {
  const config = {
    executable: '/usr/local/bin/docker',
    dockerHost: 'unix:///var/run/docker.sock',
    image: `sha256:${'a'.repeat(64)}`,
    resourcePrefix: 'axiom-proof-local-prativedan',
  };
  for (const role of ['computation', 'renderer'] as const)
    prativedanContainerFactory(config, role)();
  for (const [executable, raw, options] of vi.mocked(spawn).mock.calls) {
    const args = raw as string[];
    expect(executable).toBe(config.executable);
    expect(args).toContain('none');
    expect(args).toContain('--read-only');
    expect(args).toContain('no-new-privileges');
    for (const forbidden of [
      '--mount',
      '--volume',
      '--env',
      '--device',
      '--privileged',
      '--publish',
    ])
      expect(args).not.toContain(forbidden);
    expect(options).toEqual({
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        PATH: '/usr/local/bin:/usr/bin:/bin',
        DOCKER_CONFIG: '/nonexistent/axiom-docker-config',
      },
    });
  }
});
