/** Continuation of the existing normal-Auth/SPIRE assessment fixture. Only
 * engineering-owned loopback Object Lock storage; never cloud acceptance. */
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  lstatSync,
  readFileSync,
  realpathSync,
  writeFileSync,
  mkdirSync,
  unlinkSync,
} from 'node:fs';
import { join, relative, isAbsolute } from 'node:path';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { EvidenceVault } from '../../packages/evidence/src/index.js';
import { generateTotp } from '../../packages/mfa/src/index.js';
import { BoardReportContentV3Schema } from '../../packages/report-kit/src/board-report.js';
import {
  AuditorAssessmentPackV3Schema,
  FrozenAuditorSourceSchema,
} from '../../packages/report-kit/src/auditor-source.js';
import { FrozenBoardSourceSchema } from '../../packages/report-kit/src/board-source.js';
import { verifyFrozenHumanControlReview } from '../../packages/report-kit/src/public-control-provenance.js';
import { parseCatalogueJson } from '../../packages/control-library/src/index.js';

const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const uuid = z.uuid();
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const receipt = z.string().regex(/^[1-9][0-9]{0,18}$/);
const HANDOFF =
  '.axiom-runtime/review/all-agent-acceptance/public-report-browser-handoff.private.json';
const providerState = z
  .object({ name: z.string(), volume: z.string(), runId: z.string().regex(/^[a-f0-9]{12}$/) })
  .strict();
const providerConfig = z
  .object({
    endpoint: z.string(),
    bucket: z.string(),
    accessKeyId: z.string(),
    secretAccessKey: z.string(),
    privateStatePath: z.string(),
  })
  .strict();
export function reportAcceptanceRequested(environment: NodeJS.ProcessEnv = process.env) {
  const mode = environment.AXIOM_PUBLIC_CONTROL_REPORT_ACCEPTANCE;
  if (mode !== undefined && mode !== 'true') throw new Error('report fixture mode refused');
  return mode === 'true';
}
export function validateReportProvider(input: {
  root: string;
  directory: string;
  state: unknown;
  config: unknown;
  inspection: unknown;
  environment: NodeJS.ProcessEnv;
}) {
  const selected = relative(join(input.root, '.axiom-runtime'), input.directory);
  assert(selected && !selected.startsWith('..') && !isAbsolute(selected));
  const state = providerState.parse(input.state);
  assert.equal(state.name, `axiom-evidence-${state.runId}`);
  assert.equal(state.volume, `${state.name}-data`);
  const config = providerConfig.parse(input.config);
  const endpoint = new URL(config.endpoint);
  assert.equal(endpoint.protocol, 'http:');
  assert.equal(endpoint.hostname, '127.0.0.1');
  assert(
    endpoint.port &&
      endpoint.pathname === '/' &&
      !endpoint.search &&
      !endpoint.hash &&
      !endpoint.username &&
      !endpoint.password,
  );
  assert.equal(config.bucket, `evidence-${state.runId}`);
  assert.equal(config.privateStatePath, join(input.directory, 'private-receipt.json'));
  for (const [key, expected] of Object.entries({
    AXIOM_STORAGE_ENDPOINT: config.endpoint,
    AXIOM_EVIDENCE_BUCKET: config.bucket,
    AXIOM_STORAGE_ACCESS_KEY_ID: config.accessKeyId,
    AXIOM_STORAGE_SECRET_ACCESS_KEY: config.secretAccessKey,
    AXIOM_REGION: 'ap-south-1',
  }))
    assert.equal(input.environment[key], expected);
  const info = z
    .array(
      z.object({
        Id: z.string().regex(/^[a-f0-9]{64}$/),
        State: z.object({ Running: z.literal(true), Paused: z.literal(false) }),
        Config: z.object({ Labels: z.record(z.string(), z.string()) }),
        NetworkSettings: z.object({
          Ports: z.object({
            '9000/tcp': z
              .array(z.object({ HostIp: z.literal('127.0.0.1'), HostPort: z.string() }))
              .length(1),
          }),
        }),
        Mounts: z.array(
          z.object({ Type: z.string(), Name: z.string().optional(), Destination: z.string() }),
        ),
      }),
    )
    .length(1)
    .parse(input.inspection)[0]!;
  assert.equal(info.Config.Labels['axiom.fixture.run'], state.runId);
  assert.equal(info.Config.Labels['axiom.fixture.test-only'], 'true');
  assert.equal(
    info.Config.Labels['axiom.fixture.source'],
    '9e49d5e7a648f00e26f2246f4dc28e6b07f8c84a',
  );
  assert.equal(
    info.Config.Labels['axiom.fixture.archive'],
    '45521908307306e925c98d629e1c17d78c8b72b6ee242b1bfb1409f7d8ee5841',
  );
  assert.equal(info.NetworkSettings.Ports['9000/tcp'][0]!.HostPort, endpoint.port);
  assert(
    info.Mounts.some(
      (m) => m.Type === 'volume' && m.Name === state.volume && m.Destination === '/data',
    ),
  );
  return { ...config, providerId: info.Id, providerRunId: state.runId };
}
export function ownedReportProvider(repositoryRoot = '.') {
  const root = realpathSync(repositoryRoot);
  const directory = realpathSync(
    process.env.AXIOM_EVIDENCE_FIXTURE_DIRECTORY ?? join(root, '.axiom-runtime/evidence-storage'),
  );
  const read = (name: string) => {
    const path = join(directory, name),
      stat = lstatSync(path);
    assert(stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o077) === 0);
    return JSON.parse(readFileSync(path, 'utf8')) as unknown;
  };
  const state = read('private-fixture.json');
  const name = providerState.parse(state).name;
  assert(/^axiom-evidence-[a-f0-9]{12}$/.test(name));
  const inspection: unknown = JSON.parse(
    execFileSync('docker', ['inspect', name], {
      encoding: 'utf8',
      timeout: 10000,
      stdio: ['ignore', 'pipe', 'pipe'],
    }),
  );
  return validateReportProvider({
    root,
    directory,
    state,
    config: read('private-config.json'),
    inspection,
    environment: process.env,
  });
}

const sourceProofSchema = z.object({
  estateId: uuid,
  systemId: uuid,
  engagementId: uuid,
  jobId: uuid,
  runId: uuid,
  reviewId: uuid,
  inputSha256: digest,
  captureReceipt: receipt,
  reviewReceipt: receipt,
  requestedReceipt: receipt,
});
const artifact = z.object({
  artifact_kind: z.string(),
  bucket: z.string(),
  object_key: z.string(),
  version_id: z.string().min(1),
  content_hash: digest,
  byte_size: z.number().int().positive(),
  retain_until: z.iso.datetime({ offset: true }),
});
export const publicReportBrowserHandoffSchema = z
  .object({
    version: z.literal(1),
    kind: z.literal('owned-reviewed-public-source-reports'),
    tenantId: uuid,
    tenantSlug: z.string().regex(/^worker-[a-f0-9-]{36}$/),
    source: sourceProofSchema.strict(),
    resultDigest: digest,
    reports: z
      .array(
        z
          .object({
            kind: z.enum(['board', 'auditor']),
            requestId: uuid,
            reportId: uuid,
            sourceSha256: digest,
            contentSha256: digest,
            pdfSha256: digest,
          })
          .strict(),
      )
      .length(2),
    providerId: z.string().regex(/^[a-f0-9]{64}$/),
    providerRunId: z.string().regex(/^[a-f0-9]{12}$/),
    mode: z.literal('synthetic-loopback-provider-not-cloud-acceptance'),
    codeSha256: digest,
  })
  .strict()
  .refine((v) => v.tenantSlug === `worker-${v.tenantId}`, { message: 'fixture tenant mismatch' })
  .refine((v) => new Set(v.reports.map((r) => r.kind)).size === 2, {
    message: 'fixture report kinds mismatch',
  });
export function reportAcceptanceCodeSha256(repositoryRoot = '.') {
  const root = realpathSync(repositoryRoot);
  return sha(
    [
      'scripts/verify-workload-assessment.ts',
      'scripts/lib/acceptance-public-control-reports.ts',
      'infra/supabase/migrations/0137_public_control_assessment_sources.sql',
      'infra/supabase/migrations/0138_public_control_report_provenance.sql',
      'packages/report-kit/src/public-control-provenance.ts',
      'packages/report-kit/src/board-report.ts',
      'packages/report-kit/src/auditor-source.ts',
      'services/bff/src/services/board-reports.ts',
      'services/bff/src/services/statutory-reports.ts',
    ]
      .map((p) => `${p}\0${sha(readFileSync(join(root, p)))}`)
      .join('\n') +
      '\nHEAD=' +
      execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', cwd: root }).trim(),
  );
}
export function readPublicReportBrowserHandoff(repositoryRoot = '.') {
  const root = realpathSync(repositoryRoot);
  const handoffPath = join(root, HANDOFF);
  const stat = lstatSync(handoffPath);
  assert(stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o077) === 0);
  const handoff = publicReportBrowserHandoffSchema.parse(
    JSON.parse(readFileSync(handoffPath, 'utf8')),
  );
  assert.equal(handoff.codeSha256, reportAcceptanceCodeSha256(root));
  const provider = ownedReportProvider(root);
  assert.equal(handoff.providerId, provider.providerId);
  assert.equal(handoff.providerRunId, provider.providerRunId);
  return handoff;
}
export function clearPublicReportBrowserHandoff() {
  try {
    unlinkSync(HANDOFF);
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  }
}
export function writePublicReportBrowserHandoff(value: unknown) {
  const handoff = publicReportBrowserHandoffSchema.parse(value);
  assert.equal(handoff.codeSha256, reportAcceptanceCodeSha256());
  mkdirSync('.axiom-runtime/review/all-agent-acceptance', { recursive: true, mode: 0o700 });
  writeFileSync(HANDOFF, JSON.stringify(handoff, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
}

type Request = (path: string, expected: number, options?: RequestInit) => Promise<Response>;
export async function verifyPublicControlReports(deps: {
  request: Request;
  db: SupabaseClient;
  tenantId: string;
  foreignTenantId: string;
  ownerHeaders: Record<string, string>;
  viewerHeaders: Record<string, string>;
  source: unknown;
  authUrl: string;
  anonKey: string;
  onPhase: (phase: string) => void;
}) {
  const provider = ownedReportProvider();
  const source = sourceProofSchema.parse(deps.source);
  const reportOutcomes: z.infer<typeof publicReportBrowserHandoffSchema>['reports'] = [];
  const post = (
    headers: Record<string, string>,
    body: unknown,
    key = randomUUID(),
  ): RequestInit => ({
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json', 'idempotency-key': key },
    body: JSON.stringify(body),
  });
  const check = <T>(reply: { data: T; error: unknown }) => {
    assert.equal(reply.error, null);
    return reply.data;
  };
  deps.onPhase('fresh-founder-authentication');
  const password = randomBytes(32).toString('base64url');
  const created = await deps.db.auth.admin.createUser({
    email: `public-report-${randomUUID()}@example.invalid`,
    password,
    email_confirm: true,
  });
  assert.equal(created.error, null);
  const user = created.data.user!;
  check(
    await deps.db.from('users').insert({ id: user.id, email: user.email, is_axiom_internal: true }),
  );
  check(
    await deps.db.from('tenant_users').insert([
      { tenant_id: deps.tenantId, user_id: user.id, role: 'founder' },
      { tenant_id: deps.foreignTenantId, user_id: user.id, role: 'founder' },
    ]),
  );
  const client = createClient(deps.authUrl, deps.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const signed = await client.auth.signInWithPassword({ email: user.email!, password });
  assert.equal(signed.error, null);
  assert(signed.data.session?.access_token);
  const founder = {
    Authorization: `Bearer ${signed.data.session.access_token}`,
    'x-tenant-id': deps.tenantId,
    'x-expected-actor-id': user.id,
  };
  await deps.request('/v1/assessment', 403, { headers: founder });
  const factor = z
    .object({ factorId: uuid, secret: z.string().min(1) })
    .parse(await (await deps.request('/v1/mfa/enrol', 201, post(founder, {}))).json());
  const activated = z
    .object({ recoveryCodes: z.array(z.string()).min(4) })
    .parse(
      await (
        await deps.request(
          '/v1/mfa/enrol/activate',
          200,
          post(founder, { code: generateTotp(factor.secret) }),
        )
      ).json(),
    );
  await deps.request('/v1/assessment', 401, { headers: founder });
  const challenge = z
    .object({ challengeId: uuid })
    .parse(
      await (
        await deps.request('/v1/mfa/challenge', 201, post(founder, { purpose: 'login' }))
      ).json(),
    );
  await deps.request(
    `/v1/mfa/challenge/${challenge.challengeId}/verify`,
    200,
    post(founder, { code: activated.recoveryCodes[0] }),
  );
  // This is the real login-MFA/session gate, not a per-report step-up claim.
  const packet = check(
    await deps.db
      .from('workload_assessment_packets')
      .select('result_digest,finalized_receipt')
      .eq('tenant_id', deps.tenantId)
      .eq('run_id', source.runId)
      .single(),
  );
  assert(packet?.finalized_receipt);
  const resultDigest = digest.parse(packet.result_digest);
  const vault = new EvidenceVault('ap-south-1', provider.endpoint, provider);
  try {
    for (const kind of ['board', 'auditor'] as const) {
      deps.onPhase(`${kind}-request`);
      const requestPath =
        kind === 'board' ? '/v1/reports/board/request' : '/v1/reports/statutory/auditor/requests';
      const body = {
        engagementId: source.engagementId,
        assessmentRunId: source.runId,
        title: `Synthetic source-linked ${kind} report`,
        operationKey: randomUUID(),
      };
      const requested = z
        .object({ requestId: uuid })
        .parse(await (await deps.request(requestPath, 201, post(deps.ownerHeaders, body))).json());
      const replay = z
        .object({ requestId: uuid, replayed: z.literal(true) })
        .parse(await (await deps.request(requestPath, 201, post(deps.ownerHeaders, body))).json());
      assert.equal(replay.requestId, requested.requestId);
      const generatePath =
        kind === 'board'
          ? `/v1/reports/board/${requested.requestId}/generate`
          : `/v1/reports/statutory/auditor/requests/${requested.requestId}/draft`;
      await deps.request(generatePath, 403, post(deps.ownerHeaders, {}));
      const generated = z
        .object({ reportId: uuid })
        .parse(
          await (
            await deps.request(generatePath, kind === 'board' ? 200 : 201, post(founder, {}))
          ).json(),
        );
      const reportId = generated.reportId;
      const row = z
        .object({ content_text: z.string(), content_sha256: digest, status: z.literal('draft') })
        .parse(
          check(
            await deps.db
              .from('reports')
              .select('content_text,content_sha256,status')
              .eq('tenant_id', deps.tenantId)
              .eq('id', reportId)
              .single(),
          ),
        );
      assert.equal(sha(row.content_text), row.content_sha256);
      const frozen = z.object({ source_text: z.string(), source_sha256: digest }).parse(
        check(
          await deps.db
            .from(kind === 'board' ? 'board_request_sources' : 'statutory_request_sources')
            .select('source_text,source_sha256')
            .eq('tenant_id', deps.tenantId)
            .eq('request_id', requested.requestId)
            .single(),
        ),
      );
      assert.equal(sha(frozen.source_text), frozen.source_sha256);
      const parsed =
        kind === 'board'
          ? FrozenBoardSourceSchema.parse(parseCatalogueJson(frozen.source_text, 4194304))
          : FrozenAuditorSourceSchema.parse(parseCatalogueJson(frozen.source_text, 4194304));
      assert.equal(parsed.schema_version, 2);
      assert(parsed.schema_version === 2);
      assert.equal(parsed.result_sha256, resultDigest);
      const h = parsed.human_control_review;
      assert.equal(h.review.id, source.reviewId);
      assert.equal(h.job_id, source.jobId);
      assert.equal(h.worker_input.sha256, source.inputSha256);
      assert.equal(h.capture.capture_receipt.id, source.captureReceipt);
      assert.equal(h.review.receipt.id, source.reviewReceipt);
      assert.equal(h.requested_receipt.id, source.requestedReceipt);
      const appendix = verifyFrozenHumanControlReview(h, {
        tenantId: deps.tenantId,
        engagementId: source.engagementId,
        assessmentRunId: source.runId,
        libraryVersion: parsed.library_version,
        controlsText: parsed.controls_text,
        resultText: parsed.result_text,
      });
      const content =
        kind === 'board'
          ? BoardReportContentV3Schema.parse(JSON.parse(row.content_text))
          : AuditorAssessmentPackV3Schema.parse(JSON.parse(row.content_text));
      assert.equal(content.schema_version, 3);
      assert.deepEqual(content.public_review_appendix, appendix);
      assert.equal(appendix.controls.length, 46);
      assert.equal(appendix.declarationsVerified, false);
      assert.equal(appendix.evidenceVerified, false);
      assert.equal(appendix.requiresHumanReview, true);
      assert.equal(
        appendix.controls.find((c) => c.controlId === 'DPDPA-GOV-001')?.questions[0]?.judgment,
        'explicit',
      );
      assert.equal(
        appendix.controls.find((c) => c.controlId === 'DPDPA-GOV-002')?.questions[0]?.judgment,
        'omitted',
      );
      const pdfPath =
        kind === 'board'
          ? `/v1/reports/board/${reportId}/pdf`
          : `/v1/reports/statutory/${reportId}/pdf`;
      await deps.request(pdfPath, 409, { headers: founder });
      await deps.request(
        `/v1/reports/${reportId}/release`,
        409,
        post(founder, {
          expectedContentHash: row.content_sha256,
          expectedArchiveHash: '0'.repeat(64),
        }),
      );
      deps.onPhase(`${kind}-human-mfa-session-review`);
      const reviewed = await deps.request(
        `/v1/reports/${reportId}/review`,
        200,
        post(founder, { decision: 'approved', expectedContentHash: row.content_sha256 }),
      );
      assert.equal(
        z.object({ data: z.object({ status: z.literal('approved') }) }).parse(await reviewed.json())
          .data.status,
        'approved',
      );
      const base =
        kind === 'board'
          ? `/v1/reports/board/${reportId}/artifacts`
          : `/v1/reports/statutory/${reportId}/artifacts`;
      const operationKey = randomUUID();
      deps.onPhase(`${kind}-real-provider-archive`);
      const built = z
        .object({ buildId: uuid, status: z.literal('settled') })
        .parse(await (await deps.request(base, 200, post(founder, { operationKey }))).json());
      const again = z
        .object({ buildId: uuid, status: z.literal('settled') })
        .parse(
          await (
            await deps.request(base + '/reconcile', 200, post(founder, { operationKey }))
          ).json(),
        );
      assert.equal(again.buildId, built.buildId);
      const versions = z
        .array(artifact)
        .length(2)
        .parse(
          check(
            await deps.db
              .from(kind === 'board' ? 'board_artifact_versions' : 'statutory_artifact_versions')
              .select(
                'artifact_kind,bucket,object_key,version_id,content_hash,byte_size,retain_until',
              )
              .eq('tenant_id', deps.tenantId)
              .eq('build_id', built.buildId),
          ),
        );
      const sourceVersion = versions.find((v) => v.artifact_kind === 'source_json');
      const pdf = versions.find(
        (v) => v.artifact_kind === (kind === 'board' ? 'board_pdf' : 'statutory_pdf'),
      );
      assert(sourceVersion && pdf);
      assert.equal(sourceVersion.content_hash, frozen.source_sha256);
      for (const version of versions) {
        await vault.verifyReceipt(
          {
            bucket: version.bucket,
            key: version.object_key,
            versionId: version.version_id,
            contentHash: version.content_hash,
            byteSize: version.byte_size,
            tenantId: deps.tenantId,
            engagementId: source.engagementId,
            collectedByAgent:
              kind === 'board' ? 'board-report-builder' : 'statutory-report-builder',
            operationId: built.buildId,
            retainUntil: version.retain_until,
            legalHold: false,
            encryption: 'AES256',
          },
          { maxBytes: 32 * 1024 * 1024, timeoutMs: 30000 },
        );
        const actual = await vault.retrieve(
          version.bucket,
          version.object_key,
          version.version_id,
          { maxBytes: 32 * 1024 * 1024, timeoutMs: 30000 },
        );
        assert.equal(actual.body.length, version.byte_size);
        assert.equal(sha(actual.body), version.content_hash);
        assert(new Date(version.retain_until).getTime() > Date.now() + 6 * 365 * 86400000);
        if (version.artifact_kind === 'source_json')
          assert.equal(actual.body.toString('utf8'), frozen.source_text);
        else assert.equal(actual.body.subarray(0, 5).toString(), '%PDF-');
      }
      await deps.request(pdfPath, 403, { headers: deps.viewerHeaders });
      await deps.request(
        `/v1/reports/${reportId}/release`,
        409,
        post(founder, {
          expectedContentHash: row.content_sha256,
          expectedArchiveHash: '0'.repeat(64),
        }),
      );
      await deps.request(
        `/v1/reports/${reportId}/release`,
        200,
        post(founder, {
          expectedContentHash: row.content_sha256,
          expectedArchiveHash: pdf.content_hash,
        }),
      );
      const download = await deps.request(pdfPath, 200, { headers: deps.viewerHeaders });
      assert.equal(download.headers.get('x-report-sha256'), pdf.content_hash);
      assert.equal(sha(Buffer.from(await download.arrayBuffer())), pdf.content_hash);
      await deps.request(pdfPath, 403, { headers: { ...founder, 'x-tenant-id': randomUUID() } });
      const foreign = { ...founder, 'x-tenant-id': deps.foreignTenantId };
      await deps.request(pdfPath, 404, { headers: foreign });
      await deps.request(`/v1/reports/${reportId}`, 404, { headers: foreign });
      reportOutcomes.push({
        kind,
        requestId: requested.requestId,
        reportId,
        sourceSha256: frozen.source_sha256,
        contentSha256: row.content_sha256,
        pdfSha256: pdf.content_hash,
      });
    }
  } finally {
    vault.close();
  }
  const verified = await deps.db.rpc('verify_ledger', {
    p_tenant_id: deps.tenantId,
    p_from_sequence: 1,
  });
  assert.equal(verified.error, null);
  assert.deepEqual(verified.data, []);
  return publicReportBrowserHandoffSchema.parse({
    version: 1,
    kind: 'owned-reviewed-public-source-reports',
    tenantId: deps.tenantId,
    tenantSlug: `worker-${deps.tenantId}`,
    source,
    resultDigest,
    reports: reportOutcomes,
    providerId: provider.providerId,
    providerRunId: provider.providerRunId,
    mode: 'synthetic-loopback-provider-not-cloud-acceptance',
    codeSha256: reportAcceptanceCodeSha256(),
  });
}
