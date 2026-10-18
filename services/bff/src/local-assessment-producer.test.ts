import { beforeEach, describe, expect, it, vi } from 'vitest';
import { prepareLocalProducer } from './local-assessment-producer.js';

const mocks = vi.hoisted(() => ({
  read: vi.fn<(filename: string) => Promise<Buffer>>(),
  compose: vi.fn(),
  start: vi.fn(),
  client: vi.fn(),
}));
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
  mocks.client.mockReturnValueOnce(db).mockReturnValueOnce(writer);
  mocks.compose.mockResolvedValue(producer);
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
        configuration().producer,
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
