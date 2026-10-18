import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { AssessmentProcessFactory } from './assessment-channel.js';

export const prativedanContainerConfiguration = z.strictObject({
  executable: z.string().regex(/^\/[A-Za-z0-9_./ -]+$/),
  dockerHost: z.string().regex(/^unix:\/\/\/[A-Za-z0-9_./ -]+$/),
  image: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  resourcePrefix: z.string().regex(/^axiom-proof-(local|preprod|prod)-prativedan$/),
});

/** Fixed source selectors, no workload/DB/SDK/credential mounts or environment.
 * The local controller owns the daemon capability; no request controls argv. */
export function prativedanContainerFactory(
  raw: z.input<typeof prativedanContainerConfiguration>,
  role: 'computation' | 'renderer',
): AssessmentProcessFactory {
  const c = prativedanContainerConfiguration.parse(raw);
  return () =>
    spawn(
      c.executable,
      [
        '--host',
        c.dockerHost,
        'run',
        '--rm',
        '--pull',
        'never',
        '--init',
        '-i',
        '--name',
        `${c.resourcePrefix}-${role}-${randomUUID()}`,
        '--network',
        'none',
        '--ipc',
        'none',
        '--cgroupns',
        'private',
        '--read-only',
        '--cap-drop',
        'ALL',
        '--cap-add',
        'SETUID',
        '--cap-add',
        'SETGID',
        '--cap-add',
        'KILL',
        '--security-opt',
        'no-new-privileges',
        '--pids-limit',
        '64',
        '--memory',
        '256m',
        '--memory-swap',
        '256m',
        '--cpus',
        '1',
        '--log-driver',
        'none',
        '--user',
        '0:0',
        '--entrypoint',
        '/usr/local/bin/python',
        c.image,
        '-m',
        role === 'computation'
          ? 'axiom.prativedan_accounted_supervisor'
          : 'axiom.prativedan_pure_supervisor',
        '--private-stdio',
      ],
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          PATH: '/usr/local/bin:/usr/bin:/bin',
          DOCKER_CONFIG: '/nonexistent/axiom-docker-config',
        },
      },
    );
}

/** Read-only startup validation; no pull, creation, enrollment or application frame. */
export async function verifyPrativedanContainerImage(raw: unknown): Promise<void> {
  const c = prativedanContainerConfiguration.parse(raw);
  const result = await promisify(execFile)(
    c.executable,
    ['--host', c.dockerHost, 'image', 'inspect', '--format', '{{.Id}}', c.image],
    {
      timeout: 5000,
      maxBuffer: 4096,
      env: {
        PATH: '/usr/local/bin:/usr/bin:/bin',
        DOCKER_CONFIG: '/nonexistent/axiom-docker-config',
      },
    },
  );
  if (result.stdout.trim() !== c.image) throw new Error('prativedan_image_unavailable');
}
