import { spawn } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { assessmentContainerFactory } from './assessment-container.js';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));
const config = {
  executable: '/usr/local/bin/docker',
  dockerHost: 'unix:///var/run/docker.sock',
  image: `sha256:${'a'.repeat(64)}`,
  workloadApiVolume: 'axiom-workload-api-synthetic',
};
afterEach(() => vi.clearAllMocks());
describe('trusted per-job container launcher', () => {
  it('creates separate jobs from a captured configuration without ambient secrets', () => {
    const local = { ...config };
    const launch = assessmentContainerFactory(local);
    local.image = `sha256:${'b'.repeat(64)}`;
    vi.stubEnv('SYNTHETIC_BACKEND_SECRET', 'never-forward');
    try {
      launch();
      launch();
      const calls = vi.mocked(spawn).mock.calls;
      const first = calls[0]![1] as string[];
      const second = calls[1]![1] as string[];
      expect(first[first.indexOf('--name') + 1]).not.toBe(second[second.indexOf('--name') + 1]);
      expect(first).toContain(config.image);
      expect(first).not.toContain(local.image);
      expect(calls[0]![2]).toEqual({
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          PATH: '/usr/local/bin:/usr/bin:/bin',
          DOCKER_CONFIG: '/nonexistent/axiom-docker-config',
        },
      });
      for (const flag of ['--privileged', '--pid', '--env', '--volume', '--device', '--publish'])
        expect(first).not.toContain(flag);
      expect(first.slice(-4)).toEqual([
        config.image,
        '-m',
        'axiom.assessment_supervisor',
        '--private-stdio',
      ]);
      expect(first[first.indexOf('--log-driver') + 1]).toBe('none');
      expect(first[first.indexOf('--network') + 1]).toBe('none');
      expect(first[first.indexOf('--mount') + 1]).toBe(
        'type=volume,src=axiom-workload-api-synthetic,dst=/run/workload,readonly,volume-nocopy',
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it.each([
    { image: 'worker:latest' },
    { image: config.image + '\n' },
    { dockerHost: 'tcp://remote:2375' },
    { dockerHost: 'unix://relative.sock' },
    { dockerHost: config.dockerHost + '\n' },
    { executable: 'docker' },
    { executable: '/bin/docker\n' },
    { workloadApiVolume: 'arbitrary-volume' },
    { workloadApiVolume: config.workloadApiVolume + ',dst=/root' },
    { workloadApiVolume: config.workloadApiVolume + '\n' },
    { environment: { PRIVATE: 'synthetic' } },
    { command: ['/bin/sh'] },
    { pid: 'host' },
    { network: 'host' },
    { mounts: ['/var/run/docker.sock'] },
  ])('refuses mutable images, remote daemons and unreviewed launch overrides', (change) => {
    expect(() => assessmentContainerFactory({ ...config, ...change })).toThrow(
      'Assessment container configuration refused',
    );
    expect(spawn).not.toHaveBeenCalled();
  });
});
