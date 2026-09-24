import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { z } from 'zod';
import type { AssessmentProcessFactory } from './assessment-channel.js';

export const assessmentContainerConfiguration = z
  .object({
    executable: z
      .string()
      .regex(/^\/[A-Za-z0-9_./ -]+$/)
      .refine((s) => s.trim() === s),
    dockerHost: z
      .string()
      .regex(/^unix:\/\/\/[A-Za-z0-9_./ -]+$/)
      .refine((s) => s.trim() === s),
    image: z
      .string()
      .regex(/^sha256:[a-f0-9]{64}$/)
      .length(71),
    workloadApiVolume: z
      .string()
      .regex(/^axiom-workload-api-[a-z0-9-]{1,64}$/)
      .refine((s) => s.trim() === s),
  })
  .strict();

/** Dedicated trusted Docker controller only; never expose this to an HTTP body.
 * The daemon and node SPIRE agent are trusted. Only their Workload API socket
 * volume is shared with jobs. No database/KMS env, host namespace or daemon
 * socket is mounted into a worker. Image IDs must be reviewed and preloaded.
 */
export function assessmentContainerFactory(
  config: z.input<typeof assessmentContainerConfiguration>,
): AssessmentProcessFactory {
  let args: readonly string[];
  let executable: string;
  try {
    const value = assessmentContainerConfiguration.parse(config);
    executable = value.executable;
    args = [
      '--host',
      value.dockerHost,
      'run',
      '--rm',
      '--pull',
      'never',
      '--init',
      '-i',
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
      '--mount',
      `type=volume,src=${value.workloadApiVolume},dst=/run/workload,readonly,volume-nocopy`,
      '--entrypoint',
      '/usr/local/bin/python',
      value.image,
      '-m',
      'axiom.assessment_supervisor',
      '--private-stdio',
    ];
  } catch {
    throw new Error('Assessment container configuration refused');
  }
  return (): ChildProcessWithoutNullStreams => {
    // Each invocation creates a new PID/mount/network namespace, including when
    // a previous job is still alive. Private input is written only by Channel.
    const name = `axiom-assessment-${randomUUID()}`;
    return spawn(executable, [...args.slice(0, 3), '--name', name, ...args.slice(3)], {
      stdio: ['pipe', 'pipe', 'pipe'],
      // Docker uses an explicit local daemon, never ambient contexts or cloud
      // credentials. --pull never avoids registry authentication/egress.
      env: {
        PATH: '/usr/local/bin:/usr/bin:/bin',
        DOCKER_CONFIG: '/nonexistent/axiom-docker-config',
      },
    });
  };
}

/** Read-only startup gate. This proves availability of the reviewed immutable
 * image and existing socket volume, not image admission or node enrollment. */
export async function verifyAssessmentContainerRuntime(
  config: z.input<typeof assessmentContainerConfiguration>,
): Promise<void> {
  try {
    const value = assessmentContainerConfiguration.parse(config);
    const inspect = promisify(execFile);
    const options = {
      timeout: 5000,
      maxBuffer: 4096,
      env: {
        PATH: '/usr/local/bin:/usr/bin:/bin',
        DOCKER_CONFIG: '/nonexistent/axiom-docker-config',
      },
    };
    const image = await inspect(
      value.executable,
      ['--host', value.dockerHost, 'image', 'inspect', '--format', '{{.Id}}', value.image],
      options,
    );
    if (image.stdout.trim() !== value.image) throw new Error();
    const volume = await inspect(
      value.executable,
      [
        '--host',
        value.dockerHost,
        'volume',
        'inspect',
        '--format',
        '{{.Name}}',
        value.workloadApiVolume,
      ],
      options,
    );
    if (volume.stdout.trim() !== value.workloadApiVolume) throw new Error();
  } catch {
    throw new Error('Assessment container runtime unavailable');
  }
}
