/** Opt-in owned demo fixture. Every mutation below uses the actual product UI
 * and normal Auth/MFA; only public network bytes and KMS/storage are fixtures. */
import { expect, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { signInAs, state } from '../fixtures';
import { tenantCookie } from '../target';
import {
  type RegisteredBrowserConfig,
  writeRegisteredBrowserFile,
  validateRegisteredSubmission,
} from '../../../scripts/lib/acceptance-public-asset-browser';
import {
  publicWebsiteAssetOperationSchema,
  recordedPublicSourceBindingSchema,
  publicAgentObservationSchema,
  parsePublicWebsiteAssetSnapshotText,
  publicControlReviewSetAnyRowSchema,
  publicControlReviewSetAnySnapshotSchema,
  publicControlAssessmentV2Schema,
  AssessmentRequestReceiptSchema,
} from '../../../packages/types/src/index';

const operationPath = '/api/bff/v1/public-website-assets/operations';
export async function registeredWebsiteSourceInBrowser(
  page: Page,
  config: RegisteredBrowserConfig,
  directory: string,
) {
  expect(state.supabaseUrl.replace(/\/$/, '')).toBe(config.apiOrigin);
  await signInAs(page, config.email, config.password, config.loginSecret);
  await page.context().addCookies([tenantCookie(config.tenantSlug)]);
  await page.goto('/connectors');
  const console = page.getByRole('region', { name: 'Registered public website targets' });
  await expect(console).toBeVisible();
  await console.getByLabel('Estate', { exact: true }).selectOption(config.estateId);
  await console.getByLabel('System', { exact: true }).selectOption(config.systemId);
  await console.getByLabel('Public HTTPS website URL').fill(config.publicUrl);
  await console
    .getByLabel('I reviewed this selected context and authorize this exact metadata operation.')
    .check();
  const registered = page.waitForResponse(
    (r) => new URL(r.url()).pathname === operationPath && r.request().method() === 'POST',
  );
  await console
    .getByRole('button', { name: 'Record selected website operation', exact: true })
    .click();
  const registration = await registered;
  expect(registration.status()).toBe(201);
  const target = publicWebsiteAssetOperationSchema.parse((await registration.json()).data);
  const targetSnapshot = parsePublicWebsiteAssetSnapshotText(target.snapshotText);
  expect(targetSnapshot.kind).toBe('target');
  expect(target.tenantId).toBe(config.tenantId);
  expect(target.actorId).toBe(config.actorId);
  if (targetSnapshot.kind !== 'target') throw new Error('Owned target receipt refused');
  expect(targetSnapshot.url).toBe(config.publicUrl);
  expect(targetSnapshot.estateId).toBe(config.estateId);
  expect(targetSnapshot.systemId).toBe(config.systemId);
  const foreign = await page.request.get(operationPath + '/' + target.operationKey, {
    headers: { 'X-Tenant-Id': state.tenantB.id },
  });
  expect([403, 404]).toContain(foreign.status());
  expect((await foreign.text()).includes(target.snapshotText)).toBe(false);

  await console.getByLabel('Operation', { exact: true }).selectOption('capture');
  await console
    .getByLabel('Registered public target', { exact: true })
    .selectOption(targetSnapshot.id);
  await console
    .getByLabel('I reviewed this selected context and authorize this exact metadata operation.')
    .check();
  let committed: z.infer<typeof publicWebsiteAssetOperationSchema> | undefined;
  let firstBody = '';
  let firstHeaders: Record<string, string> = {};
  // Lose ONLY the browser response after the real server has committed the
  // source and association. No fabricated receipt, intercepted SQL or Auth.
  await page.route('**' + operationPath, async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    firstBody = route.request().postData() ?? '';
    firstHeaders = route.request().headers();
    expect(firstHeaders['x-tenant-id']).toBe(config.tenantId);
    expect(firstHeaders['x-expected-actor-id']).toBe(config.actorId);
    const response = await route.fetch();
    expect(response.status()).toBe(201);
    committed = publicWebsiteAssetOperationSchema.parse((await response.json()).data);
    await route.abort('failed');
  });
  await console
    .getByRole('button', { name: 'Record selected website operation', exact: true })
    .click();
  const retained = console.getByRole('article');
  await expect(retained).toHaveCount(1);
  await expect(retained).toContainText('unconfirmed');
  await expect.poll(() => Boolean(committed)).toBe(true);
  await expect
    .poll(() =>
      page.evaluate(() =>
        Object.values(localStorage)
          .map((raw) => {
            try {
              return JSON.parse(raw).requestText ?? '';
            } catch {
              return '';
            }
          })
          .join('\n'),
      ),
    )
    .toContain(firstBody);
  await page.unroute('**' + operationPath);
  let automatic = 0;
  const count = (request: import('@playwright/test').Request) => {
    if (new URL(request.url()).pathname === operationPath && request.method() === 'POST')
      automatic++;
  };
  page.on('request', count);
  await page.reload();
  const restored = page.getByRole('article', { name: /^Retained website operation / });
  await expect(restored).toHaveCount(1);
  await expect(restored).toContainText(firstBody);
  await expect(
    restored.getByRole('button', { name: 'Retry exact retained request', exact: true }),
  ).toBeDisabled();
  expect(automatic).toBe(0);
  await restored
    .getByLabel('I reviewed this exact retained request and authorize its retry.')
    .check();
  const replayResponse = page.waitForResponse(
    (r) => new URL(r.url()).pathname === operationPath && r.request().method() === 'POST',
  );
  await restored.getByRole('button', { name: 'Retry exact retained request', exact: true }).click();
  const replay = await replayResponse;
  expect(replay.status()).toBe(200);
  expect(replay.request().postData()).toBe(firstBody);
  expect(replay.request().headers()['idempotency-key']).toBe(firstHeaders['idempotency-key']);
  expect(replay.request().headers()['x-tenant-id']).toBe(firstHeaders['x-tenant-id']);
  expect(replay.request().headers()['x-expected-actor-id']).toBe(
    firstHeaders['x-expected-actor-id'],
  );
  const association = publicWebsiteAssetOperationSchema.parse((await replay.json()).data);
  expect({ ...association, replayed: false }).toEqual(committed);
  expect(association.replayed).toBe(true);
  await expect(restored).toHaveCount(0);
  page.off('request', count);
  const associationSnapshot = parsePublicWebsiteAssetSnapshotText(association.snapshotText);
  if (associationSnapshot.kind !== 'association')
    throw new Error('Owned association receipt refused');
  expect(associationSnapshot.targetId).toBe(targetSnapshot.id);
  expect(associationSnapshot.targetSha256).toBe(target.snapshotSha256);
  await page.getByRole('link', { name: 'Continue this saved check in Discovery' }).click();
  await page.getByLabel('Engagement', { exact: true }).selectOption(config.engagementId);
  await expect(page.getByLabel('Saved public website check', { exact: true })).toHaveValue(
    associationSnapshot.checkId,
  );
  const workflow = page.getByRole('region', { name: 'Public website agent workflow', exact: true });
  await workflow.getByRole('button', { name: 'Preview saved source', exact: true }).click();
  await expect(
    workflow.getByRole('button', { name: 'Record source binding', exact: true }),
  ).toBeEnabled();
  const bindingResponse = page.waitForResponse(
    (r) =>
      new URL(r.url()).pathname === '/api/bff/v1/public-source-bindings' &&
      r.request().method() === 'POST',
  );
  await workflow.getByRole('button', { name: 'Record source binding', exact: true }).click();
  const bindingSaved = await bindingResponse;
  expect(bindingSaved.status()).toBe(201);
  const binding = recordedPublicSourceBindingSchema.parse((await bindingSaved.json()).data);
  expect(binding.runtime_binding.tenant_id).toBe(config.tenantId);
  expect(binding.runtime_binding.check_id).toBe(associationSnapshot.checkId);
  const drishtiResponse = page.waitForResponse(
    (r) =>
      new URL(r.url()).pathname.endsWith('/agents/drishti/run') && r.request().method() === 'POST',
  );
  await workflow.getByRole('button', { name: 'Run Drishti on saved source', exact: true }).click();
  const drishtiSaved = await drishtiResponse;
  expect(drishtiSaved.status()).toBe(201);
  const drishti = publicAgentObservationSchema.parse((await drishtiSaved.json()).data);
  if (drishti.agent !== 'drishti') throw new Error('Actual Drishti output refused');
  expect(drishti.binding_id).toBe(binding.binding_id);
  expect(drishti.output.observation.private_facts).toEqual({
    hosting_region: 'unknown',
    backend_personal_data: 'unknown',
    cross_border_processing: 'unknown',
  });
  expect(drishti.output.observation.pages).toHaveLength(4);
  expect(drishti.output.observation.pages.find((p) => p.page === 'privacy')?.form_state).toBe(
    'observed',
  );
  expect(
    drishti.output.observation.pages.find((p) => p.page === 'privacy')?.form_metadata?.forms,
  ).toHaveLength(0);
  await expect(
    workflow.getByRole('heading', { name: 'Drishti public observation', exact: true }),
  ).toBeVisible();
  await expect(workflow).toContainText('Private hosting: unknown');
  await workflow.getByRole('button', { name: 'Select Drishti observation', exact: true }).click();
  await expect(workflow).toContainText('Selected Drishti observation: ' + drishti.observation_id);
  const vibhaagResponse = page.waitForResponse(
    (r) =>
      new URL(r.url()).pathname.endsWith('/agents/vibhaag/run') && r.request().method() === 'POST',
  );
  await workflow
    .getByRole('button', { name: 'Run Vibhaag on selected observation', exact: true })
    .click();
  const vibhaagSaved = await vibhaagResponse;
  expect(vibhaagSaved.status()).toBe(201);
  const vibhaag = publicAgentObservationSchema.parse((await vibhaagSaved.json()).data);
  if (vibhaag.agent !== 'vibhaag') throw new Error('Actual Vibhaag output refused');
  expect(vibhaag.binding_id).toBe(binding.binding_id);
  expect(vibhaag.output.indicators).toHaveLength(1);
  expect(vibhaag.output.indicators[0]).toMatchObject({
    page: 'contact',
    input_type: 'email',
    indicator: 'potential_contact_collection',
    requires_human_review: true,
  });
  expect(vibhaag.output.private_facts).toEqual({
    hosting_region: 'unknown',
    backend_personal_data: 'unknown',
    cross_border_processing: 'unknown',
  });
  await expect(
    workflow.getByRole('heading', { name: 'Vibhaag structural indicators', exact: true }),
  ).toBeVisible();
  const reviewResponse = page.waitForResponse(
    (r) => new URL(r.url()).pathname.endsWith('/control-review') && r.request().method() === 'GET',
  );
  await page
    .getByRole('button', { name: 'Review website against DPDPA controls', exact: true })
    .click();
  const evidenceResponse = await reviewResponse;
  expect(evidenceResponse.status()).toBe(200);
  const evidence = publicControlAssessmentV2Schema.parse(
    (await evidenceResponse.json()).data.assessment,
  );
  const evidenceUi = page.getByRole('region', { name: 'Website source control review' });
  await expect(evidenceUi).toContainText('Human review required');
  await expect(evidenceUi).toContainText('not a separately recorded agent assessment');
  expect(evidence.source.pages).toHaveLength(5);
  await expect(evidenceUi).toContainText('No whole-site crawl');
  for (const pageKind of ['privacy', 'terms', 'contact', 'consent']) {
    expect(evidence.source.pages.some((p) => p.page === pageKind && p.state === 'examined')).toBe(
      true,
    );
    await expect(evidenceUi.getByRole('region', { name: 'Public page coverage' })).toContainText(
      pageKind,
      { ignoreCase: true },
    );
    const candidates = evidence.source.candidates.filter((c) => c.locator.page === pageKind);
    expect(candidates.length).toBeGreaterThan(0);
    expect(
      evidence.controls.some((c) =>
        c.questions.some((q) =>
          q.evidence.candidateOrdinals.some((n) =>
            candidates.some((candidate) => candidate.ordinal === n),
          ),
        ),
      ),
    ).toBe(true);
  }
  await expect(
    evidenceUi.getByRole('region', { name: 'DPDPA control evidence coverage' }).locator('details'),
  ).toHaveCount(46);
  const human = page.getByRole('region', { name: 'Human control review' });
  const selection = human.getByRole('region', { name: 'Website association for human review' });
  await selection.getByLabel('Website review system').selectOption(config.systemId);
  await selection
    .getByRole('button', { name: 'Load registered review targets', exact: true })
    .click();
  await selection
    .getByLabel('Registered review target', { exact: true })
    .selectOption(targetSnapshot.id);
  await selection
    .getByRole('button', { name: 'Load saved review associations', exact: true })
    .click();
  await selection
    .getByLabel('Saved review association', { exact: true })
    .selectOption(associationSnapshot.id);
  await selection
    .getByLabel('I confirm this exact saved target, check and association for a new human review.')
    .check();
  await human.getByLabel('Control to review', { exact: true }).selectOption('DPDPA-GOV-001');
  await human.getByLabel('Control question', { exact: true }).selectOption('Q1');
  await human.getByLabel('Human declaration', { exact: true }).selectOption('yes');
  await human
    .getByLabel('Judgment rationale', { exact: true })
    .fill(
      'Synthetic human declaration only; public statements do not prove internal implementation.',
    );
  await human.getByRole('button', { name: 'Add judgment to review draft', exact: true }).click();
  await human
    .getByLabel('Applicability rationale', { exact: true })
    .fill('Synthetic reviewer has no internal evidence of conditional applicability.');
  await human.getByLabel(/I reviewed these declarations and authorise recording/).check();
  const humanResponse = page.waitForResponse(
    (r) =>
      new URL(r.url()).pathname === '/api/bff/v1/public-control-review-sets' &&
      r.request().method() === 'POST',
  );
  await human.getByRole('button', { name: 'Record human control review', exact: true }).click();
  const humanSaved = await humanResponse;
  expect(humanSaved.status()).toBe(201);
  const review = publicControlReviewSetAnyRowSchema
    .safeExtend({ snapshot: publicControlReviewSetAnySnapshotSchema })
    .parse((await humanSaved.json()).data.review);
  expect(review.snapshot.version).toBe(2);
  expect(review.snapshot.request.version).toBe(2);
  if (review.snapshot.request.version !== 2) throw new Error('Registered review downgrade refused');
  expect(review.snapshot.request.associationRef.associationId).toBe(associationSnapshot.id);
  expect(review.snapshot.normalizedAnswers['DPDPA-GOV-001']?.Q1).toBe(true);
  await human
    .getByRole('link', { name: 'Request assessment from this recorded human review', exact: true })
    .click();
  let submissions = 0;
  page.on('request', (r) => {
    if (new URL(r.url()).pathname === '/api/bff/v1/assessment/jobs' && r.method() === 'POST')
      submissions++;
  });
  const panel = page.getByRole('region', { name: 'Request a saved assessment' });
  await expect(panel).toContainText(review.id);
  expect(submissions).toBe(0);
  await panel.getByLabel(/I request Parikshan using this exact recorded human review/).check();
  const requestResponse = page.waitForResponse(
    (r) =>
      new URL(r.url()).pathname === '/api/bff/v1/assessment/jobs' &&
      r.request().method() === 'POST',
  );
  await panel
    .getByRole('button', { name: 'Request assessment from recorded review', exact: true })
    .click();
  const acceptedResponse = await requestResponse;
  expect(acceptedResponse.status()).toBe(202);
  const accepted = AssessmentRequestReceiptSchema.parse(await acceptedResponse.json());
  const requestText = acceptedResponse.request().postData()!;
  const submission = validateRegisteredSubmission(config, {
    version: 1,
    nonce: config.nonce,
    tenantId: config.tenantId,
    actorId: config.actorId,
    engagementId: config.engagementId,
    checkId: associationSnapshot.checkId,
    bindingId: binding.binding_id,
    drishtiObservationId: drishti.observation_id,
    vibhaagObservationId: vibhaag.observation_id,
    targetId: targetSnapshot.id,
    associationId: associationSnapshot.id,
    associationSha256: association.snapshotSha256,
    targetSha256: target.snapshotSha256,
    reviewId: review.id,
    reviewRequestSha256: review.request_sha256,
    reviewSnapshotSha256: review.snapshot_sha256,
    jobId: accepted.jobId,
    runId: accepted.runId,
    requestText,
    requestSha256: createHash('sha256').update(requestText).digest('hex'),
    observedStatus: 202,
  });
  expect(submissions).toBe(1);
  writeRegisteredBrowserFile(directory, 'submission', submission);
  return submission;
}
