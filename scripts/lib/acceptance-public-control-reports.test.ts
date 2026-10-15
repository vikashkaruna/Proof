import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  reportAcceptanceRequested,
  reportAcceptanceCodeSha256,
  validateReportProvider,
  publicReportBrowserHandoffSchema,
} from './acceptance-public-control-reports.js';

function fixture() {
  const runId = '0123456789ab';
  const directory = '/fixture/.axiom-runtime/evidence-storage';
  const config = {
    endpoint: 'http://127.0.0.1:54321',
    bucket: `evidence-${runId}`,
    accessKeyId: 'synthetic-fixture-id',
    secretAccessKey: 'synthetic-fixture-secret',
    privateStatePath: `${directory}/private-receipt.json`,
    resultPath: `${directory}/unavailable.json`,
  };
  return {
    root: '/fixture',
    directory,
    state: { runId, name: `axiom-evidence-${runId}`, volume: `axiom-evidence-${runId}-data` },
    config,
    inspection: [
      {
        Id: 'a'.repeat(64),
        State: { Running: true, Paused: false },
        Config: {
          Labels: {
            'axiom.fixture.run': runId,
            'axiom.fixture.test-only': 'true',
            'axiom.fixture.source': '9e49d5e7a648f00e26f2246f4dc28e6b07f8c84a',
            'axiom.fixture.archive':
              '45521908307306e925c98d629e1c17d78c8b72b6ee242b1bfb1409f7d8ee5841',
          },
        },
        NetworkSettings: { Ports: { '9000/tcp': [{ HostIp: '127.0.0.1', HostPort: '54321' }] } },
        Mounts: [{ Type: 'volume', Name: `axiom-evidence-${runId}-data`, Destination: '/data' }],
      },
    ],
    environment: {
      AXIOM_STORAGE_ENDPOINT: config.endpoint,
      AXIOM_EVIDENCE_BUCKET: config.bucket,
      AXIOM_STORAGE_ACCESS_KEY_ID: config.accessKeyId,
      AXIOM_STORAGE_SECRET_ACCESS_KEY: config.secretAccessKey,
      AXIOM_REGION: 'ap-south-1',
    },
  };
}
test('report continuation is explicit and never silently accepts another mode', () => {
  assert.equal(reportAcceptanceRequested({}), false);
  assert.equal(reportAcceptanceRequested({ AXIOM_PUBLIC_CONTROL_REPORT_ACCEPTANCE: 'true' }), true);
  for (const mode of ['false', '1', 'demo', ''])
    assert.throws(() =>
      reportAcceptanceRequested({ AXIOM_PUBLIC_CONTROL_REPORT_ACCEPTANCE: mode }),
    );
});
test('provider guard accepts only the matching owned loopback fixture', () => {
  const f = fixture();
  const result = validateReportProvider(f);
  assert.equal(result.providerId, 'a'.repeat(64));
  assert.equal(result.providerRunId, f.state.runId);
});
test('provider guard accepts the completed launchers exact retained configuration contract', () => {
  const f = fixture();
  assert.doesNotThrow(() =>
    validateReportProvider({
      ...f,
      config: { ...f.config, resultPath: `${f.directory}/unavailable.json` },
    }),
  );
});
test('provider guard refuses foreign ownership, credentials, ports, persistence and paths', () => {
  const changes: ((f: ReturnType<typeof fixture>) => void)[] = [
    (f) => {
      f.directory = '/retained/storage';
    },
    (f) => {
      f.config.endpoint = 'https://cloud.example.invalid';
    },
    (f) => {
      f.config.privateStatePath = '/retained/receipt';
    },
    (f) => {
      f.config.resultPath = '/retained/result.json';
    },
    (f) => {
      f.config.resultPath = `${f.directory}/initial.json`;
    },
    (f) => {
      f.environment.AXIOM_REGION = 'us-east-1';
    },
    (f) => {
      f.environment.AXIOM_STORAGE_SECRET_ACCESS_KEY = 'other';
    },
    (f) => {
      f.inspection[0]!.Config.Labels['axiom.fixture.run'] = 'other';
    },
    (f) => {
      f.inspection[0]!.Config.Labels['axiom.fixture.test-only'] = 'false';
    },
    (f) => {
      f.inspection[0]!.Config.Labels['axiom.fixture.source'] = 'b'.repeat(40);
    },
    (f) => {
      f.inspection[0]!.NetworkSettings.Ports['9000/tcp'][0]!.HostIp = '0.0.0.0';
    },
    (f) => {
      f.inspection[0]!.NetworkSettings.Ports['9000/tcp'][0]!.HostPort = '54322';
    },
    (f) => {
      f.inspection[0]!.State.Paused = true;
    },
    (f) => {
      f.inspection[0]!.Mounts[0]!.Name = 'retained';
    },
  ];
  for (const mutate of changes) {
    const f = fixture();
    mutate(f);
    assert.throws(() => validateReportProvider(f));
  }
});
test('provider guard refuses missing or invented configuration fields', () => {
  const f = fixture();
  const { resultPath: _, ...missing } = f.config;
  assert.throws(() => validateReportProvider({ ...f, config: missing }));
  assert.throws(() => validateReportProvider({ ...f, config: { ...f.config, extra: 'refused' } }));
});
test('browser handoff is strict, bounded and cannot carry authentication material', () => {
  const id = randomUUID();
  const hash = 'a'.repeat(64);
  const source = {
    estateId: id,
    systemId: id,
    engagementId: id,
    jobId: id,
    runId: id,
    reviewId: id,
    inputSha256: hash,
    captureReceipt: '1',
    reviewReceipt: '2',
    requestedReceipt: '3',
  };
  const value = {
    version: 1,
    kind: 'owned-reviewed-public-source-reports',
    tenantId: id,
    tenantSlug: `worker-${id}`,
    source,
    resultDigest: hash,
    reports: ['board', 'auditor'].map((kind) => ({
      kind,
      requestId: id,
      reportId: id,
      sourceSha256: hash,
      contentSha256: hash,
      pdfSha256: hash,
    })),
    providerId: hash,
    providerRunId: '0123456789ab',
    mode: 'synthetic-loopback-provider-not-cloud-acceptance',
    codeSha256: hash,
  };
  assert(publicReportBrowserHandoffSchema.safeParse(value).success);
  for (const changed of [
    { ...value, token: 'synthetic-secret' },
    { ...value, source: { ...source, password: 'synthetic-secret' } },
    { ...value, mode: 'production' },
    { ...value, reports: [] },
    { ...value, source: { ...source, reviewId: 'invalid' } },
    { ...value, source: { ...source, captureReceipt: 'synthetic-secret' } },
    { ...value, tenantSlug: `worker-${randomUUID()}` },
    { ...value, reports: [value.reports[0], value.reports[0]] },
  ])
    assert(!publicReportBrowserHandoffSchema.safeParse(changed).success);
});

test('browser source commitment uses explicit repository root independent of Playwright cwd', () => {
  const root = process.cwd();
  const expected = reportAcceptanceCodeSha256(root);
  try {
    process.chdir('tests/e2e');
    assert.equal(reportAcceptanceCodeSha256(root), expected);
    assert.throws(() => reportAcceptanceCodeSha256());
  } finally {
    process.chdir(root);
  }
});
