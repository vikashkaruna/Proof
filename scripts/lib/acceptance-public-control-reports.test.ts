import {
  encodeBrandedSource,
  BRANDED_PRESENTATION_V1,
  buildBrandedReport,
} from '../../packages/report-kit/src/branded-report.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { publicReportFixture } from '../../packages/report-kit/src/public-control-provenance.test-helper.js';
import { assetReportFixture } from '../../packages/report-kit/src/public-control-report-v4.test-helper.js';
import {
  encodeCoverageFirstSource,
  coverageFirstPolicy,
} from '../../packages/report-kit/src/coverage-first-source.js';
import { buildCoverageFirstReport } from '../../packages/report-kit/src/coverage-first-report.js';
import { canonicalJson } from '../../packages/ledger/src/index.js';
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
import {
  reportAcceptanceRequested,
  reportAcceptanceCodeSha256,
  validateReportProvider,
  publicReportBrowserHandoffSchema,
  verifyCoverageFirstAcceptanceReport,
  verifyBrandedAcceptanceReport,
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
    version: 2,
    presentation: {
      sourceVersion: 6,
      documentVersion: 7,
      metrics: 'withheld',
      policySha256: sha(canonicalJson(coverageFirstPolicy())),
    },
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
      retainedSourceSha256: hash,
      contentSha256: hash,
      pdfSha256: hash,
    })),
    providerId: hash,
    providerRunId: '0123456789ab',
    mode: 'synthetic-loopback-provider-not-cloud-acceptance',
    codeSha256: hash,
  };
  assert(publicReportBrowserHandoffSchema.safeParse(value).success);
  const asset = {
    targetId: id,
    targetSha256: hash,
    associationId: randomUUID(),
    associationSha256: hash,
    checkId: randomUUID(),
  };
  assert(
    publicReportBrowserHandoffSchema.safeParse({ ...value, source: { ...source, asset } }).success,
  );
  assert(
    !publicReportBrowserHandoffSchema.safeParse({
      ...value,
      source: { ...source, asset: { ...asset, ownershipVerified: true } },
    }).success,
  );
  assert(
    !publicReportBrowserHandoffSchema.safeParse({
      ...value,
      source: { ...source, asset: { ...asset, targetSha256: 'bad' } },
    }).success,
  );
  for (const changed of [
    { ...value, token: 'synthetic-secret' },
    { ...value, source: { ...source, password: 'synthetic-secret' } },
    { ...value, mode: 'production' },
    { ...value, version: 1 },
    { ...value, presentation: { ...value.presentation, documentVersion: 4 } },
    { ...value, presentation: { ...value.presentation, sourceVersion: 3 } },
    { ...value, presentation: { ...value.presentation, metrics: 'published' } },
    { ...value, presentation: { ...value.presentation, policySha256: 'f'.repeat(64) } },
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

function coverageFixture(kind: 'board' | 'auditor', asset: boolean) {
  const fixture = asset ? assetReportFixture(kind) : publicReportFixture(kind);
  if (!asset) {
    const estate = randomUUID();
    const human = fixture.human;
    const request = { ...JSON.parse(human.review.request_text), expectedEstateId: estate };
    const snapshot = { ...JSON.parse(human.review.snapshot_text), estateId: estate, request };
    human.estate_id = estate;
    human.review.request_text = canonicalJson(request);
    human.review.request_sha256 = sha(human.review.request_text);
    human.review.snapshot_text = canonicalJson(snapshot);
    human.review.snapshot_sha256 = sha(human.review.snapshot_text);
    fixture.source.human_control_review = human;
    fixture.input.sourceText = JSON.stringify(fixture.source);
    fixture.input.sourceSha256 = sha(fixture.input.sourceText);
  }
  const frozen = encodeCoverageFirstSource(
    kind,
    fixture.input.sourceText,
    fixture.input.sourceSha256,
  );
  const document = buildCoverageFirstReport({
    ...fixture.input,
    sourceText: frozen.text,
    sourceSha256: frozen.sha256,
  });
  const original = JSON.parse(fixture.input.sourceText);
  const h = original.human_control_review;
  const source = {
    estateId: h.estate_id,
    systemId: asset ? document.asset_scope!.system.id : randomUUID(),
    engagementId: original.engagement_id,
    jobId: h.job_id,
    runId: original.assessment_run_id,
    reviewId: h.review.id,
    inputSha256: h.worker_input.sha256,
    captureReceipt: h.capture.capture_receipt.id,
    reviewReceipt: h.review.receipt.id,
    requestedReceipt: h.requested_receipt.id,
    ...(asset
      ? {
          asset: {
            targetId: document.asset_scope!.target.id,
            targetSha256: document.asset_scope!.target.sha256,
            associationId: document.asset_scope!.association.id,
            associationSha256: document.asset_scope!.association.sha256,
            checkId: h.capture.check_id,
          },
        }
      : {}),
  };
  const text = JSON.stringify(document);
  return {
    input: {
      kind,
      title: document.title,
      tenantId: document.tenant_id,
      requestId: document.request_id,
      source,
      resultDigest: original.result_sha256,
      sourceText: frozen.text,
      sourceSha256: frozen.sha256,
      contentText: text,
      contentSha256: sha(text),
    },
    document,
    original,
    frozen,
    fixture,
  };
}
for (const kind of ['board', 'auditor'] as const)
  for (const asset of [false, true]) {
    test(`NEW ${kind} acceptance requires source4/doc5 (asset=${asset}) while preserving opaque original bytes`, () => {
      const f = coverageFixture(kind, asset);
      const actual = verifyCoverageFirstAcceptanceReport(f.input);
      assert.equal(actual.parsed.schema_version, asset ? 3 : 2);
      assert.equal(actual.content.schema_version, 5);
      assert.equal(actual.content.metrics.state, 'withheld');
      assert.equal(actual.retainedSourceSha256, f.fixture.input.sourceSha256);
      assert.equal(JSON.parse(f.frozen.text).retained_source.text, f.fixture.input.sourceText);
      assert.equal(actual.content.provenance.reviewId, f.input.source.reviewId);
      assert.equal(JSON.parse(actual.parsed.result_text).posture_score, 30);
      assert.equal(JSON.parse(actual.parsed.result_text).estimated_exposure_inr, 12345);
      for (const change of [
        'source-downgrade',
        'source-hash',
        'document-hash',
        'inner-hash',
        'policy',
        'estate',
        'document-downgrade',
        'tenant',
        'request',
        'result',
        'title',
        'job',
        'review',
        'capture',
        'withheld',
        'unknown-graft',
        'duplicate',
      ] as const) {
        const input = structuredClone(f.input);
        if (change === 'source-downgrade') {
          input.sourceText = f.fixture.input.sourceText;
          input.sourceSha256 = sha(input.sourceText);
        }
        if (change === 'document-downgrade')
          input.contentText = JSON.stringify({ ...f.document, schema_version: 4 });
        if (change === 'source-hash') input.sourceSha256 = 'f'.repeat(64);
        if (change === 'inner-hash' || change === 'policy') {
          const wrapper = JSON.parse(input.sourceText);
          if (change === 'inner-hash') wrapper.retained_source.sha256 = 'f'.repeat(64);
          else wrapper.presentation_policy.metrics = 'published';
          input.sourceText = canonicalJson(wrapper);
          input.sourceSha256 = sha(input.sourceText);
        }
        if (change === 'estate') input.source.estateId = randomUUID();
        if (change === 'tenant') input.tenantId = randomUUID();
        if (change === 'request') input.requestId = randomUUID();
        if (change === 'result') input.resultDigest = 'f'.repeat(64);
        if (change === 'title') input.title += ' graft';
        if (change === 'job') input.source.jobId = randomUUID();
        if (change === 'review') input.source.reviewId = randomUUID();
        if (change === 'capture') input.source.captureReceipt = '999';
        if (change === 'withheld')
          input.contentText = JSON.stringify({ ...f.document, metrics: { state: 'published' } });
        if (change === 'unknown-graft') {
          const d = structuredClone(f.document);
          d.controls[0]!.questions[0]!.state = 'human_no_unverified';
          input.contentText = JSON.stringify(d);
        }
        if (change === 'duplicate')
          input.contentText = input.contentText.replace(
            '"schema_version":5',
            '"schema_version":5,"schema_version":5',
          );
        input.contentSha256 = change === 'document-hash' ? 'f'.repeat(64) : sha(input.contentText);
        assert.throws(() => verifyCoverageFirstAcceptanceReport(input), change);
      }
    });
  }

for (const kind of ['board', 'auditor'] as const)
  for (const asset of [false, true]) {
    test(`mounted ${kind} acceptance requires exact branded6/document7 with retained public provenance asset=${asset}`, () => {
      const f = coverageFixture(kind, asset);
      const wrapped = encodeBrandedSource(
        kind,
        f.input.sourceText,
        f.input.sourceSha256,
        'Synthetic company',
      );
      const content = buildBrandedReport({
        requestId: f.input.requestId,
        tenantId: f.input.tenantId,
        engagementId: f.input.source.engagementId,
        assessmentRunId: f.input.source.runId,
        title: f.input.title,
        generatedAt: f.document.generated_at,
        sourceText: wrapped.text,
        sourceSha256: wrapped.sha256,
      });
      const text = JSON.stringify(content);
      const input = {
        ...f.input,
        sourceText: wrapped.text,
        sourceSha256: wrapped.sha256,
        contentText: text,
        contentSha256: sha(text),
      };
      const phases: string[] = [];
      const actual = verifyBrandedAcceptanceReport(input, (stage) => phases.push(stage));
      assert.deepEqual(phases, [
        'source-proof',
        'content-hash',
        'source-envelope',
        'document-schema',
        'document-rebuild',
        'document-compare',
        'inner-rebuild',
        'inner-verify',
      ]);
      const refusedPhases: string[] = [];
      assert.throws(() =>
        verifyBrandedAcceptanceReport({ ...input, contentSha256: 'f'.repeat(64) }, (stage) =>
          refusedPhases.push(stage),
        ),
      );
      assert.deepEqual(refusedPhases, ['source-proof', 'content-hash']);
      assert.equal(actual.content.schema_version, 7);
      assert.equal(actual.content.underlying_document_version, 5);
      assert.equal(actual.retainedSourceSha256, f.fixture.input.sourceSha256);
      assert.equal(actual.content.metrics.state, 'withheld');
      assert.throws(() => verifyCoverageFirstAcceptanceReport(input));
      assert.throws(() => verifyBrandedAcceptanceReport(f.input));
      for (const change of [
        { ...input, sourceSha256: 'f'.repeat(64) },
        { ...input, tenantId: randomUUID() },
        { ...input, kind: kind === 'board' ? ('auditor' as const) : ('board' as const) },
        { ...input, contentText: JSON.stringify({ ...content, underlying_document_version: 6 }) },
        {
          ...input,
          contentText: JSON.stringify({
            ...content,
            presentation: { ...BRANDED_PRESENTATION_V1, company_name: 'Forged' },
          }),
        },
      ]) {
        const changed = { ...change, contentSha256: sha(change.contentText) };
        assert.throws(() => verifyBrandedAcceptanceReport(changed));
      }
    });
  }
