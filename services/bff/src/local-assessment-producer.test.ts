import { beforeEach, describe, expect, it, vi } from 'vitest';
import { prepareLocalProducer } from './local-assessment-producer.js';

const mocks = vi.hoisted(() => ({
  read: vi.fn<(filename: string) => Promise<Buffer>>(),
  compose: vi.fn(),
  x509: vi.fn(),
  start: vi.fn(),
  client: vi.fn(),
}));
vi.mock('./workloads/local-x509-preflight.js', () => ({ requireLocalX509Material: mocks.x509 }));
vi.mock('./workloads/controller-files.js', async (original) => ({
  ...(await original<typeof import('./workloads/controller-files.js')>()),
  readControllerFile: mocks.read,
}));
vi.mock('./workloads/assessment-producer.js', async (original) => ({
  ...(await original<typeof import('./workloads/assessment-producer.js')>()),
  composeAssessmentProducer: mocks.compose,
}));
vi.mock('./workloads/assessment-producer-socket.js', () => ({
  startAssessmentProducerSocket: mocks.start,
}));
vi.mock('@supabase/supabase-js', () => ({ createClient: mocks.client }));

const configFile = '/run/secrets/producer.json';
const backendFile = '/run/secrets/producer-backend.json';
const id = (n: number) => `78780000-0000-4000-8000-${String(n).padStart(12, '0')}`;
// Decode-only fixtures. They deliberately make no claim of signature validation.
function token(role: string, exp: number = 4102444800) {
  return [
    Buffer.from(JSON.stringify({ alg: 'HS256' })).toString('base64url'),
    Buffer.from(JSON.stringify({ role, exp })).toString('base64url'),
    'synthetic-signature',
  ].join('.');
}
function configuration() {
  return {
    producer: {
      schemaVersion: 1,
      tenants: [
        {
          tenantId: id(1),
          workloadId: id(2),
          trustDomain: 'local.axiomproof.test',
          keys: {
            provider: 'local',
            custody: {
              custodyPolicyId: id(3),
              custodyPolicySha256: 'a'.repeat(64),
              keyPolicySha256: 'b'.repeat(64),
              activationEventId: id(4),
              activationEpoch: 1,
              deploymentBindingSha256: 'c'.repeat(64),
            },
            keyService: {
              spiffeId: 'spiffe://local.axiomproof.test/service/local-key-service',
              endpoint: { host: '127.0.0.1', port: 7443 },
            },
            workload: {
              socketPath: '/run/workload/api.sock',
              spiffeId: 'spiffe://local.axiomproof.test/service/assessment-dispatch-producer',
              issuerNodeId: 'spiffe://local.axiomproof.test/spire/agent/join_token/local',
            },
          },
        },
      ],
    },
    socket: { directory: '/run/assessment-producer', socketGroup: 24001 },
    backendFile,
  };
}
function backend() {
  return {
    url: 'http://supabase-kong:8000',
    anonKey: token('anon'),
    serviceKey: token('service_role'),
    humanWriterKey: token('human_action_writer'),
  };
}
let configInput: unknown;
let backendInput: unknown;
let configBytes: Buffer;
let backendBytes: Buffer;
const db = Object.freeze({ identity: 'service-role-client' });
const writer = Object.freeze({ identity: 'human-writer-client' });
const producer = Object.freeze({ request: vi.fn() });
beforeEach(() => {
  vi.clearAllMocks();
  configInput = configuration();
  backendInput = backend();
  mocks.read.mockImplementation(async (filename) => {
    if (filename === configFile) return (configBytes = Buffer.from(JSON.stringify(configInput)));
    if (filename === backendFile) return (backendBytes = Buffer.from(JSON.stringify(backendInput)));
    throw Error('private-file-marker');
  });
  mocks.client.mockReset().mockReturnValueOnce(db).mockReturnValueOnce(writer);
  mocks.compose.mockResolvedValue(producer);
  mocks.x509.mockResolvedValue(undefined);
  mocks.start.mockResolvedValue({ socketPath: '/run/assessment-producer/producer.sock' });
});

describe('dedicated local producer entrypoint', () => {
  it.each(['--check', '--serve'])(
    'validates protected inputs and separates clients without listening during preparation (%s)',
    async (mode) => {
      const prepared = await prepareLocalProducer([mode, configFile], {
        NODE_ENV: 'production',
        TSX_DISABLE_CACHE: '1',
      });
      expect(prepared.mode).toBe(mode);
      expect(mocks.x509).toHaveBeenCalledTimes(mode === '--check' ? 1 : 0);
      expect(mocks.read.mock.calls).toEqual([[configFile], [backendFile]]);
      expect(mocks.client).toHaveBeenCalledTimes(2);
      expect(mocks.client.mock.calls[0]).toMatchObject([
        'http://supabase-kong:8000',
        expect.any(String),
        {
          auth: { persistSession: false, autoRefreshToken: false },
          global: { headers: { Authorization: `Bearer ${backend().serviceKey}` } },
        },
      ]);
      expect(mocks.client.mock.calls[1]?.[2]).toMatchObject({
        global: { headers: { Authorization: `Bearer ${backend().humanWriterKey}` } },
      });
      expect(mocks.compose).toHaveBeenCalledWith(
        { ...configuration().producer, scheduledCoverageEnabled: false },
        db,
        expect.objectContaining({ writer: expect.any(Function) }),
      );
      const ports = mocks.compose.mock.calls[0]?.[2] as { writer: () => unknown };
      expect(ports.writer()).toBe(writer);
      expect(mocks.start).not.toHaveBeenCalled();
      expect(configBytes.every((value) => value === 0)).toBe(true);
      expect(backendBytes.every((value) => value === 0)).toBe(true);
      await prepared.serve();
      expect(mocks.start).toHaveBeenCalledWith({ ...configuration().socket, producer });
    },
  );

  it('refuses --check when live own X509 material is unavailable without starting the socket', async () => {
    mocks.x509.mockRejectedValueOnce(new Error('material unavailable'));
    await expect(prepareLocalProducer(['--check', configFile], {})).rejects.toThrow(
      'startup refused',
    );
    expect(mocks.x509).toHaveBeenCalledWith(
      configuration().producer.tenants[0]!.keys.workload,
      'client',
    );
    expect(mocks.start).not.toHaveBeenCalled();
    expect(backendBytes.every((value) => value === 0)).toBe(true);
  });
  it.each([
    'SUPABASE_SERVICE_ROLE_KEY',
    'SUPABASE_HUMAN_ACTION_WRITER_KEY',
    'NODE_OPTIONS',
    'UNREVIEWED_SELECTOR',
  ])('rejects ambient %s before reading credentials', async (key) => {
    await expect(
      prepareLocalProducer(['--serve', configFile], { [key]: 'private-env-marker' }),
    ).rejects.toThrow('Local assessment producer startup refused');
    expect(mocks.read).not.toHaveBeenCalled();
    expect(mocks.client).not.toHaveBeenCalled();
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it.each([[], ['--check'], ['--unknown', configFile], ['--serve', configFile, 'extra']])(
    'rejects malformed CLI arguments',
    async (...args) => {
      await expect(prepareLocalProducer(args, {})).rejects.toThrow('startup refused');
      expect(mocks.read).not.toHaveBeenCalled();
    },
  );

  it.each(['anonKey', 'serviceKey', 'humanWriterKey'] as const)(
    'rejects wrong-role and expired %s before composing clients',
    async (field) => {
      for (const replacement of [
        token('axiom_assessment_controller'),
        token(
          field === 'anonKey'
            ? 'anon'
            : field === 'serviceKey'
              ? 'service_role'
              : 'human_action_writer',
          1,
        ),
        'malformed-token-with-private-marker-0000',
      ]) {
        backendInput = { ...backend(), [field]: replacement };
        await expect(prepareLocalProducer(['--check', configFile], {})).rejects.toThrow(
          'Local assessment producer startup refused',
        );
        expect(mocks.client).not.toHaveBeenCalled();
        expect(mocks.compose).not.toHaveBeenCalled();
        expect(backendBytes.every((value) => value === 0)).toBe(true);
      }
    },
  );

  it('rejects cloud key configuration before loading backend credentials', async () => {
    const config = configuration();
    configInput = {
      ...config,
      producer: {
        ...config.producer,
        tenants: [
          {
            ...config.producer.tenants[0],
            keys: {
              provider: 'aws',
              primary: 'arn:aws:kms:ap-south-1:123456789012:key/reviewed-fixture',
              retiring: [],
            },
          },
        ],
      },
    };
    await expect(prepareLocalProducer(['--serve', configFile], {})).rejects.toThrow(
      'startup refused',
    );
    expect(mocks.read.mock.calls).toEqual([[configFile]]);
    expect(mocks.compose).not.toHaveBeenCalled();
    expect(configBytes.every((value) => value === 0)).toBe(true);
  });

  it.each(['config', 'backend'])('sanitizes refused %s file errors', async (which) => {
    const previous = mocks.read.getMockImplementation()!;
    mocks.read.mockImplementation(async (filename) => {
      if (filename === (which === 'config' ? configFile : backendFile))
        throw Error('private-file-marker');
      return previous(filename);
    });
    await expect(prepareLocalProducer(['--serve', configFile], {})).rejects.toThrow(
      /^Local assessment producer startup refused$/,
    );
    expect(mocks.client).not.toHaveBeenCalled();
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it.each(['config', 'backend'])(
    'refuses malformed JSON in the %s file without leaking it',
    async (which) => {
      const previous = mocks.read.getMockImplementation()!;
      let malformed: Buffer | undefined;
      mocks.read.mockImplementation(async (filename) => {
        if (filename === (which === 'config' ? configFile : backendFile)) {
          malformed = Buffer.from('{private-malformed-marker');
          return malformed;
        }
        return previous(filename);
      });
      await expect(prepareLocalProducer(['--check', configFile], {})).rejects.toThrow(
        /^Local assessment producer startup refused$/,
      );
      expect(malformed?.every((value) => value === 0)).toBe(true);
      expect(mocks.client).not.toHaveBeenCalled();
      expect(mocks.start).not.toHaveBeenCalled();
    },
  );

  it('refuses relative certificate paths before loading protected credentials', async () => {
    await expect(
      prepareLocalProducer(['--check', configFile], { NODE_EXTRA_CA_CERTS: '../untrusted.pem' }),
    ).rejects.toThrow('startup refused');
    expect(mocks.read).not.toHaveBeenCalled();
  });

  it.each(['url', 'unknown-config', 'unknown-backend'])(
    'refuses invalid or unexpected %s settings',
    async (which) => {
      if (which === 'url') backendInput = { ...backend(), url: 'http://untrusted.example.test' };
      if (which === 'unknown-config')
        configInput = { ...configuration(), controller: 'private-marker' };
      if (which === 'unknown-backend')
        backendInput = { ...backend(), controllerAccessToken: 'private-marker' };
      await expect(prepareLocalProducer(['--check', configFile], {})).rejects.toThrow(
        'startup refused',
      );
      expect(mocks.client).not.toHaveBeenCalled();
      expect(mocks.compose).not.toHaveBeenCalled();
    },
  );

  it('sanitizes failed read-only producer registration checks and clears both file buffers', async () => {
    mocks.compose.mockRejectedValueOnce(Error('private-registration-marker'));
    await expect(prepareLocalProducer(['--serve', configFile], {})).rejects.toThrow(
      /^Local assessment producer startup refused$/,
    );
    expect(configBytes.every((value) => value === 0)).toBe(true);
    expect(backendBytes.every((value) => value === 0)).toBe(true);
    expect(mocks.start).not.toHaveBeenCalled();
  });
});

describe('explicit scheduled coverage existing-agent credential boundary', () => {
  const agentFile = '/run/secrets/coverage-writer.jwt';
  function enabled(role = 'agent_ledger_writer', checkError = false) {
    configInput = {
      ...configuration(),
      producer: { ...configuration().producer, scheduledCoverageEnabled: true },
      agentWriterFile: agentFile,
    };
    const bytes = Buffer.from(token(role));
    mocks.read.mockImplementation(async (name) => {
      if (name === configFile) return (configBytes = Buffer.from(JSON.stringify(configInput)));
      if (name === backendFile) return (backendBytes = Buffer.from(JSON.stringify(backendInput)));
      if (name === agentFile) return bytes;
      throw Error('unexpected protected input');
    });
    const abortSignal = vi.fn().mockResolvedValue({
      data: {
        schemaVersion: 1,
        authority: 'explicit_owner_scope_required',
        taskScopes: ['control_library.read', 'findings.write'],
      },
      error: checkError ? { code: 'unavailable' } : null,
    });
    const rpc = vi.fn().mockReturnValue({ abortSignal });
    const agent = { rpc };
    mocks.client.mockReturnValueOnce(agent);
    return { bytes, rpc, agent };
  }
  it('requires fixed existing-agent role and live narrow RPC before composition, then wipes the file bytes', async () => {
    const fixture = enabled();
    await prepareLocalProducer(['--check', configFile], {});
    expect(fixture.rpc).toHaveBeenCalledWith('scheduled_coverage_writer_check', {});
    const ports = mocks.compose.mock.calls[0]?.[2] as { agentWriter: () => unknown };
    expect(ports.agentWriter()).toBe(fixture.agent);
    expect(fixture.bytes.every((v) => v === 0)).toBe(true);
    expect(mocks.start).not.toHaveBeenCalled();
  });
  it.each(['service_role', 'human_action_writer', 'authenticated'])(
    'refuses %s as scheduled coordinator and wipes the file',
    async (role) => {
      const fixture = enabled(role);
      await expect(prepareLocalProducer(['--serve', configFile], {})).rejects.toThrow(
        'startup refused',
      );
      expect(fixture.bytes.every((v) => v === 0)).toBe(true);
      expect(mocks.compose).not.toHaveBeenCalled();
      expect(fixture.rpc).not.toHaveBeenCalled();
    },
  );
  it('refuses a stale/missing backend contract before compose or socket creation', async () => {
    const fixture = enabled('agent_ledger_writer', true);
    await expect(prepareLocalProducer(['--serve', configFile], {})).rejects.toThrow(
      'startup refused',
    );
    expect(fixture.bytes.every((v) => v === 0)).toBe(true);
    expect(mocks.compose).not.toHaveBeenCalled();
    expect(mocks.start).not.toHaveBeenCalled();
  });
  it('never adopts a third credential when the reviewed producer feature is off', async () => {
    configInput = { ...configuration(), agentWriterFile: agentFile };
    await expect(prepareLocalProducer(['--serve', configFile], {})).rejects.toThrow(
      'startup refused',
    );
    expect(mocks.compose).not.toHaveBeenCalled();
    expect(mocks.read).not.toHaveBeenCalledWith(agentFile);
  });
});
