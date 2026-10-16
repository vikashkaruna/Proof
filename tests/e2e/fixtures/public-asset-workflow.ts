import {
  probeRegisteredResponse,
  registeredResponseScope,
} from '../../../scripts/lib/registered-response-probe';
import { writeRegisteredResponseProbe } from '../../../scripts/lib/registered-browser-diagnostics';
/** Opt-in owned demo fixture. Every mutation below uses the actual product UI
 * and normal Auth/MFA; only public network bytes and KMS/storage are fixtures. */
import { expect, type Page, type Locator } from '@playwright/test';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
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
  publicWebsiteAssetSelectionPageSchema,
  recordedPublicSourceBindingSchema,
  publicAgentObservationSchema,
  parsePublicWebsiteAssetSnapshotText,
  publicControlReviewSetAnyRowSchema,
  publicControlReviewSetAnySnapshotSchema,
  publicControlAssessmentV2Schema,
  AssessmentRequestReceiptSchema,
} from '../../../packages/types/src/index';

/** Record one matching response body inside a pass-through route. A later
 * Response.json() races the UI: once the page re-renders or navigates,
 * Chromium may already have discarded the body. The bytes are the real
 * server's; the route only reads them before fulfilling unchanged. */
async function retainBody(
  page: Page,
  pathname: (path: string) => boolean,
  method: 'GET' | 'POST',
): Promise<() => Promise<unknown>> {
  let text: string | undefined;
  const glob = '**/api/bff/v1/**';
  const handler = async (route: import('@playwright/test').Route) => {
    const request = route.request();
    if (
      request.method() !== method ||
      !pathname(new URL(request.url()).pathname) ||
      text !== undefined
    )
      return route.fallback();
    const response = await route.fetch();
    const body = await response.text();
    text = body;
    await route.fulfill({ response, body });
  };
  await page.route(glob, handler);
  return async () => {
    await expect.poll(() => text !== undefined, { timeout: 15_000 }).toBe(true);
    await page.unroute(glob, handler);
    return JSON.parse(text!) as unknown;
  };
}

const operationPath = '/api/bff/v1/public-website-assets/operations';
/** Fixed diagnostic labels and public status/equality booleans; never identifiers or response text. */
function targetSelectionCheckpoint(
  checkpoint:
    | 'http-status'
    | 'request-tenant'
    | 'response-schema'
    | 'response-kind'
    | 'response-tenant'
    | 'response-actor'
    | 'response-estate'
    | 'response-system'
    | 'target-digest'
    | 'target-withdrawn'
    | 'target-inventory-current',
  value?: number | boolean,
  present?: boolean,
) {
  process.stdout.write(
    `[registered-website-stage] saved-targets-${checkpoint}${
      value === undefined ? '' : `:${value}`
    }${present === undefined ? '' : `:${present}`}\n`,
  );
}

/** Fixed submission checkpoints; no response values or identifiers are emitted. */
function targetSubmissionCheckpoint(
  checkpoint:
    | 'http-status'
    | 'response-schema'
    | 'snapshot-schema'
    | 'snapshot-kind'
    | 'response-tenant'
    | 'response-actor'
    | 'snapshot-url'
    | 'snapshot-estate'
    | 'snapshot-system'
    | 'foreign-http-status'
    | 'foreign-body-check',
  value?: number | boolean,
) {
  process.stdout.write(
    `[registered-website-stage] target-submit-${checkpoint}${value === undefined ? '' : `:${value}`}\n`,
  );
}

function registeredCombobox(scope: Page | Locator, name: string) {
  return scope.getByRole('combobox', { name, exact: true });
}

export async function registeredWebsiteSourceInBrowser(
  page: Page,
  config: RegisteredBrowserConfig,
  directory: string,
) {
  expect(state.supabaseUrl.replace(/\/$/, '')).toBe(config.apiOrigin);
  process.stdout.write('[registered-website-stage] login\n');
  await signInAs(page, config.email, config.password, config.loginSecret);
  await page.context().addCookies([tenantCookie(config.tenantSlug)]);
  process.stdout.write('[registered-website-stage] connectors\n');
  await page.goto('/connectors', { timeout: 15_000 });
  const console = page.getByRole('region', { name: 'Registered public website targets' });
  await expect(console).toBeVisible();
  process.stdout.write('[registered-website-stage] estate-selection\n');
  await registeredCombobox(console, 'Estate').selectOption(config.estateId, { timeout: 15_000 });
  process.stdout.write('[registered-website-stage] system-selection\n');
  await registeredCombobox(console, 'System').selectOption(config.systemId, { timeout: 15_000 });
  await console.getByLabel('Public HTTPS website URL').fill(config.publicUrl, { timeout: 15_000 });
  await console
    .getByLabel('I reviewed this selected context and authorize this exact metadata operation.')
    .check({ timeout: 15_000 });
  process.stdout.write('[registered-website-stage] inventory-visual-check\n');
  await console.screenshot({
    path: join(directory, 'website-console-desktop.private.png'),
    timeout: 15_000,
  });
  const originalViewport = page.viewportSize();
  if (originalViewport) {
    try {
      await page.setViewportSize({ width: 390, height: 844 });
      await console.screenshot({
        path: join(directory, 'website-console-mobile.private.png'),
        timeout: 15_000,
      });
    } finally {
      await page.setViewportSize(originalViewport);
    }
  }
  process.stdout.write('[registered-website-stage] target-submit\n');
  const registered = page.waitForResponse(
    (r) => new URL(r.url()).pathname === operationPath && r.request().method() === 'POST',
    { timeout: 15_000 },
  );
  await console
    .getByRole('button', { name: 'Record selected website operation', exact: true })
    .click({ timeout: 15_000 });
  const registration = await registered;
  targetSubmissionCheckpoint('http-status', registration.status());
  expect(registration.status()).toBe(201);
  targetSubmissionCheckpoint('response-schema');
  const target = await probeRegisteredResponse(
    registration,
    'target-submit',
    registeredResponseScope(
      registration.request().headers(),
      config,
      registration.request().postData(),
    ),
    (body) => publicWebsiteAssetOperationSchema.parse((body as { data: unknown }).data),
    (probe) => writeRegisteredResponseProbe(directory, probe),
  );
  targetSubmissionCheckpoint('snapshot-schema');
  const targetSnapshot = parsePublicWebsiteAssetSnapshotText(target.snapshotText);
  targetSubmissionCheckpoint('snapshot-kind', targetSnapshot.kind === 'target');
  expect(targetSnapshot.kind).toBe('target');
  targetSubmissionCheckpoint('response-tenant', target.tenantId === config.tenantId);
  expect(target.tenantId).toBe(config.tenantId);
  targetSubmissionCheckpoint('response-actor', target.actorId === config.actorId);
  expect(target.actorId).toBe(config.actorId);
  if (targetSnapshot.kind !== 'target') throw new Error('Owned target receipt refused');
  targetSubmissionCheckpoint('snapshot-url', targetSnapshot.url === config.publicUrl);
  expect(targetSnapshot.url).toBe(config.publicUrl);
  targetSubmissionCheckpoint('snapshot-estate', targetSnapshot.estateId === config.estateId);
  expect(targetSnapshot.estateId).toBe(config.estateId);
  targetSubmissionCheckpoint('snapshot-system', targetSnapshot.systemId === config.systemId);
  expect(targetSnapshot.systemId).toBe(config.systemId);
  const foreign = await page.request.get(operationPath + '/' + target.operationKey, {
    headers: { 'X-Tenant-Id': state.tenantB.id },
  });
  targetSubmissionCheckpoint('foreign-http-status', foreign.status());
  expect([403, 404]).toContain(foreign.status());
  targetSubmissionCheckpoint('foreign-body-check');
  expect((await foreign.text()).includes(target.snapshotText)).toBe(false);

  process.stdout.write('[registered-website-stage] capture-prepare\n');
  await registeredCombobox(console, 'Operation').selectOption('capture', { timeout: 15_000 });
  process.stdout.write('[registered-website-stage] load-saved-targets\n');
  const targetsResponse = page.waitForResponse(
    (r) => {
      const url = new URL(r.url());
      return (
        url.pathname === '/api/bff/v1/public-website-assets/selection' &&
        r.request().method() === 'GET' &&
        url.searchParams.get('kind') === 'targets' &&
        url.searchParams.get('estateId') === config.estateId &&
        url.searchParams.get('systemId') === config.systemId
      );
    },
    { timeout: 15_000 },
  );
  await console
    .getByRole('button', { name: 'Load saved targets', exact: true })
    .click({ timeout: 15_000 });
  const loadedTargets = await targetsResponse;
  targetSelectionCheckpoint('http-status', loadedTargets.status());
  expect(loadedTargets.status()).toBe(200);
  targetSelectionCheckpoint(
    'request-tenant',
    loadedTargets.request().headers()['x-tenant-id'] === config.tenantId,
  );
  expect(loadedTargets.request().headers()['x-tenant-id']).toBe(config.tenantId);
  targetSelectionCheckpoint('response-schema');
  const targetsPage = await probeRegisteredResponse(
    loadedTargets,
    'saved-targets',
    registeredResponseScope(loadedTargets.request().headers(), config),
    (body) => publicWebsiteAssetSelectionPageSchema.parse((body as { data: unknown }).data),
    (probe) => writeRegisteredResponseProbe(directory, probe),
  );
  targetSelectionCheckpoint('response-kind', targetsPage.kind === 'targets');
  if (targetsPage.kind !== 'targets') throw new Error('Owned target selection refused');
  targetSelectionCheckpoint('response-tenant', targetsPage.tenantId === config.tenantId);
  expect(targetsPage.tenantId).toBe(config.tenantId);
  targetSelectionCheckpoint('response-actor', targetsPage.actorId === config.actorId);
  expect(targetsPage.actorId).toBe(config.actorId);
  targetSelectionCheckpoint('response-estate', targetsPage.estateId === config.estateId);
  expect(targetsPage.estateId).toBe(config.estateId);
  targetSelectionCheckpoint('response-system', targetsPage.systemId === config.systemId);
  expect(targetsPage.systemId).toBe(config.systemId);
  const selectedTarget = targetsPage.rows.find((row) => row.id === targetSnapshot.id);
  targetSelectionCheckpoint(
    'target-digest',
    selectedTarget?.snapshotSha256 === target.snapshotSha256,
    selectedTarget !== undefined,
  );
  expect(selectedTarget?.snapshotSha256).toBe(target.snapshotSha256);
  targetSelectionCheckpoint('target-withdrawn', selectedTarget?.withdrawn === false);
  expect(selectedTarget?.withdrawn).toBe(false);
  targetSelectionCheckpoint('target-inventory-current', selectedTarget?.inventoryCurrent === true);
  expect(selectedTarget?.inventoryCurrent).toBe(true);
  await registeredCombobox(console, 'Registered public target').selectOption(targetSnapshot.id, {
    timeout: 15_000,
  });
  await console
    .getByLabel('I reviewed this selected context and authorize this exact metadata operation.')
    .check({ timeout: 15_000 });
  let committed: z.infer<typeof publicWebsiteAssetOperationSchema> | undefined;
  let firstBody = '';
  let firstHeaders: Record<string, string> = {};
  // Lose ONLY the browser response after the real server has committed the
  // source and association. No fabricated receipt, intercepted SQL or Auth.
  process.stdout.write('[registered-website-stage] capture-response-loss\n');
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
    .click({ timeout: 15_000 });
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
  process.stdout.write('[registered-website-stage] capture-reload\n');
  await page.reload({ timeout: 15_000 });
  const restored = page.getByRole('article', { name: /^Retained website operation / });
  await expect(restored).toHaveCount(1);
  await expect(restored).toContainText(firstBody);
  await expect(
    restored.getByRole('button', { name: 'Retry exact retained request', exact: true }),
  ).toBeDisabled();
  expect(automatic).toBe(0);
  await restored
    .getByLabel('I reviewed this exact retained request and authorize its retry.')
    .check({ timeout: 15_000 });
  process.stdout.write('[registered-website-stage] capture-exact-replay\n');
  const replayResponseBody = await retainBody(page, (p) => p === operationPath, 'POST');
  const replayResponse = page.waitForResponse(
    (r) => new URL(r.url()).pathname === operationPath && r.request().method() === 'POST',
    { timeout: 15_000 },
  );
  await restored
    .getByRole('button', { name: 'Retry exact retained request', exact: true })
    .click({ timeout: 15_000 });
  const replay = await replayResponse;
  expect(replay.status()).toBe(200);
  expect(replay.request().postData()).toBe(firstBody);
  expect(replay.request().headers()['idempotency-key']).toBe(firstHeaders['idempotency-key']);
  expect(replay.request().headers()['x-tenant-id']).toBe(firstHeaders['x-tenant-id']);
  expect(replay.request().headers()['x-expected-actor-id']).toBe(
    firstHeaders['x-expected-actor-id'],
  );
  const association = publicWebsiteAssetOperationSchema.parse(
    ((await replayResponseBody()) as { data: unknown }).data,
  );
  expect({ ...association, replayed: false }).toEqual(committed);
  expect(association.replayed).toBe(true);
  await expect(restored).toHaveCount(0);
  page.off('request', count);
  const associationSnapshot = parsePublicWebsiteAssetSnapshotText(association.snapshotText);
  if (associationSnapshot.kind !== 'association')
    throw new Error('Owned association receipt refused');
  expect(associationSnapshot.targetId).toBe(targetSnapshot.id);
  expect(associationSnapshot.targetSha256).toBe(target.snapshotSha256);
  process.stdout.write('[registered-website-stage] discovery\n');
  await page
    .getByRole('link', { name: 'Continue this saved check in Discovery' })
    .click({ timeout: 15_000 });
  await registeredCombobox(page, 'Engagement').selectOption(config.engagementId, {
    timeout: 15_000,
  });
  await expect(registeredCombobox(page, 'Saved public website check')).toHaveValue(
    associationSnapshot.checkId,
  );
  const workflow = page.getByRole('region', { name: 'Public website agent workflow', exact: true });
  await workflow
    .getByRole('button', { name: 'Preview saved source', exact: true })
    .click({ timeout: 15_000 });
  await expect(
    workflow.getByRole('button', { name: 'Record source binding', exact: true }),
  ).toBeEnabled();
  process.stdout.write('[registered-website-stage] source-binding\n');
  const bindingResponseBody = await retainBody(
    page,
    (p) => p === '/api/bff/v1/public-source-bindings',
    'POST',
  );
  const bindingResponse = page.waitForResponse(
    (r) =>
      new URL(r.url()).pathname === '/api/bff/v1/public-source-bindings' &&
      r.request().method() === 'POST',
    { timeout: 15_000 },
  );
  await workflow
    .getByRole('button', { name: 'Record source binding', exact: true })
    .click({ timeout: 15_000 });
  const bindingSaved = await bindingResponse;
  expect(bindingSaved.status()).toBe(201);
  const binding = recordedPublicSourceBindingSchema.parse(
    ((await bindingResponseBody()) as { data: unknown }).data,
  );
  expect(binding.runtime_binding.tenant_id).toBe(config.tenantId);
  expect(binding.runtime_binding.check_id).toBe(associationSnapshot.checkId);
  process.stdout.write('[registered-website-stage] drishti\n');
  const drishtiResponseBody = await retainBody(
    page,
    (p) => p.endsWith('/agents/drishti/run'),
    'POST',
  );
  const drishtiResponse = page.waitForResponse(
    (r) =>
      new URL(r.url()).pathname.endsWith('/agents/drishti/run') && r.request().method() === 'POST',
    { timeout: 15_000 },
  );
  await workflow
    .getByRole('button', { name: 'Run Drishti on saved source', exact: true })
    .click({ timeout: 15_000 });
  const drishtiSaved = await drishtiResponse;
  expect(drishtiSaved.status()).toBe(201);
  const drishti = publicAgentObservationSchema.parse(
    ((await drishtiResponseBody()) as { data: unknown }).data,
  );
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
  await workflow
    .getByRole('button', { name: 'Select Drishti observation', exact: true })
    .click({ timeout: 15_000 });
  await expect(workflow).toContainText('Selected Drishti observation: ' + drishti.observation_id);
  process.stdout.write('[registered-website-stage] vibhaag\n');
  const vibhaagResponseBody = await retainBody(
    page,
    (p) => p.endsWith('/agents/vibhaag/run'),
    'POST',
  );
  const vibhaagResponse = page.waitForResponse(
    (r) =>
      new URL(r.url()).pathname.endsWith('/agents/vibhaag/run') && r.request().method() === 'POST',
    { timeout: 15_000 },
  );
  await workflow
    .getByRole('button', { name: 'Run Vibhaag on selected observation', exact: true })
    .click({ timeout: 15_000 });
  const vibhaagSaved = await vibhaagResponse;
  expect(vibhaagSaved.status()).toBe(201);
  const vibhaag = publicAgentObservationSchema.parse(
    ((await vibhaagResponseBody()) as { data: unknown }).data,
  );
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
  process.stdout.write('[registered-website-stage] control-evidence\n');
  const reviewResponseBody = await retainBody(page, (p) => p.endsWith('/control-review'), 'GET');
  const reviewResponse = page.waitForResponse(
    (r) => new URL(r.url()).pathname.endsWith('/control-review') && r.request().method() === 'GET',
    { timeout: 15_000 },
  );
  await page
    .getByRole('button', { name: 'Review website against DPDPA controls', exact: true })
    .click({ timeout: 15_000 });
  const evidenceResponse = await reviewResponse;
  expect(evidenceResponse.status()).toBe(200);
  const evidence = publicControlAssessmentV2Schema.parse(
    ((await reviewResponseBody()) as { data: { assessment: unknown } }).data.assessment,
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
  await registeredCombobox(selection, 'Website review system').selectOption(config.systemId, {
    timeout: 15_000,
  });
  await selection
    .getByRole('button', { name: 'Load registered review targets', exact: true })
    .click({ timeout: 15_000 });
  await registeredCombobox(selection, 'Registered review target').selectOption(targetSnapshot.id, {
    timeout: 15_000,
  });
  await selection
    .getByRole('button', { name: 'Load saved review associations', exact: true })
    .click({ timeout: 15_000 });
  await registeredCombobox(selection, 'Saved review association').selectOption(
    associationSnapshot.id,
    { timeout: 15_000 },
  );
  await selection
    .getByLabel('I confirm this exact saved target, check and association for a new human review.')
    .check({ timeout: 15_000 });
  await registeredCombobox(human, 'Control to review').selectOption('DPDPA-GOV-001', {
    timeout: 15_000,
  });
  await registeredCombobox(human, 'Control question').selectOption('Q1', { timeout: 15_000 });
  await registeredCombobox(human, 'Human declaration').selectOption('yes', { timeout: 15_000 });
  await human
    .getByLabel('Judgment rationale', { exact: true })
    .fill(
      'Synthetic human declaration only; public statements do not prove internal implementation.',
      { timeout: 15_000 },
    );
  await human
    .getByRole('button', { name: 'Add judgment to review draft', exact: true })
    .click({ timeout: 15_000 });
  await human
    .getByLabel('Applicability rationale', { exact: true })
    .fill('Synthetic reviewer has no internal evidence of conditional applicability.', {
      timeout: 15_000,
    });
  await human
    .getByLabel(/I reviewed these declarations and authorise recording/)
    .check({ timeout: 15_000 });
  process.stdout.write('[registered-website-stage] human-review\n');
  const humanResponseBody = await retainBody(
    page,
    (p) => p === '/api/bff/v1/public-control-review-sets',
    'POST',
  );
  const humanResponse = page.waitForResponse(
    (r) =>
      new URL(r.url()).pathname === '/api/bff/v1/public-control-review-sets' &&
      r.request().method() === 'POST',
    { timeout: 15_000 },
  );
  await human
    .getByRole('button', { name: 'Record human control review', exact: true })
    .click({ timeout: 15_000 });
  const humanSaved = await humanResponse;
  expect(humanSaved.status()).toBe(201);
  const review = publicControlReviewSetAnyRowSchema
    .safeExtend({ snapshot: publicControlReviewSetAnySnapshotSchema })
    .parse(((await humanResponseBody()) as { data: { review: unknown } }).data.review);
  expect(review.snapshot.version).toBe(2);
  expect(review.snapshot.request.version).toBe(2);
  if (review.snapshot.request.version !== 2) throw new Error('Registered review downgrade refused');
  expect(review.snapshot.request.associationRef.associationId).toBe(associationSnapshot.id);
  expect(review.snapshot.normalizedAnswers['DPDPA-GOV-001']?.Q1).toBe(true);
  await human
    .getByRole('link', { name: 'Request assessment from this recorded human review', exact: true })
    .click({ timeout: 15_000 });
  let submissions = 0;
  page.on('request', (r) => {
    if (new URL(r.url()).pathname === '/api/bff/v1/assessment/jobs' && r.method() === 'POST')
      submissions++;
  });
  const panel = page.getByRole('region', { name: 'Request a saved assessment' });
  await expect(panel).toContainText(review.id);
  expect(submissions).toBe(0);
  await panel
    .getByLabel(/I request Parikshan using this exact recorded human review/)
    .check({ timeout: 15_000 });
  process.stdout.write('[registered-website-stage] assessment-submit\n');
  const requestResponseBody = await retainBody(
    page,
    (p) => p === '/api/bff/v1/assessment/jobs',
    'POST',
  );
  const requestResponse = page.waitForResponse(
    (r) =>
      new URL(r.url()).pathname === '/api/bff/v1/assessment/jobs' &&
      r.request().method() === 'POST',
    { timeout: 15_000 },
  );
  await panel
    .getByRole('button', { name: 'Request assessment from recorded review', exact: true })
    .click({ timeout: 15_000 });
  const acceptedResponse = await requestResponse;
  expect(acceptedResponse.status()).toBe(202);
  const accepted = AssessmentRequestReceiptSchema.parse(await requestResponseBody());
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
  process.stdout.write('[registered-website-stage] submission-retain\n');
  writeRegisteredBrowserFile(directory, 'submission', submission);
  return submission;
}
