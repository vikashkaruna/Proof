import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { registeredWebsiteSourceInBrowser } from '../fixtures/public-asset-workflow';
import {
  registeredBrowserRequested,
  readOwnedRegisteredBrowser,
  verifyRegisteredBrowserServer,
} from '../../../scripts/lib/acceptance-public-asset-browser';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { test, expect, type Page } from '@playwright/test';
import { z } from 'zod';
import {
  createMfaAccount,
  selectTenant,
  signIn,
  signInAs,
  satisfyLoginMfaWithSecret,
  state,
  signInFreshOwner,
} from '../fixtures';
import { localRoleBearer } from '../local-writer';
import { acceptanceTarget, repoRoot, tenantCookie } from '../target';
import {
  reportAcceptanceRequested,
  readPublicReportBrowserHandoff,
} from '../../../scripts/lib/acceptance-public-control-reports';
import {
  BoardReportContentV3Schema,
  BoardReportContentV4Schema,
} from '../../../packages/report-kit/src/board-report';
import { EvidenceVault } from '../../../packages/evidence/src/index';
import { unzipSync } from 'fflate';

const execFileAsync = promisify(execFile);
const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');

function localFixture() {
  const endpoint = process.env.AXIOM_STORAGE_ENDPOINT;
  const bucket = process.env.AXIOM_EVIDENCE_BUCKET;
  const accessKeyId = process.env.AXIOM_STORAGE_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AXIOM_STORAGE_SECRET_ACCESS_KEY;
  const directory = process.env.AXIOM_EVIDENCE_FIXTURE_DIRECTORY;
  if (
    acceptanceTarget ||
    !endpoint ||
    new URL(endpoint).hostname !== '127.0.0.1' ||
    new URL(state.supabaseUrl).hostname !== '127.0.0.1' ||
    !bucket ||
    !accessKeyId ||
    !secretAccessKey ||
    !directory
  )
    throw new Error('Owned local board report provider fixture required');
  return { endpoint, bucket, accessKeyId, secretAccessKey, directory };
}

async function providerAction(action: '--pause-provider' | '--resume-provider') {
  const { directory } = localFixture();
  await execFileAsync(
    'python3',
    [`${repoRoot}/scripts/test-evidence-storage.py`, '--directory', directory, action],
    { cwd: repoRoot, timeout: 100_000 },
  );
}

async function database(path: string, body?: unknown, bearer: string = state.serviceKey) {
  const response = await fetch(`${state.supabaseUrl}/rest/v1/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
    headers: {
      apikey: state.publishableKey,
      authorization: `Bearer ${bearer}`,
      'content-type': 'application/json',
      Prefer: 'return=representation',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`Board fixture ${path}: HTTP ${response.status}`);
  return response.json() as Promise<unknown>;
}

async function fixturePatch(path: string, body: Record<string, unknown>) {
  const response = await fetch(`${state.supabaseUrl}/rest/v1/${path}`, {
    method: 'PATCH',
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
    headers: {
      apikey: state.publishableKey,
      authorization: `Bearer ${state.serviceKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(204);
}

const humanWriter = () => localRoleBearer('human_action_writer', state);

async function rpc<T>(name: string, args: Record<string, unknown>, bearer?: string): Promise<T> {
  const result = (await database(`rpc/${name}`, args, bearer)) as T & { error?: string };
  if (result.error) throw new Error(`${name}: ${result.error}`);
  return result;
}

/** Only source setup is inserted. Assessment, receipts and report state use their sanctioned RPCs. */
async function finalizedAssessment(
  actorId: string,
  findingRationale = 'Synthetic board acceptance finding',
) {
  localFixture();
  const suffix = crypto.randomUUID();
  const libraryVersion = `board-e2e-${suffix}`;
  const estateId = crypto.randomUUID();
  const engagementId = crypto.randomUUID();
  const controlId = `BOARD-${suffix}`;
  await database('control_libraries', {
    version: libraryVersion,
    published_at: new Date().toISOString(),
    published_by: 'board-provider-fixture',
    change_log: 'Synthetic one-control board acceptance',
    control_count: 1,
    is_current: false,
  });
  await database('controls', {
    id: controlId,
    library_version: libraryVersion,
    title: 'Synthetic privacy control',
    obligation: 'Synthetic board acceptance only',
    domain: 'GOV',
    severity: 'high',
    citations: [],
    evidence_required: [],
    assessment_questions: [],
    scoring: { baseline: 0, weight: 1, penaltyPoints: 10, maxPenaltyINR: 1000000 },
    remediation_patterns: ['review'],
    introduced_in_version: libraryVersion,
  });
  await database('estates', {
    id: estateId,
    tenant_id: state.tenantA.id,
    slug: `board-${suffix.slice(0, 12)}`,
    name: `Board fixture ${suffix}`,
  });
  await database('engagements', {
    id: engagementId,
    tenant_id: state.tenantA.id,
    estate_id: estateId,
    library_version: libraryVersion,
    title: `Board assessment ${suffix}`,
  });
  const spiffeId = 'spiffe://axiom.test/agent/parikshan';
  const existing = (await database(
    `workload_identities?tenant_id=eq.${state.tenantA.id}&spiffe_id=eq.${encodeURIComponent(spiffeId)}&select=id,status,version`,
  )) as { id: string; status: string; version: number }[];
  const workloadId = existing[0]?.id ?? crypto.randomUUID();
  let registration = existing[0];
  if (!registration) {
    registration = (await rpc<{ version: number; status: string }>(
      'manage_workload_identity',
      {
        p_tenant_id: state.tenantA.id,
        p_actor_id: actorId,
        p_correlation_id: crypto.randomUUID(),
        p_workload_id: workloadId,
        p_expected_version: 0,
        p_agent: 'parikshan',
        p_spiffe_id: spiffeId,
        p_status: 'disabled',
      },
      humanWriter(),
    )) as { id: string; version: number; status: string };
  }
  if (registration.status !== 'active') {
    const activation = await rpc<{ status: string }>(
      'manage_workload_identity',
      {
        p_tenant_id: state.tenantA.id,
        p_actor_id: actorId,
        p_correlation_id: crypto.randomUUID(),
        p_workload_id: workloadId,
        p_expected_version: registration.version,
        p_agent: 'parikshan',
        p_spiffe_id: spiffeId,
        p_status: 'active',
      },
      humanWriter(),
    );
    expect(activation.status).toBe('active');
  }
  const proofHash = sha(`board-proof-${suffix}`);
  const inputHash = sha(`board-input-${suffix}`);
  const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
  const issued = await rpc<{ run_id: string }>(
    'delegate_workload_task',
    {
      p_tenant_id: state.tenantA.id,
      p_actor_id: actorId,
      p_workload_id: workloadId,
      p_agent: 'parikshan',
      p_estate_id: estateId,
      p_engagement_id: engagementId,
      p_correlation_id: crypto.randomUUID(),
      p_input_hash: inputHash,
      p_proof_hash: proofHash,
      p_scopes: ['control_library.read', 'findings.write'],
      p_expires_at: expiresAt,
    },
    humanWriter(),
  );
  expect(issued.run_id).toMatch(/^[0-9a-f-]{36}$/);
  const started = await rpc<{ library_digest: string; controls: { id: string }[] }>(
    'start_workload_assessment',
    {
      p_tenant_id: state.tenantA.id,
      p_run_id: issued.run_id,
      p_workload_id: workloadId,
      p_proof_hash: proofHash,
      p_input_hash: inputHash,
      p_identity_expires_at: expiresAt,
    },
  );
  expect(started.controls.map((c) => c.id)).toEqual([controlId]);
  const result = {
    library_version: libraryVersion,
    posture_score: 61,
    estimated_exposure_inr: 1000000,
    findings: [
      {
        control_id: controlId,
        score: 61,
        risk_points: 10,
        rationale: findingRationale,
      },
    ],
  };
  const completed = await rpc<{ result_digest: string }>('complete_workload_assessment', {
    p_tenant_id: state.tenantA.id,
    p_run_id: issued.run_id,
    p_workload_id: workloadId,
    p_proof_hash: proofHash,
    p_library_digest: started.library_digest,
    p_result: result,
    p_identity_expires_at: expiresAt,
  });
  expect(completed.result_digest).toMatch(/^[0-9a-f]{64}$/);
  const finalized = await rpc<{ status: string; finalized_receipt: string }>(
    'confirm_workload_assessment',
    { p_tenant_id: state.tenantA.id, p_run_id: issued.run_id },
  );
  expect(finalized.status).toBe('succeeded');
  expect(finalized.finalized_receipt).toMatch(/^[1-9][0-9]*$/);
  return { engagementId, runId: issued.run_id, resultDigest: completed.result_digest };
}

async function postInTenant(page: Page, path: string, body: unknown, tenantId = state.tenantA.id) {
  return page.request.post(`/api/bff/v1${path}`, {
    headers: { 'x-tenant-id': tenantId, 'idempotency-key': crypto.randomUUID() },
    data: body,
  });
}
const post = postInTenant;

async function boardRequest(
  page: Page,
  assessment: Awaited<ReturnType<typeof finalizedAssessment>>,
  tenantId = state.tenantA.id,
) {
  const title = `Provider board ${crypto.randomUUID()}`;
  const body = {
    engagementId: assessment.engagementId,
    assessmentRunId: assessment.runId,
    title,
    operationKey: crypto.randomUUID(),
  };
  const requested = await postInTenant(page, '/reports/board/request', body, tenantId);
  expect(requested.status()).toBe(201);
  const request = (await requested.json()) as { requestId: string; replayed: boolean };
  expect(request.replayed).toBe(false);
  const repeated = await postInTenant(page, '/reports/board/request', body, tenantId);
  expect(repeated.status()).toBe(201);
  expect(((await repeated.json()) as typeof request).requestId).toBe(request.requestId);
  return { ...request, title };
}

/** Continue the real controller packet through the ordinary Reports form.
 * The real server commits before response delivery is lost; reload and explicit
 * confirmed retry must recover the original journal without a second intent. */
async function boardRequestInBrowser(
  page: Page,
  assessment: Awaited<ReturnType<typeof finalizedAssessment>>,
  tenantId: string,
  actorId: string,
) {
  const title = `Source-linked browser board ${crypto.randomUUID()}`;
  const bodySchema = z
    .object({
      engagementId: z.uuid(),
      assessmentRunId: z.uuid(),
      title: z.string(),
      operationKey: z.uuid(),
    })
    .strict();
  const receiptSchema = z
    .object({
      requestId: z.uuid(),
      status: z.literal('requested'),
      reportId: z.null(),
      replayed: z.boolean(),
    })
    .strict();
  type Observation = {
    body: z.infer<typeof bodySchema>;
    headers: Record<string, string>;
    journal: string | null;
    journalKey: string;
    rawBody: string;
    saved: z.infer<typeof receiptSchema>;
  };
  let observe: (value: Observation) => void = () => {};
  let refuseObservation: (reason: unknown) => void = () => {};
  const observation = new Promise<Observation>((resolve, reject) => {
    observe = resolve;
    refuseObservation = reject;
  });
  const path = '/api/bff/v1/reports/board/request';
  const routePattern = `**${path}`;
  await page.goto('/reports');
  const form = page
    .getByRole('region', { name: 'Board report workflow' })
    .getByRole('form', { name: 'Request board report' });
  await expect(form.getByRole('option', { name: /Choose a finalized assessment/ })).toBeAttached();
  await expect(form.locator(`option[value="${assessment.runId}"]`)).toBeAttached();
  await form.getByLabel('Assessment', { exact: true }).selectOption(assessment.runId);
  await form.getByLabel('Report title', { exact: true }).fill(title);
  await form
    .getByRole('checkbox', {
      name: 'I request a draft bound to this finalized assessment and its recorded control library.',
    })
    .check();
  await expect(
    form.getByRole('button', { name: 'Request board draft', exact: true }),
  ).toBeEnabled();
  let requests = 0;
  const recordRequest = (request: import('@playwright/test').Request) => {
    if (new URL(request.url()).pathname === path && request.method() === 'POST') requests++;
  };
  page.on('request', recordRequest);
  await page.route(routePattern, async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    try {
      const rawBody = route.request().postData();
      if (rawBody === null) throw new Error('Report form sent no request body');
      const body = bodySchema.parse(JSON.parse(rawBody));
      const journalKey = `axiom.report-request.operation.v1:${tenantId}:${actorId}:board:${body.operationKey}`;
      const journal = await page.evaluate((key) => localStorage.getItem(key), journalKey);
      // The actual server commits and returns its strict receipt. Only its
      // delivery to the browser is lost; no response or receipt is fabricated.
      const committed = await route.fetch({ maxRetries: 0, maxRedirects: 0 });
      expect(committed.status()).toBe(201);
      const saved = receiptSchema.parse(await committed.json());
      expect(saved.replayed).toBe(false);
      observe({ body, rawBody, journalKey, journal, headers: route.request().headers(), saved });
    } catch (error) {
      refuseObservation(error);
    } finally {
      await route.abort('failed');
    }
  });
  let saved: z.infer<typeof receiptSchema>;
  let original: Observation;
  try {
    await form.getByRole('button', { name: 'Request board draft', exact: true }).click();
    original = await observation;
    saved = original.saved;
    expect(requests).toBe(1);
    expect(original.headers['x-tenant-id']).toBe(tenantId);
    expect(original.headers['x-expected-actor-id']).toBe(actorId);
    expect(z.uuid().safeParse(original.headers['idempotency-key']).success).toBe(true);
    expect(original.body).toEqual({
      engagementId: assessment.engagementId,
      assessmentRunId: assessment.runId,
      title,
      operationKey: original.body.operationKey,
    });
    const journal = z
      .object({
        version: z.literal(1),
        tenantId: z.uuid(),
        actorId: z.uuid(),
        kind: z.literal('board'),
        body: bodySchema,
      })
      .strict()
      .parse(JSON.parse(original.journal ?? 'null'));
    expect(journal).toEqual({ version: 1, tenantId, actorId, kind: 'board', body: original.body });
    await expect(
      page.getByRole('alert').filter({ hasText: 'The outcome is uncertain.' }),
    ).toBeVisible();
    expect(await page.evaluate((key) => localStorage.getItem(key), original.journalKey)).toBe(
      original.journal,
    );
  } finally {
    await page.unroute(routePattern);
  }
  try {
    await page.reload();
    const workflow = page.getByRole('region', { name: 'Board report workflow' });
    const pending = workflow.getByRole('region', { name: 'Retained report request' });
    await expect(pending).toContainText(title);
    for (const identity of [assessment.engagementId, assessment.runId, original.body.operationKey])
      await expect(pending).toContainText(identity);
    const confirmation = pending.getByRole('checkbox', {
      name: 'I authorize checking or retrying this exact retained request.',
    });
    const retry = pending.getByRole('button', {
      name: 'Check or retry exact retained request',
      exact: true,
    });
    await expect(confirmation).toBeEnabled();
    await expect(confirmation).not.toBeChecked();
    await expect(retry).toBeDisabled();
    await expect(
      workflow.getByRole('button', { name: 'Request board draft', exact: true }),
    ).toBeDisabled();
    expect(await page.evaluate((key) => localStorage.getItem(key), original.journalKey)).toBe(
      original.journal,
    );
    expect(requests).toBe(1); // Reload/readback must never send the retained mutation automatically.
    const retryRequest = page.waitForRequest(
      (request) => new URL(request.url()).pathname === path && request.method() === 'POST',
    );
    const retryResponse = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === path && response.request().method() === 'POST',
    );
    await confirmation.check();
    await retry.click();
    const [sent, positive] = await Promise.all([retryRequest, retryResponse]);
    expect(sent.postData()).toBe(original.rawBody);
    expect(sent.headers()['x-tenant-id']).toBe(tenantId);
    expect(sent.headers()['x-expected-actor-id']).toBe(actorId);
    expect(positive.status()).toBe(201);
    expect(receiptSchema.parse(await positive.json())).toEqual({ ...saved, replayed: true });
    expect(requests).toBe(2);
    await expect
      .poll(() => page.evaluate((key) => localStorage.getItem(key), original.journalKey))
      .toBeNull();
    await expect(workflow.getByRole('button', { name: new RegExp(title) })).toBeVisible();
  } finally {
    page.off('request', recordRequest);
  }
  // Replay precisely the UI intent, through the real API and same authenticated actor.
  const replay = await page.request.post(path, {
    headers: {
      'x-tenant-id': tenantId,
      'x-expected-actor-id': actorId,
      'content-type': 'application/json',
      'idempotency-key': crypto.randomUUID(),
    },
    data: original.rawBody,
  });
  expect(replay.status()).toBe(201);
  expect(receiptSchema.parse(await replay.json())).toEqual({ ...saved, replayed: true });
  return { ...saved, title };
}

async function reportRow(reportId: string) {
  const rows = (await database(`reports?id=eq.${reportId}&select=*`)) as {
    id: string;
    content_text: string;
    content_sha256: string;
    status: string;
    released_archive_hash: string | null;
  }[];
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

test.describe('real-provider board report lifecycle', () => {
  test.skip(
    process.env.AXIOM_EVIDENCE_STORAGE_ACCEPTANCE !== 'true',
    'Run with the retained local Object Lock provider.',
  );

  test('finalized source, released board PDF, and source-bound Pramaan dossier use exact retained versions', async ({
    page,
    browser,
  }) => {
    test.setTimeout(300_000);
    if (registeredBrowserRequested()) {
      const owned = readOwnedRegisteredBrowser(repoRoot);
      await verifyRegisteredBrowserServer(owned.config);
      await registeredWebsiteSourceInBrowser(page, owned.config, owned.directory);
      await expect
        .poll(
          () =>
            existsSync(
              join(
                repoRoot,
                '.axiom-runtime/review/all-agent-acceptance/public-report-browser-handoff.private.json',
              ),
            ),
          { timeout: 90000, message: 'Original controller must finalize before report handoff' },
        )
        .toBe(true);
    }
    const sourceHandoff = reportAcceptanceRequested()
      ? readPublicReportBrowserHandoff(repoRoot)
      : undefined;
    const tenantId = sourceHandoff?.tenantId ?? state.tenantA.id;
    const post = (actor: Page, path: string, body: unknown) =>
      postInTenant(actor, path, body, tenantId);
    const select = async (actor: Page, id: string, role: 'admin' | 'founder' | 'viewer') => {
      if (!sourceHandoff) return selectTenant(actor, 'a');
      await database('tenant_users', { tenant_id: tenantId, user_id: id, role });
      await actor.context().addCookies([tenantCookie(sourceHandoff.tenantSlug)]);
    };
    const manager = await createMfaAccount('board-manager', { role: 'admin', withFactor: true });
    await signInAs(page, manager.email, manager.password, manager.totpSecret!);
    await select(page, manager.id, 'admin');
    const assessment = sourceHandoff
      ? {
          engagementId: sourceHandoff.source.engagementId,
          runId: sourceHandoff.source.runId,
          resultDigest: sourceHandoff.resultDigest,
        }
      : await finalizedAssessment(manager.id);
    const request = sourceHandoff
      ? await boardRequestInBrowser(page, assessment, tenantId, manager.id)
      : await boardRequest(page, assessment, tenantId);
    expect((await post(page, `/reports/board/${request.requestId}/generate`, {})).status()).toBe(
      403,
    );
    const founderContext = await browser.newContext();
    const viewerContext = await browser.newContext();
    try {
      const founder = await founderContext.newPage();
      const founderAccount = await createMfaAccount('board-provider-founder', {
        role: 'founder',
        isInternal: true,
        withFactor: true,
      });
      await signInAs(founder, founderAccount.email, founderAccount.password);
      await select(founder, founderAccount.id, 'founder');
      await satisfyLoginMfaWithSecret(founder, founderAccount.totpSecret!);
      const generated = await post(founder, `/reports/board/${request.requestId}/generate`, {});
      expect(generated.status()).toBe(200);
      const draft = (await generated.json()) as { reportId: string };
      const row = await reportRow(draft.reportId);
      expect(sha(row.content_text)).toBe(row.content_sha256);
      expect(JSON.parse(row.content_text)).toMatchObject({
        assessment_run_id: assessment.runId,
        assessment_result_digest: assessment.resultDigest,
      });
      if (sourceHandoff) {
        const document = (
          sourceHandoff.source.asset ? BoardReportContentV4Schema : BoardReportContentV3Schema
        ).parse(JSON.parse(row.content_text));
        expect(document.schema_version).toBe(sourceHandoff.source.asset ? 4 : 3);
        if (sourceHandoff.source.asset) {
          expect('asset_scope' in document).toBe(true);
          if (!('asset_scope' in document))
            throw new Error('Registered asset report downgrade refused');
          expect(document.asset_scope.estate.id).toBe(sourceHandoff.source.estateId);
          expect(document.asset_scope.system.id).toBe(sourceHandoff.source.systemId);
          expect(document.asset_scope.target.id).toBe(sourceHandoff.source.asset.targetId);
          expect(document.asset_scope.association.id).toBe(
            sourceHandoff.source.asset.associationId,
          );
          expect(document.asset_scope.target.sha256).toBe(sourceHandoff.source.asset.targetSha256);
          expect(document.asset_scope.association.sha256).toBe(
            sourceHandoff.source.asset.associationSha256,
          );
          expect(document.asset_scope.target.url).toBe('https://fixture.axiomproof.ai/');
          expect(document.asset_scope.ownership_verified).toBe(false);
          expect(document.asset_scope.connector_access_granted).toBe(false);
          expect(document.asset_scope.review_required).toBe(true);
        }
        expect(document.public_review_appendix.reviewId).toBe(sourceHandoff.source.reviewId);
        expect(document.public_review_appendix.controls).toHaveLength(46);
        expect(document.public_review_appendix.declarationsVerified).toBe(false);
        expect(document.public_review_appendix.evidenceVerified).toBe(false);
      }
      const detail = await founder.request.get(`/api/bff/v1/reports/${draft.reportId}`);
      expect(detail.status()).toBe(200);
      const report = ((await detail.json()) as { data: { contentHash: string } }).data;
      expect(report.contentHash).toBe(row.content_sha256);
      expect(
        (await founder.request.get(`/api/bff/v1/reports/board/${draft.reportId}/pdf`)).status(),
      ).toBe(409);
      const premature = await post(founder, `/reports/${draft.reportId}/release`, {
        expectedContentHash: row.content_sha256,
        expectedArchiveHash: '0'.repeat(64),
      });
      expect(premature.status()).toBe(409);
      expect(((await premature.json()) as { error: { code: string } }).error.code).toBe(
        'not_approved',
      );
      if (sourceHandoff) {
        await founder.goto('/reports');
        const workflow = founder.getByRole('region', { name: 'Board report workflow' });
        await workflow.getByRole('button', { name: new RegExp(request.title) }).click();
        const selected = founder.locator('[aria-label="Selected board request"]');
        await selected.getByRole('button', { name: 'Open report for review' }).click();
        const review = founder.getByRole('region', { name: 'Report detail' });
        await expect(
          review.getByRole('heading', { name: request.title, exact: true }),
        ).toBeVisible();
        await review.getByText('Exact recorded content', { exact: true }).click();
        await expect(review.locator('pre')).toContainText(sourceHandoff.source.reviewId);
        if (sourceHandoff.source.asset) {
          await expect(review.locator('pre')).toContainText('human-declared asset scope');
          await expect(review.locator('pre')).toContainText(
            'Synthetic controller acceptance estate',
          );
          await expect(review.locator('pre')).toContainText('Synthetic public website inventory');
          await expect(review.locator('pre')).toContainText('fixture.axiomproof.ai');
          await expect(review.locator('pre')).toContainText('does not verify website ownership');
          await expect(review.locator('pre')).toContainText('unknown');
          await expect(review.locator('pre')).toContainText('privacy_notice');
          await expect(review.locator('pre')).toContainText('processor_disclosure');
          await expect(review.locator('pre')).toContainText('consent_ui');
        }

        await review
          .getByRole('checkbox', { name: 'I reviewed the exact content and SHA-256 shown above.' })
          .check();
        const response = founder.waitForResponse(
          (r) =>
            new URL(r.url()).pathname === `/api/bff/v1/reports/${draft.reportId}/review` &&
            r.request().method() === 'POST',
        );
        await review.getByRole('button', { name: 'Approve reviewed content' }).click();
        expect((await response).status()).toBe(200);
        await expect(review.getByText(/^approved · [^·]+ · Library /)).toBeVisible();
      } else {
        const reviewed = await post(founder, `/reports/${draft.reportId}/review`, {
          decision: 'approved',
          expectedContentHash: row.content_sha256,
        });
        expect(reviewed.status()).toBe(200);
        expect(((await reviewed.json()) as { data: { status: string } }).data.status).toBe(
          'approved',
        );
      }
      const operationKey = crypto.randomUUID();
      const artifactRequestStarted = performance.now();
      const built = await post(founder, `/reports/board/${draft.reportId}/artifacts`, {
        operationKey,
      });
      const artifactRequestElapsedMs = performance.now() - artifactRequestStarted;
      // The body carries the BFF error code; without it a CI 503 is opaque.
      expect(built.status(), await built.text()).toBe(200);
      const result = (await built.json()) as { buildId: string; status: string };
      expect(result.status).toBe('settled');
      const rows = (await database(
        `board_artifact_versions?build_id=eq.${result.buildId}&select=*&order=artifact_kind.asc`,
      )) as {
        artifact_kind: string;
        bucket: string;
        object_key: string;
        version_id: string;
        content_hash: string;
        byte_size: number;
        retain_until: string;
      }[];
      expect(rows.map((r) => r.artifact_kind)).toEqual(['board_pdf', 'source_json']);
      const sources = (await database(
        `board_request_sources?request_id=eq.${request.requestId}&select=*`,
      )) as { source_text: string; source_sha256: string }[];
      const source = sources[0]!;
      expect(rows[1]!.content_hash).toBe(source.source_sha256);
      const config = localFixture();
      const vault = new EvidenceVault('ap-south-1', config.endpoint, config);
      try {
        for (const version of rows) {
          const actual = await vault.retrieve(
            version.bucket,
            version.object_key,
            version.version_id,
            { maxBytes: 32 * 1024 * 1024, timeoutMs: 30_000 },
          );
          expect(actual.body.length).toBe(version.byte_size);
          expect(sha(actual.body)).toBe(version.content_hash);
          if (version.artifact_kind === 'source_json')
            expect(actual.body.toString('utf8')).toBe(source.source_text);
          else expect(actual.body.subarray(0, 5).toString()).toBe('%PDF-');
          expect(new Date(version.retain_until).getTime()).toBeGreaterThan(
            Date.now() + 6 * 365 * 86400_000,
          );
        }
      } finally {
        vault.close();
      }
      const pdfVersion = rows[0]!;
      const privatePdf = await founder.request.get(
        `/api/bff/v1/reports/board/${draft.reportId}/pdf`,
      );
      expect(privatePdf.status()).toBe(200);
      const downloadedPdf = Buffer.from(await privatePdf.body());
      if (sourceHandoff?.source.asset) {
        const pdfFile = join(localFixture().directory, 'registered-source-board.private.pdf');
        const textFile = join(localFixture().directory, 'registered-source-board.private.txt');
        await writeFile(pdfFile, downloadedPdf, { mode: 0o600 });
        await execFileAsync('pdftotext', [pdfFile, textFile], { timeout: 10000 });
        const text = await import('node:fs/promises').then((fs) => fs.readFile(textFile, 'utf8'));
        expect(text).toMatch(/human.declared asset scope/i);
        expect(text).toContain('Synthetic controller acceptance estate');
        expect(text).toContain('Synthetic public website inventory');
        expect(text).toContain('fixture.axiomproof.ai');
        expect(text).toMatch(/does not verify website ownership/i);
        expect(text).toMatch(/unknown/i);
        expect(text).toContain('DPDPA-GOV-001');
      }

      expect(sha(downloadedPdf)).toBe(pdfVersion.content_hash);
      if (process.env.AXIOM_COLD_PDF_ACCEPTANCE === 'true') {
        expect(downloadedPdf.length).toBe(pdfVersion.byte_size);
        expect(downloadedPdf.subarray(0, 5).toString()).toBe('%PDF-');
        // Observe Chromium's PDF metadata, not an assumed value from requested mode.
        const creator = /\/Creator \(Chromium\)/.exec(downloadedPdf.toString('latin1'));
        expect(
          creator,
          'First retained PDF must carry the actual Chromium creator metadata',
        ).not.toBeNull();
        await writeFile(
          join(config.directory, 'private-cold-pdf-measurement.json'),
          JSON.stringify({
            scope: 'fresh-process-first-artifact-request',
            artifactRequestElapsedMs,
            pdfBytes: downloadedPdf.length,
            pdfSha256: pdfVersion.content_hash,
            downloadSha256: sha(downloadedPdf),
            pdfCreator: creator![0].slice('/Creator ('.length, -1),
            requiredChromiumSourcePath: true,
            osDiskCacheCold: 'unverified',
            remoteNfr: 'unverified',
            productionTimeoutChanged: false,
          }),
          { mode: 0o600 },
        );
      }
      const viewer = await viewerContext.newPage();
      if (sourceHandoff) {
        const account = await createMfaAccount('source-report-viewer', { role: 'viewer' });
        await signInAs(viewer, account.email, account.password);
        await select(viewer, account.id, 'viewer');
      } else {
        await signIn(viewer, 'viewer');
        await selectTenant(viewer, 'a');
      }
      expect(
        (await viewer.request.get(`/api/bff/v1/reports/board/${draft.reportId}/pdf`)).status(),
      ).toBe(403);
      const wrong = await post(founder, `/reports/${draft.reportId}/release`, {
        expectedContentHash: row.content_sha256,
        expectedArchiveHash: 'f'.repeat(64),
      });
      expect(wrong.status()).toBe(409);
      expect(((await wrong.json()) as { error: { code: string } }).error.code).toBe(
        'archive_hash_mismatch',
      );
      const released = await post(founder, `/reports/${draft.reportId}/release`, {
        expectedContentHash: row.content_sha256,
        expectedArchiveHash: pdfVersion.content_hash,
      });
      expect(released.status()).toBe(200);
      expect(((await released.json()) as { data: { status: string } }).data.status).toBe(
        'published',
      );
      const requestTimes = (await database(
        `board_report_requests?id=eq.${request.requestId}&select=created_at`,
      )) as { created_at: string }[];
      const reportTimes = (await database(
        `reports?id=eq.${draft.reportId}&select=generated_at,reviewed_at,published_at`,
      )) as { generated_at: string; reviewed_at: string; published_at: string }[];
      expect(requestTimes).toHaveLength(1);
      expect(reportTimes).toHaveLength(1);
      const requestedAt = Date.parse(requestTimes[0]!.created_at);
      const generatedAt = Date.parse(reportTimes[0]!.generated_at);
      const reviewedAt = Date.parse(reportTimes[0]!.reviewed_at);
      const publishedAt = Date.parse(reportTimes[0]!.published_at);
      expect([requestedAt, generatedAt, reviewedAt, publishedAt].every(Number.isFinite)).toBe(true);
      expect(requestedAt).toBeLessThanOrEqual(generatedAt);
      expect(generatedAt).toBeLessThanOrEqual(reviewedAt);
      expect(reviewedAt).toBeLessThanOrEqual(publishedAt);
      await test.info().attach('nfr8-board-report-timing.json', {
        body: Buffer.from(
          JSON.stringify({
            kind: 'board',
            fixture: sourceHandoff
              ? 'real worker finalized public-source reviewed packet, 46 controls'
              : 'one synthetic finalized assessment control',
            target: 'owned local provider',
            sourceBound: true,
            exactRetainedVersionsVerified: true,
            released: true,
            requestToDraftMs: generatedAt - requestedAt,
            draftToFounderReviewMs: reviewedAt - generatedAt,
            reviewToReleaseMs: publishedAt - reviewedAt,
            requestToReleaseWallMs: publishedAt - requestedAt,
            thresholdMs: 300_000,
            nfr8: 'UNVERIFIED: synthetic fixture, loopback provider and human-review dwell',
          }),
        ),
        contentType: 'application/json',
      });
      const publicPdf = await viewer.request.get(`/api/bff/v1/reports/board/${draft.reportId}/pdf`);
      expect(publicPdf.status()).toBe(200);
      expect(sha(Buffer.from(await publicPdf.body()))).toBe(pdfVersion.content_hash);
      for (const dossierType of [
        'dpb_statutory',
        'auditor_assurance',
        'technical_register',
        'full_closure',
      ]) {
        const unsupported = await post(
          page,
          `/engagements/${assessment.engagementId}/closure/pramaan`,
          {
            dossierType,
            reportId: draft.reportId,
            title: `Unsupported ${dossierType}`,
            operationKey: crypto.randomUUID(),
          },
        );
        expect(unsupported.status()).toBe(409);
        expect(((await unsupported.json()) as { error: { code: string } }).error.code).toBe(
          'source_bound_dossier_required',
        );
      }
      const prepared = await post(page, `/engagements/${assessment.engagementId}/closure/pramaan`, {
        dossierType: 'board_executive',
        reportId: draft.reportId,
        title: 'Retained board closure',
        operationKey: crypto.randomUUID(),
      });
      expect(prepared.status(), await prepared.text()).toBe(201);
      const dossierBuild = (await prepared.json()) as { dossierId: string; status: string };
      expect(dossierBuild.status).toBe('settled');
      const dossierResponse = await page.request.get(
        `/api/bff/v1/dossiers/${dossierBuild.dossierId}`,
        { headers: { 'x-tenant-id': tenantId } },
      );
      expect(dossierResponse.status()).toBe(200);
      const dossier = (await dossierResponse.json()) as {
        proofSealHash: string;
        archiveHash: string;
        archiveBytes: number;
      };
      expect(dossier.proofSealHash).toMatch(/^[0-9a-f]{64}$/);
      expect(dossier.archiveHash).toMatch(/^[0-9a-f]{64}$/);
      expect(dossier.archiveBytes).toBeGreaterThan(0);
      expect(
        (
          await post(page, `/dossiers/${dossierBuild.dossierId}/seal`, {
            expectedProofSeal: dossier.proofSealHash,
          })
        ).status(),
      ).toBe(403);
      const sealed = await post(founder, `/dossiers/${dossierBuild.dossierId}/seal`, {
        expectedProofSeal: dossier.proofSealHash,
      });
      expect(sealed.status()).toBe(200);
      const retained = await founder.request.get(
        `/api/bff/v1/dossiers/${dossierBuild.dossierId}/archive`,
        { headers: { 'x-tenant-id': tenantId } },
      );
      expect(retained.status()).toBe(200);
      expect(sha(Buffer.from(await retained.body()))).toBe(dossier.archiveHash);
      expect(retained.headers()['x-content-sha256']).toBe(dossier.archiveHash);
      expect(
        (
          await viewer.request.get(`/api/bff/v1/dossiers/${dossierBuild.dossierId}/archive`, {
            headers: { 'x-tenant-id': tenantId },
          })
        ).status(),
      ).toBe(403);
      const dispatch = await post(page, '/reports/email/dispatch', {
        dossierId: dossierBuild.dossierId,
        recipientEmail: 'audit@example.invalid',
      });
      expect(dispatch.status()).toBe(409);
      expect(((await dispatch.json()) as { error: { code: string } }).error.code).toBe(
        'source_bound_dispatch_required',
      );
      await page.goto('/reports?tab=pramaan');
      await expect(page.getByText('Source-bound closure dossiers')).toBeVisible();
      await providerAction('--pause-provider');
      try {
        expect(
          (await viewer.request.get(`/api/bff/v1/reports/board/${draft.reportId}/pdf`)).status(),
        ).toBe(503);
        expect(
          (
            await founder.request.get(`/api/bff/v1/dossiers/${dossierBuild.dossierId}/archive`, {
              headers: { 'x-tenant-id': tenantId },
            })
          ).status(),
        ).toBe(503);
      } finally {
        await providerAction('--resume-provider');
      }
      expect(
        (await viewer.request.get(`/api/bff/v1/reports/board/${draft.reportId}/pdf`)).status(),
      ).toBe(200);
    } finally {
      await founderContext.close();
      await viewerContext.close();
    }
  });

  test('live authority revocation denies cached review and private report reads', async ({
    page,
    browser,
  }) => {
    test.setTimeout(300_000);
    const manager = await createMfaAccount('board-revoked-manager', {
      role: 'admin',
      withFactor: true,
    });
    const founderAccount = await createMfaAccount('board-revoked-founder', {
      role: 'founder',
      isInternal: true,
      withFactor: true,
    });
    await signInAs(page, manager.email, manager.password, manager.totpSecret!);
    await selectTenant(page, 'a');
    const assessment = await finalizedAssessment(manager.id);
    const request = await boardRequest(page, assessment);
    const founderContext = await browser.newContext();
    try {
      const founder = await founderContext.newPage();
      await signInAs(founder, founderAccount.email, founderAccount.password);
      await selectTenant(founder, 'a');
      await satisfyLoginMfaWithSecret(founder, founderAccount.totpSecret!);
      const generated = await post(founder, `/reports/board/${request.requestId}/generate`, {});
      expect(generated.status()).toBe(200);
      const { reportId } = (await generated.json()) as { reportId: string };
      const report = await reportRow(reportId);
      const path = `/reports/${reportId}/review`;
      const body = { decision: 'approved', expectedContentHash: report.content_sha256 };
      const key = crypto.randomUUID();
      const review = () =>
        founder.request.post(`/api/bff/v1${path}`, {
          headers: { 'x-tenant-id': state.tenantA.id, 'idempotency-key': key },
          data: body,
        });
      expect((await review()).status()).toBe(200);
      await founder.goto('/reports');
      const detail = founder.getByRole('region', { name: 'Report detail' });
      await founder
        .getByRole('region', { name: 'Recorded reports' })
        .getByRole('button', { name: new RegExp(request.title) })
        .click();
      await expect(detail.getByRole('heading', { name: request.title, exact: true })).toBeVisible();
      await fixturePatch(`users?id=eq.${founderAccount.id}`, { is_axiom_internal: false });
      expect((await review()).status()).toBe(403);
      expect((await founder.request.get(`/api/bff/v1/reports/${reportId}`)).status()).toBe(404);
      await detail.getByRole('button', { name: 'Refresh report detail' }).click();
      await expect(detail.getByRole('alert')).toBeVisible();
      await expect(detail.getByRole('heading', { name: request.title, exact: true })).toHaveCount(
        0,
      );
      await fixturePatch(`tenant_users?tenant_id=eq.${state.tenantA.id}&user_id=eq.${manager.id}`, {
        role: 'viewer',
      });
      expect((await page.request.get(`/api/bff/v1/reports/${reportId}`)).status()).toBe(404);
    } finally {
      await founderContext.close();
    }
  });

  test('provider interruption leaves a pending build; founder explicitly retries missing versions', async ({
    page,
    browser,
  }) => {
    test.setTimeout(300_000);
    const ownerIdentity = await signInFreshOwner(page, 'board-reports-provider.spec-1');
    await selectTenant(page, 'a');
    const assessment = await finalizedAssessment(ownerIdentity.id);
    const request = await boardRequest(page, assessment);
    const context = await browser.newContext();
    try {
      const founder = await context.newPage();
      const account = await createMfaAccount('board-recovery-founder', {
        role: 'founder',
        isInternal: true,
        withFactor: true,
      });
      await signInAs(founder, account.email, account.password);
      await selectTenant(founder, 'a');
      await satisfyLoginMfaWithSecret(founder, account.totpSecret!);
      const generated = await post(founder, `/reports/board/${request.requestId}/generate`, {});
      expect(generated.status()).toBe(200);
      const { reportId } = (await generated.json()) as { reportId: string };
      const report = await reportRow(reportId);
      const reviewed = await post(founder, `/reports/${reportId}/review`, {
        decision: 'approved',
        expectedContentHash: report.content_sha256,
      });
      expect(((await reviewed.json()) as { data: { status: string } }).data.status).toBe(
        'approved',
      );
      const operationKey = crypto.randomUUID();
      await providerAction('--pause-provider');
      try {
        const pending = await post(founder, `/reports/board/${reportId}/artifacts`, {
          operationKey,
        });
        expect(pending.status()).toBe(202);
        expect(((await pending.json()) as { status: string }).status).toBe('pending');
      } finally {
        await providerAction('--resume-provider');
      }
      const reconcile = await post(founder, `/reports/board/${reportId}/artifacts/reconcile`, {
        operationKey,
      });
      expect(reconcile.status()).toBe(202);
      expect(((await reconcile.json()) as { status: string }).status).toBe('pending');
      expect(
        (await founder.request.get(`/api/bff/v1/reports/board/${reportId}/pdf`)).status(),
      ).toBe(409);
      const recovered = await post(founder, `/reports/board/${reportId}/artifacts/retry-missing`, {
        operationKey,
      });
      expect(recovered.status()).toBe(200);
      expect(((await recovered.json()) as { status: string }).status).toBe('settled');
      const replay = await post(founder, `/reports/board/${reportId}/artifacts`, { operationKey });
      const replayed = (await replay.json()) as { replayed: boolean; status: string };
      expect(replay.status(), JSON.stringify(replayed)).toBe(200);
      expect(replayed).toMatchObject({ replayed: true, status: 'settled' });
      expect(
        (await founder.request.get(`/api/bff/v1/reports/board/${reportId}/pdf`)).status(),
      ).toBe(200);
      // Only this journey's newly created identity is changed. A cached
      // settled build must not preserve founder authority after revocation.
      const revoke = await fetch(`${state.supabaseUrl}/rest/v1/users?id=eq.${account.id}`, {
        method: 'PATCH',
        redirect: 'error',
        signal: AbortSignal.timeout(30_000),
        headers: {
          apikey: state.publishableKey,
          authorization: `Bearer ${state.serviceKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ is_axiom_internal: false }),
      });
      expect(revoke.status).toBe(204);
      expect(
        (await post(founder, `/reports/board/${reportId}/artifacts`, { operationKey })).status(),
      ).toBe(403);
      expect(
        (await founder.request.get(`/api/bff/v1/reports/board/${reportId}/pdf`)).status(),
      ).toBe(403);
    } finally {
      await context.close();
    }
  });

  test('manager and founder complete the board workflow in the browser', async ({
    page,
    browser,
  }) => {
    test.setTimeout(300_000);
    const manager = await createMfaAccount('board-browser-manager', {
      role: 'admin',
      withFactor: true,
    });
    await signInAs(page, manager.email, manager.password, manager.totpSecret!);
    await selectTenant(page, 'a');
    const unsafeText = '<img src=x onerror=alert(1)>';
    const assessment = await finalizedAssessment(manager.id, unsafeText);
    await page.goto('/reports');
    const workflow = page.getByRole('region', { name: 'Board report workflow' });
    const requestForm = workflow.getByRole('form', { name: 'Request board report' });
    await expect(requestForm.locator(`option[value="${assessment.runId}"]`)).toHaveCount(1);
    await requestForm.getByLabel('Assessment', { exact: true }).selectOption(assessment.runId, {
      timeout: 15_000,
    });
    const title = `Browser board ${crypto.randomUUID()}`;
    await requestForm.getByLabel('Report title').fill(title);
    await requestForm
      .getByRole('checkbox', {
        name: 'I request a draft bound to this finalized assessment and its recorded control library.',
      })
      .check();
    await requestForm.getByRole('button', { name: 'Request board draft' }).click();
    await expect(workflow.getByRole('button', { name: new RegExp(title) })).toBeVisible();
    const founderContext = await browser.newContext();
    try {
      const founder = await founderContext.newPage();
      const account = await createMfaAccount('board-browser-founder', {
        role: 'founder',
        isInternal: true,
        withFactor: true,
      });
      await signInAs(founder, account.email, account.password);
      await selectTenant(founder, 'a');
      await satisfyLoginMfaWithSecret(founder, account.totpSecret!);
      await founder.goto('/reports');
      const board = founder.getByRole('region', { name: 'Board report workflow' });
      await board.getByRole('button', { name: new RegExp(title) }).click();
      const selected = founder.locator('[aria-label="Selected board request"]');
      await selected.getByRole('button', { name: 'Generate source-bound draft' }).click();
      await expect(selected.getByRole('button', { name: 'Open report for review' })).toBeVisible();
      await selected.getByRole('button', { name: 'Open report for review' }).click();
      const detail = founder.getByRole('region', { name: 'Report detail' });
      await expect(detail.getByRole('heading', { name: title, exact: true })).toBeVisible();
      await detail.getByText('Exact recorded content', { exact: true }).click();
      await expect(detail.locator('pre')).toContainText(unsafeText);
      await expect(detail.locator('img')).toHaveCount(0);
      await expect(detail.getByRole('button', { name: /Email/ })).toHaveCount(0);
      await detail
        .getByRole('checkbox', {
          name: 'I reviewed the exact content and SHA-256 shown above.',
        })
        .check();
      // The raw draft contains approved_by:null, so a broad text check can pass
      // before review commits. Hold the real POST to prove draft is not readiness.
      let releaseReview = () => {};
      let reviewStarted = () => {};
      const reviewGate = new Promise<void>((resolve) => {
        releaseReview = resolve;
      });
      const started = new Promise<void>((resolve) => {
        reviewStarted = resolve;
      });
      const reviewPath = /\/api\/bff\/v1\/reports\/[0-9a-f-]{36}\/review$/;
      await founder.route(reviewPath, async (route) => {
        reviewStarted();
        await reviewGate;
        await route.continue();
      });
      const reviewedResponse = founder.waitForResponse(
        (response) =>
          reviewPath.test(new URL(response.url()).pathname) &&
          response.request().method() === 'POST',
      );
      try {
        await detail.getByRole('button', { name: 'Approve reviewed content' }).click();
        await started;
        await expect(detail.getByText(/^draft · [^·]+ · Library /)).toBeVisible();
        await expect(detail.getByText(/^approved · [^·]+ · Library /)).toHaveCount(0);
      } finally {
        releaseReview();
      }
      const reviewed = await reviewedResponse;
      expect(reviewed.status()).toBe(200);
      expect(((await reviewed.json()) as { data: { status: string } }).data.status).toBe(
        'approved',
      );
      await expect(detail.getByText(/^approved · [^·]+ · Library /)).toBeVisible();
      await founder.unroute(reviewPath);
      await board.getByRole('button', { name: 'Refresh board state' }).click();
      await expect(
        selected.getByRole('button', {
          name: 'Build and retain reviewed source and PDF',
        }),
      ).toBeVisible();
      await selected
        .getByRole('button', {
          name: 'Build and retain reviewed source and PDF',
        })
        .click();
      await expect(selected).toContainText('Retained artifact build: settled', { timeout: 90_000 });
      const preview = selected.getByRole('link', { name: 'Preview retained PDF' });
      await expect(preview).toBeVisible();
      const path = await preview.getAttribute('href');
      expect(path).toMatch(/^\/api\/bff\/v1\/reports\/board\/[0-9a-f-]{36}\/pdf$/);
      const privatePdf = await founder.request.get(path!);
      expect(privatePdf.status()).toBe(200);
      expect(
        Buffer.from(await privatePdf.body())
          .subarray(0, 5)
          .toString(),
      ).toBe('%PDF-');
      await selected
        .getByRole('checkbox', {
          name: 'I reviewed the exact content and retained PDF hash and authorize tenant release.',
        })
        .check();
      await selected.getByRole('button', { name: 'Release retained board report' }).click();
      await expect(selected).toContainText('Report status: published');
      await board.getByRole('button', { name: 'Refresh board state' }).click();
      await expect(selected.getByRole('link', { name: 'Preview retained PDF' })).toBeVisible();
    } finally {
      await founderContext.close();
    }
  });

  test('auditor pack and Pramaan dossier bind frozen findings, founder review and retained versions', async ({
    page,
    browser,
  }) => {
    test.setTimeout(300_000);
    const manager = await createMfaAccount('auditor-manager', { role: 'admin', withFactor: true });
    await signInAs(page, manager.email, manager.password, manager.totpSecret!);
    await selectTenant(page, 'a');
    const assessment = await finalizedAssessment(manager.id);
    const requestBody = {
      engagementId: assessment.engagementId,
      assessmentRunId: assessment.runId,
      title: `Assessment review ${crypto.randomUUID()}`,
      operationKey: crypto.randomUUID(),
    };
    expect(
      (
        await post(page, '/reports/statutory/auditor/requests', {
          ...requestBody,
          content: { auditor_attestation: 'invented' },
        })
      ).status(),
    ).toBe(400);
    const requested = await post(page, '/reports/statutory/auditor/requests', requestBody);
    expect(requested.status()).toBe(201);
    const request = (await requested.json()) as { requestId: string; replayed: boolean };
    expect(request.replayed).toBe(false);
    const replay = await post(page, '/reports/statutory/auditor/requests', requestBody);
    expect(((await replay.json()) as { requestId: string }).requestId).toBe(request.requestId);
    expect(
      (
        await post(page, `/reports/statutory/auditor/requests/${request.requestId}/draft`, {})
      ).status(),
    ).toBe(403);
    const founderContext = await browser.newContext();
    const viewerContext = await browser.newContext();
    try {
      const founder = await founderContext.newPage();
      const founderAccount = await createMfaAccount('auditor-provider-founder', {
        role: 'founder',
        isInternal: true,
        withFactor: true,
      });
      await signInAs(founder, founderAccount.email, founderAccount.password);
      await selectTenant(founder, 'a');
      await satisfyLoginMfaWithSecret(founder, founderAccount.totpSecret!);
      const generated = await post(
        founder,
        `/reports/statutory/auditor/requests/${request.requestId}/draft`,
        {},
      );
      expect(generated.status()).toBe(201);
      const draft = (await generated.json()) as { reportId: string };
      const row = await reportRow(draft.reportId);
      expect(sha(row.content_text)).toBe(row.content_sha256);
      const content = JSON.parse(row.content_text) as {
        schema_version: number;
        source_kind: string;
        findings: Array<{ risk_points: number }>;
        limitations: string;
      };
      expect(content.schema_version).toBe(2);
      expect(content.source_kind).toBe('finalized_assessment');
      expect(content.findings).toHaveLength(1);
      expect(content.findings[0]?.risk_points).toBe(10);
      expect(content.limitations).toContain('No independent audit');
      expect(row.content_text).not.toContain('auditor_attestation');
      expect(
        (await founder.request.get(`/api/bff/v1/reports/statutory/${draft.reportId}/pdf`)).status(),
      ).toBe(409);
      const reviewed = await post(founder, `/reports/${draft.reportId}/review`, {
        decision: 'approved',
        expectedContentHash: row.content_sha256,
      });
      expect(reviewed.status()).toBe(200);
      const built = await post(founder, `/reports/statutory/${draft.reportId}/artifacts`, {
        operationKey: crypto.randomUUID(),
      });
      expect(built.status()).toBe(200);
      const build = (await built.json()) as { buildId: string; status: string };
      expect(build.status).toBe('settled');
      const versions = (await database(
        `statutory_artifact_versions?build_id=eq.${build.buildId}&select=*&order=artifact_kind.asc`,
      )) as Array<{
        artifact_kind: string;
        bucket: string;
        object_key: string;
        version_id: string;
        content_hash: string;
        byte_size: number;
        retain_until: string;
      }>;
      expect(versions.map((item) => item.artifact_kind)).toEqual(['source_json', 'statutory_pdf']);
      const sources = (await database(
        `statutory_request_sources?request_id=eq.${request.requestId}&select=source_text,source_sha256`,
      )) as Array<{ source_text: string; source_sha256: string }>;
      expect(versions[0]?.content_hash).toBe(sources[0]?.source_sha256);
      const config = localFixture();
      const vault = new EvidenceVault('ap-south-1', config.endpoint, config);
      try {
        for (const version of versions) {
          const exact = await vault.retrieve(
            version.bucket,
            version.object_key,
            version.version_id,
            { maxBytes: 32 * 1024 * 1024, timeoutMs: 30_000 },
          );
          expect(exact.body.length).toBe(version.byte_size);
          expect(sha(exact.body)).toBe(version.content_hash);
          if (version.artifact_kind === 'source_json')
            expect(exact.body.toString('utf8')).toBe(sources[0]?.source_text);
          else expect(exact.body.subarray(0, 5).toString()).toBe('%PDF-');
          expect(new Date(version.retain_until).getTime()).toBeGreaterThan(
            Date.now() + 6 * 365 * 86400_000,
          );
        }
      } finally {
        vault.close();
      }
      const viewer = await viewerContext.newPage();
      await signIn(viewer, 'viewer');
      await selectTenant(viewer, 'a');
      expect(
        (await viewer.request.get(`/api/bff/v1/reports/statutory/${draft.reportId}/pdf`)).status(),
      ).toBe(403);
      const wrong = await post(founder, `/reports/${draft.reportId}/release`, {
        expectedContentHash: row.content_sha256,
        expectedArchiveHash: 'f'.repeat(64),
      });
      expect(wrong.status()).toBe(409);
      const released = await post(founder, `/reports/${draft.reportId}/release`, {
        expectedContentHash: row.content_sha256,
        expectedArchiveHash: versions[1]!.content_hash,
      });
      expect(released.status()).toBe(200);
      const publicPdf = await viewer.request.get(
        `/api/bff/v1/reports/statutory/${draft.reportId}/pdf`,
      );
      expect(publicPdf.status()).toBe(200);
      expect(sha(Buffer.from(await publicPdf.body()))).toBe(versions[1]!.content_hash);
      const dossierOperation = crypto.randomUUID();
      const wrongDossier = await post(
        page,
        `/engagements/${assessment.engagementId}/closure/pramaan`,
        {
          dossierType: 'auditor_assurance',
          reportId: crypto.randomUUID(),
          title: 'Unbound auditor assurance',
          operationKey: crypto.randomUUID(),
        },
      );
      expect(wrongDossier.status()).toBe(409);
      const prepared = await post(page, `/engagements/${assessment.engagementId}/closure/pramaan`, {
        dossierType: 'auditor_assurance',
        reportId: draft.reportId,
        title: 'Assessment-derived auditor dossier',
        operationKey: dossierOperation,
      });
      expect(prepared.status(), await prepared.text()).toBe(201);
      const dossierBuild = (await prepared.json()) as { dossierId: string; status: string };
      expect(dossierBuild.status).toBe('settled');
      const detailResponse = await founder.request.get(
        `/api/bff/v1/dossiers/${dossierBuild.dossierId}`,
        {
          headers: { 'x-tenant-id': state.tenantA.id },
        },
      );
      expect(detailResponse.status()).toBe(200);
      const dossier = (await detailResponse.json()) as {
        dossierType: string;
        proofSealHash: string;
        archiveHash: string;
        sourceBound: boolean;
        archiveVersionId: string;
      };
      expect(dossier).toMatchObject({ dossierType: 'auditor_assurance', sourceBound: true });
      expect(dossier.archiveVersionId).toBeTruthy();
      const managerSeal = await post(page, `/dossiers/${dossierBuild.dossierId}/seal`, {
        expectedProofSeal: dossier.proofSealHash,
      });
      expect(managerSeal.status()).toBe(403);
      const sealed = await post(founder, `/dossiers/${dossierBuild.dossierId}/seal`, {
        expectedProofSeal: dossier.proofSealHash,
      });
      expect(sealed.status()).toBe(200);
      const archiveResponse = await founder.request.get(
        `/api/bff/v1/dossiers/${dossierBuild.dossierId}/archive`,
        {
          headers: { 'x-tenant-id': state.tenantA.id },
        },
      );
      expect(archiveResponse.status()).toBe(200);
      const archiveBytes = Buffer.from(await archiveResponse.body());
      expect(sha(archiveBytes)).toBe(dossier.archiveHash);
      const archiveRows = (await database(
        `pramaan_auditor_archives?dossier_id=eq.${dossierBuild.dossierId}&select=*`,
      )) as Array<{
        bucket: string;
        object_key: string;
        version_id: string;
        content_hash: string;
        byte_size: number;
        retain_until: string;
        lock_mode: string;
      }>;
      expect(archiveRows).toHaveLength(1);
      expect(archiveRows[0]!.version_id).toBe(dossier.archiveVersionId);
      expect(archiveRows[0]!.lock_mode).toBe('COMPLIANCE');
      const archiveVault = new EvidenceVault('ap-south-1', config.endpoint, config);
      try {
        const exact = await archiveVault.retrieve(
          archiveRows[0]!.bucket,
          archiveRows[0]!.object_key,
          archiveRows[0]!.version_id,
          { maxBytes: 64 * 1024 * 1024, timeoutMs: 30_000 },
        );
        expect(exact.body.length).toBe(archiveRows[0]!.byte_size);
        expect(sha(exact.body)).toBe(archiveRows[0]!.content_hash);
        expect(exact.body).toEqual(archiveBytes);
        expect(new Date(archiveRows[0]!.retain_until).getTime()).toBeGreaterThan(
          Date.now() + 6 * 365 * 86400_000,
        );
      } finally {
        archiveVault.close();
      }
      const files = unzipSync(archiveBytes);
      expect(Buffer.from(files['source/assessment.json']!).toString()).toBe(
        sources[0]!.source_text,
      );
      expect(sha(Buffer.from(files['source/auditor-review-pack.pdf']!))).toBe(
        versions[1]!.content_hash,
      );
      const manifest = JSON.parse(Buffer.from(files['manifest.json']!).toString()) as {
        kind: string;
        limitations: string[];
      };
      expect(manifest.kind).toBe('pramaan_auditor_assurance_source_archive');
      expect(manifest.limitations.join(' ')).toContain('not an independent audit');
      expect(
        (
          await viewer.request.get(`/api/bff/v1/dossiers/${dossierBuild.dossierId}/archive`, {
            headers: { 'x-tenant-id': state.tenantA.id },
          })
        ).status(),
      ).toBe(403);
      await founder.goto('/reports?tab=pramaan');
      await expect(founder.getByText('Source-bound closure dossiers')).toBeVisible();
      await expect(
        founder.locator('#pramaan-report option').filter({ hasText: requestBody.title }),
      ).toHaveCount(1);
    } finally {
      await founderContext.close();
      await viewerContext.close();
    }
  });
});
