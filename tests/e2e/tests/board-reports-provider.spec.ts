import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { test, expect, type Page } from '@playwright/test';
import {
  createMfaAccount,
  selectTenant,
  signIn,
  signInAs,
  satisfyLoginMfaWithSecret,
  state,
} from '../fixtures';
import { acceptanceTarget, repoRoot } from '../target';
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

async function database(path: string, body?: unknown) {
  const response = await fetch(`${state.supabaseUrl}/rest/v1/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
    headers: {
      apikey: state.publishableKey,
      authorization: `Bearer ${state.serviceKey}`,
      'content-type': 'application/json',
      Prefer: 'return=representation',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`Board fixture ${path}: HTTP ${response.status}`);
  return response.json() as Promise<unknown>;
}

async function rpc<T>(name: string, args: Record<string, unknown>): Promise<T> {
  const result = (await database(`rpc/${name}`, args)) as T & { error?: string };
  if (result.error) throw new Error(`${name}: ${result.error}`);
  return result;
}

/** Only source setup is inserted. Assessment, receipts and report state use their sanctioned RPCs. */
async function finalizedAssessment(actorId: string) {
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
    registration = (await rpc<{ version: number; status: string }>('manage_workload_identity', {
      p_tenant_id: state.tenantA.id,
      p_actor_id: actorId,
      p_correlation_id: crypto.randomUUID(),
      p_workload_id: workloadId,
      p_expected_version: 0,
      p_agent: 'parikshan',
      p_spiffe_id: spiffeId,
      p_status: 'disabled',
    })) as { id: string; version: number; status: string };
  }
  if (registration.status !== 'active') {
    const activation = await rpc<{ status: string }>('manage_workload_identity', {
      p_tenant_id: state.tenantA.id,
      p_actor_id: actorId,
      p_correlation_id: crypto.randomUUID(),
      p_workload_id: workloadId,
      p_expected_version: registration.version,
      p_agent: 'parikshan',
      p_spiffe_id: spiffeId,
      p_status: 'active',
    });
    expect(activation.status).toBe('active');
  }
  const proofHash = sha(`board-proof-${suffix}`);
  const inputHash = sha(`board-input-${suffix}`);
  const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
  const issued = await rpc<{ run_id: string }>('delegate_workload_task', {
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
  });
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
        rationale: 'Synthetic board acceptance finding',
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

async function post(page: Page, path: string, body: unknown) {
  return page.request.post(`/api/bff/v1${path}`, {
    headers: { 'x-tenant-id': state.tenantA.id, 'idempotency-key': crypto.randomUUID() },
    data: body,
  });
}

async function boardRequest(
  page: Page,
  assessment: Awaited<ReturnType<typeof finalizedAssessment>>,
) {
  const title = `Provider board ${crypto.randomUUID()}`;
  const body = {
    engagementId: assessment.engagementId,
    assessmentRunId: assessment.runId,
    title,
    operationKey: crypto.randomUUID(),
  };
  const requested = await post(page, '/reports/board/request', body);
  expect(requested.status()).toBe(201);
  const request = (await requested.json()) as { requestId: string; replayed: boolean };
  expect(request.replayed).toBe(false);
  const repeated = await post(page, '/reports/board/request', body);
  expect(repeated.status()).toBe(201);
  expect(((await repeated.json()) as typeof request).requestId).toBe(request.requestId);
  return { ...request, title };
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
    const manager = await createMfaAccount('board-manager', { role: 'admin' });
    await signInAs(page, manager.email, manager.password);
    await selectTenant(page, 'a');
    const assessment = await finalizedAssessment(manager.id);
    const request = await boardRequest(page, assessment);
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
      await selectTenant(founder, 'a');
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
      const reviewed = await post(founder, `/reports/${draft.reportId}/review`, {
        decision: 'approved',
        expectedContentHash: row.content_sha256,
      });
      expect(reviewed.status()).toBe(200);
      expect(((await reviewed.json()) as { data: { status: string } }).data.status).toBe(
        'approved',
      );
      const operationKey = crypto.randomUUID();
      const built = await post(founder, `/reports/board/${draft.reportId}/artifacts`, {
        operationKey,
      });
      const buildError =
        built.status() === 200
          ? undefined
          : ((await built.json()) as { error?: { code?: string } }).error?.code;
      expect(built.status(), buildError ?? 'board artifact build failed').toBe(200);
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
      expect(sha(Buffer.from(await privatePdf.body()))).toBe(pdfVersion.content_hash);
      const viewer = await viewerContext.newPage();
      await signIn(viewer, 'viewer');
      await selectTenant(viewer, 'a');
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
        { headers: { 'x-tenant-id': state.tenantA.id } },
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
        { headers: { 'x-tenant-id': state.tenantA.id } },
      );
      expect(retained.status()).toBe(200);
      expect(sha(Buffer.from(await retained.body()))).toBe(dossier.archiveHash);
      expect(retained.headers()['x-content-sha256']).toBe(dossier.archiveHash);
      expect(
        (
          await viewer.request.get(`/api/bff/v1/dossiers/${dossierBuild.dossierId}/archive`, {
            headers: { 'x-tenant-id': state.tenantA.id },
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
              headers: { 'x-tenant-id': state.tenantA.id },
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

  test('provider interruption leaves a pending build; founder explicitly retries missing versions', async ({
    page,
    browser,
  }) => {
    test.setTimeout(300_000);
    await signIn(page, 'owner');
    await selectTenant(page, 'a');
    const assessment = await finalizedAssessment(state.accounts.owner.id);
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
    const manager = await createMfaAccount('board-browser-manager', { role: 'admin' });
    await signInAs(page, manager.email, manager.password);
    await selectTenant(page, 'a');
    const assessment = await finalizedAssessment(manager.id);
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
      await detail
        .getByRole('checkbox', {
          name: 'I reviewed the exact content and SHA-256 shown above.',
        })
        .check();
      await detail.getByRole('button', { name: 'Approve reviewed content' }).click();
      await expect(detail).toContainText('approved');
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
    const manager = await createMfaAccount('auditor-manager', { role: 'admin' });
    await signInAs(page, manager.email, manager.password);
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
