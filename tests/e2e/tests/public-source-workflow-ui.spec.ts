/** Browser protocol regression with real form sign-in and tenant role rendering.
 * Source API responses below are explicit synthetic fixtures: these tests do
 * not execute an agent, fetch a public website, or prove database provenance.
 * The separately guarded operator acceptance exercises the real backend.
 */
import { createHash } from 'node:crypto';
import { test, expect, type Page } from '@playwright/test';
import {
  publicSourcePreviewSchema,
  publicAgentObservationSchema,
  publicSourceObservationHistoryResponseSchema,
  publicSourceEngagementOptionsResponseSchema,
  publicSourceReviewHistoryResponseSchema,
  type PublicAgentObservation,
} from '../../../packages/types/src/index';
import { canonicalJson } from '../../../packages/ledger/src/canonicalise';
import { signIn, selectTenant, satisfyLoginMfa, state } from '../fixtures';

const checkId = '44444444-4444-4444-8444-444444444444';
const bindingId = '55555555-5555-4555-8555-555555555555';
const drishtiId = '66666666-6666-4666-8666-666666666666';
const vibhaagId = '77777777-7777-4777-8777-777777777777';
const runId = '88888888-8888-4888-8888-888888888888';
const dispatchId = '99999999-9999-4999-8999-999999999999';
const rootSha = 'a'.repeat(64),
  projectionSha = 'b'.repeat(64);
const createdAt = '2026-10-05T01:00:00Z';
const journalKey = `axiom.public-source.operation.v1:${state.tenantA.id}:${state.accounts.owner.id}`;
const binding = {
  tenant_id: state.tenantA.id,
  engagement_id: state.engagementA,
  check_id: checkId,
  root_content_sha256: rootSha,
  projection_sha256: projectionSha,
  projection_version: 1,
};
const privateFacts = {
  hosting_region: 'unknown',
  backend_personal_data: 'unknown',
  cross_border_processing: 'unknown',
};
const metadata = {
  version: 1,
  scope: 'static_html_form_descendants',
  sourceSha256: 'c'.repeat(64),
  observedFormCount: 1,
  formsTruncated: false,
  forms: [
    {
      ordinal: 1,
      method: 'post',
      observedControlCount: 2,
      excludedControlCount: 1,
      controlsTruncated: false,
      controls: [
        {
          ordinal: 2,
          element: 'input',
          inputType: 'email',
          requiredAttribute: true,
          disabledAttribute: false,
        },
      ],
    },
  ],
};
const preview = publicSourcePreviewSchema.parse({
  runtime_binding: binding,
  binding_id: bindingId,
  creation_receipt: '3',
  projection: {
    version: 1,
    pages: [
      { page: 'root', status: 'checked', content_sha256: rootSha },
      {
        page: 'contact',
        status: 'checked',
        content_sha256: 'c'.repeat(64),
        form_metadata: metadata,
      },
      { page: 'terms', status: 'unavailable' },
    ],
  },
});
function observation(agent: 'drishti' | 'vibhaag'): PublicAgentObservation {
  const output =
    agent === 'drishti'
      ? {
          mode: 'public_website',
          observation: {
            version: 1,
            binding,
            pages: preview.projection.pages.map((page) => ({
              ...page,
              form_state:
                page.status === 'unavailable'
                  ? 'unavailable'
                  : page.form_metadata
                    ? 'observed'
                    : 'unexamined',
            })),
            private_facts: privateFacts,
            requires_human_review: true,
          },
        }
      : {
          mode: 'public_website',
          source_binding: binding,
          indicators: [
            {
              page: 'contact',
              content_sha256: 'c'.repeat(64),
              form_ordinal: 1,
              control_ordinal: 2,
              input_type: 'email',
              indicator: 'potential_contact_collection',
              requires_human_review: true,
            },
          ],
          private_facts: privateFacts,
          unexamined_pages: ['root'],
          unavailable_pages: ['terms'],
          scope_limited: true,
        };
  return publicAgentObservationSchema.parse({
    observation_id: agent === 'drishti' ? drishtiId : vibhaagId,
    dispatch_id: dispatchId,
    binding_id: bindingId,
    run_id: runId,
    output_sha256: createHash('sha256').update(canonicalJson(output)).digest('hex'),
    completion_receipt: agent === 'drishti' ? '12' : '16',
    agent,
    output,
  });
}
const discovery = observation('drishti'),
  classification = observation('vibhaag');
function summary(row: PublicAgentObservation) {
  const { output: _output, ...identity } = row;
  return {
    ...identity,
    tenant_id: state.tenantA.id,
    engagement_id: state.engagementA,
    created_at: createdAt,
  };
}
async function journal(page: Page) {
  return page.evaluate((key) => {
    const value = localStorage.getItem(key);
    return value === null
      ? null
      : (JSON.parse(value) as {
          operationKey: string;
          bodyUtf8: string;
          actorId: string;
          tenantId: string;
        });
  }, journalKey);
}
async function signedIn(page: Page, role: 'owner' | 'viewer') {
  await signIn(page, role);
  await selectTenant(page, 'a');
  // Ordinary CI owner needs no factor; isolated operator fixtures may have one.
  if (new URL(page.url()).pathname === '/verify') await satisfyLoginMfa(page, role);
}
async function selectSource(page: Page) {
  await page.goto('/discovery');
  await expect(page.getByRole('button', { name: 'Refresh choices' })).toBeEnabled();
  await page
    .getByRole('combobox', { name: 'Engagement', exact: true })
    .selectOption(state.engagementA);
  await page
    .getByRole('combobox', { name: 'Saved public website check', exact: true })
    .selectOption(checkId);
  await page.getByRole('button', { name: 'Preview saved source' }).click();
  await expect(page.getByRole('heading', { name: 'Retained public HTML facts' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Refresh choices' })).toBeEnabled();
}
async function sourceApi(
  page: Page,
  options: { viewer?: boolean; barePreview?: boolean; exactRetry?: boolean } = {},
) {
  const stored = new Map<string, PublicAgentObservation>();
  if (options.viewer) {
    stored.set(drishtiId, discovery);
    stored.set(vibhaagId, classification);
  }
  const posts: { agent: string; key: string; body: string }[] = [];
  const historyReads: string[] = [];
  let routeError: unknown;
  await page.route('**/api/bff/v1/**', async (route) => {
    const request = route.request(),
      url = new URL(request.url()),
      path = url.pathname;
    // Other APIs, authentication and membership checks retain their real routes.
    if (!path.includes('/public-source') && !path.includes('/public-website-checks')) {
      await route.continue();
      return;
    }
    try {
      expect(request.headers()['x-tenant-id']).toBe(state.tenantA.id);
      if (path.endsWith('/public-source/options/engagements')) {
        await route.fulfill({
          json: publicSourceEngagementOptionsResponseSchema.parse({
            data: [
              {
                id: state.engagementA,
                tenant_id: state.tenantA.id,
                title: 'Synthetic source UI protocol',
                status: 'discovery',
                library_version: state.libraryVersion,
                created_at: createdAt,
                estate: null,
              },
            ],
            meta: { limit: 20, hasMore: false, nextCursor: null },
          }),
        });
      } else if (path.endsWith('/public-website-checks')) {
        await route.fulfill({
          json: {
            data: [
              {
                id: checkId,
                finalUrl: 'https://source-ui.example.invalid/',
                checkedAt: createdAt,
                status: 'checked',
                contentSha256: rootSha,
              },
            ],
          },
        });
      } else if (path.endsWith('/source-preview')) {
        expect(url.searchParams.get('engagementId')).toBe(state.engagementA);
        await route.fulfill({ json: options.barePreview ? preview : { data: preview } }); // Actual envelope is wrapped.
      } else if (path === `/api/bff/v1/public-source-bindings/${bindingId}/observations`) {
        await route.fulfill({
          json: publicSourceObservationHistoryResponseSchema.parse({
            data: Array.from(stored.values(), summary),
            meta: { limit: 20, hasMore: false, nextCursor: null },
          }),
        });
      } else if (
        /^\/api\/bff\/v1\/public-source-bindings\/[^/]+\/observations\/[^/]+\/reviews$/.test(path)
      ) {
        expect(request.method()).toBe('GET');
        const parts = path.split('/');
        expect(parts[5]).toBe(bindingId);
        const row = stored.get(parts[7]!);
        expect(row).toBeDefined();
        expect(row!.binding_id).toBe(bindingId);
        expect(parts[7]).toBe(row!.observation_id);
        expect(Array.from(url.searchParams.keys()).sort()).toEqual(['engagementId', 'limit']);
        expect(url.searchParams.get('engagementId')).toBe(state.engagementA);
        expect(url.searchParams.get('limit')).toBe('20');
        historyReads.push(`${path}${url.search}`);
        // This synthetic protocol fixture has no human judgments. Returning
        // empty history does not manufacture a review or establish compliance.
        await route.fulfill({
          json: publicSourceReviewHistoryResponseSchema.parse({
            data: [],
            meta: { limit: 20, hasMore: false, nextCursor: null },
          }),
        });
      } else if (
        path === `/api/bff/v1/public-source-observations/${drishtiId}` ||
        path === `/api/bff/v1/public-source-observations/${vibhaagId}`
      ) {
        const row = stored.get(path.split('/').at(-1)!);
        expect(row).toBeDefined();
        await route.fulfill({ json: { data: row } });
      } else if (path.endsWith('/request')) {
        const key = request.headers()['x-public-source-request-key'];
        expect(key).toBe(posts[0]?.key);
        expect(url.search).not.toContain(key!);
        expect(request.headers()['idempotency-key']).toBeUndefined();
        await route.fulfill({
          json: {
            data: {
              tenant_id: state.tenantA.id,
              actor_id: state.accounts.owner.id,
              engagement_id: state.engagementA,
              binding_id: bindingId,
              agent: 'drishti',
              correlation_id: runId,
              outcome: options.exactRetry
                ? { state: 'not_found' }
                : { state: 'retained', observation: summary(discovery) },
            },
          },
        });
      } else if (path.endsWith('/run') && request.method() === 'POST') {
        expect(options.viewer).not.toBe(true);
        const agent = path.includes('/drishti/') ? 'drishti' : 'vibhaag';
        const earlier = posts.find((row) => row.agent === agent);
        if (earlier) {
          expect(options.exactRetry && agent === 'drishti').toBe(true);
          expect(posts).toHaveLength(1);
        }
        const retained = await journal(page);
        expect(retained?.tenantId).toBe(state.tenantA.id);
        expect(retained?.actorId).toBe(state.accounts.owner.id);
        const key = request.headers()['idempotency-key']!;
        const body = request.postData()!;
        expect(retained?.operationKey).toBe(key);
        expect(retained?.bodyUtf8).toBe(body);
        expect(JSON.parse(body)).toEqual({
          engagementId: state.engagementA,
          expectedProjectionSha256: projectionSha,
          ...(agent === 'vibhaag' ? { observationId: drishtiId } : {}),
        });
        if (earlier) {
          expect(key).toBe(earlier.key);
          expect(body).toBe(earlier.body);
        }
        posts.push({ agent, key, body });
        if (!(options.exactRetry && !earlier))
          stored.set(
            agent === 'drishti' ? drishtiId : vibhaagId,
            agent === 'drishti' ? discovery : classification,
          );
        // Simulation only: no request in this test reaches an agent runtime.
        if (agent === 'drishti' && !earlier) await route.abort('failed');
        else
          await route.fulfill({
            status: 201,
            json: { data: agent === 'drishti' ? discovery : classification },
          });
      } else throw new Error(`Unexpected synthetic source request: ${request.method()} ${path}`);
    } catch (error) {
      routeError = error;
      await route.abort().catch(() => undefined);
    }
  });
  return {
    posts,
    stored,
    assertRoutes: () => expect(routeError).toBeUndefined(),
    assertHistory: async () => {
      expect(historyReads.length).toBeGreaterThan(0);
      await test.info().attach('validated-synthetic-review-history-reads', {
        body: JSON.stringify(historyReads),
        contentType: 'application/json',
      });
    },
  };
}
async function keyboardReceipts(page: Page, expected: PublicAgentObservation) {
  const result = page.getByRole('region', { name: 'Retained agent result', exact: true });
  const summary = result.getByText('Review retained receipts and hashes', { exact: true });
  const details = summary.locator('..');
  if (await details.evaluate((element) => (element as HTMLDetailsElement).open)) {
    await summary.press('Enter');
    await expect(details).toHaveJSProperty('open', false);
  }
  await summary.focus();
  await summary.press('Enter');
  await expect(details).toHaveJSProperty('open', true);
  await expect(result).toContainText(expected.output_sha256);
  await expect(result).toContainText(expected.observation_id);
  await expect(result).toContainText('Human review pending');
  await expect(result).toContainText('Private hosting: unknown');
}
async function mobile(page: Page) {
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('main')).toHaveCount(1);
  await expect(page.locator('h1')).toHaveCount(1);
  const sizes = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }));
  expect(sizes.scroll).toBeLessThanOrEqual(sizes.client + 1);
  await page.evaluate(() => window.scrollTo(0, 0));
  const screenshot = test.info().outputPath('synthetic-source-workflow-mobile.png');
  await page.screenshot({ path: screenshot, fullPage: true });
  await test
    .info()
    .attach('synthetic-source-workflow-mobile', { path: screenshot, contentType: 'image/png' });
}

test('owner recovers a lost source response after reload with the same request and no duplicate POST', async ({
  page,
}) => {
  await signedIn(page, 'owner');
  const api = await sourceApi(page);
  await selectSource(page);
  await expect(page.getByRole('button', { name: 'Record source binding' })).toBeDisabled();
  await page.getByRole('button', { name: 'Run Drishti on saved source' }).click();
  await expect(
    page
      .getByRole('region', { name: 'Public website agent workflow', exact: true })
      .getByRole('alert'),
  ).toContainText('Response interrupted');
  const original = await journal(page);
  expect(original).not.toBeNull();
  expect(api.posts).toHaveLength(1);
  await expect(page.getByRole('button', { name: 'Run Drishti on saved source' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Retry exact retained request' })).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Reconcile retained request' })).toBeEnabled();
  expect(await journal(page)).toEqual(original);
  api.assertRoutes();
  await page.getByRole('button', { name: 'Reconcile retained request' }).click();
  await expect(page.getByRole('heading', { name: 'Drishti public observation' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Refresh choices' })).toBeEnabled();
  expect(await journal(page)).toBeNull();
  expect(api.posts).toHaveLength(1);
  await expect(page.getByText(`Selected Drishti observation: ${drishtiId}`)).toBeVisible();
  await page.getByRole('button', { name: 'Run Vibhaag on selected observation' }).click();
  await expect(page.getByRole('heading', { name: 'Vibhaag structural indicators' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Refresh choices' })).toBeEnabled();
  expect(await journal(page)).toBeNull();
  expect(api.posts).toHaveLength(2);
  expect(api.posts[0]?.key).not.toBe(api.posts[1]?.key);
  await keyboardReceipts(page, classification);
  await mobile(page);
  api.assertRoutes();
  await api.assertHistory();
});

test('viewer reads retained source receipts and static attributes using keyboard without mutation controls', async ({
  page,
}) => {
  await signedIn(page, 'viewer');
  const api = await sourceApi(page, { viewer: true });
  await selectSource(page);
  for (const name of [
    'Record source binding',
    'Run Drishti on saved source',
    'Run Vibhaag on selected observation',
    'Retry exact retained request',
  ])
    await expect(page.getByRole('button', { name })).toHaveCount(0);
  const forms = page.getByRole('region', { name: 'contact static HTML forms', exact: true });
  await forms.getByText('Inspect recorded form attributes', { exact: true }).focus();
  await forms.getByText('Inspect recorded form attributes', { exact: true }).press('Enter');
  await expect(forms).toContainText('input (email)');
  await expect(forms).toContainText('1 excluded');
  for (const result of [discovery, classification]) {
    const item = page
      .getByRole('listitem')
      .filter({ hasText: `receipt ${result.completion_receipt}` });
    await item
      .getByRole('button', {
        name: result.agent === 'drishti' ? 'Select Drishti observation' : 'Review Vibhaag result',
      })
      .click();
    await expect(
      page.getByRole('heading', {
        name:
          result.agent === 'drishti'
            ? 'Drishti public observation'
            : 'Vibhaag structural indicators',
      }),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Refresh choices' })).toBeEnabled();
    await keyboardReceipts(page, result);
  }
  await mobile(page);
  expect(api.posts).toHaveLength(0);
  api.assertRoutes();
  await api.assertHistory();
});

test('refuses an unwrapped source preview before exposing run controls', async ({ page }) => {
  await signedIn(page, 'owner');
  const api = await sourceApi(page, { barePreview: true });
  await page.goto('/discovery');
  await expect(page.getByRole('button', { name: 'Refresh choices' })).toBeEnabled();
  await page
    .getByRole('combobox', { name: 'Engagement', exact: true })
    .selectOption(state.engagementA);
  await page
    .getByRole('combobox', { name: 'Saved public website check', exact: true })
    .selectOption(checkId);
  await page.getByRole('button', { name: 'Preview saved source' }).click();
  await expect(
    page
      .getByRole('region', { name: 'Public website agent workflow', exact: true })
      .getByRole('alert'),
  ).toContainText('could not be confirmed');
  await expect(page.getByRole('heading', { name: 'Retained public HTML facts' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Run Drishti on saved source' })).toBeDisabled();
  expect(api.posts).toHaveLength(0);
  api.assertRoutes();
});

test('explicit retry after not-found reconciliation preserves the original operation key and UTF8 body', async ({
  page,
}) => {
  await signedIn(page, 'owner');
  const api = await sourceApi(page, { exactRetry: true });
  await selectSource(page);
  await page.getByRole('button', { name: 'Run Drishti on saved source' }).click();
  const workflow = page.getByRole('region', { name: 'Public website agent workflow', exact: true });
  await expect(workflow.getByRole('alert')).toContainText('Response interrupted');
  const original = await journal(page);
  expect(original).not.toBeNull();
  await page.getByRole('button', { name: 'Reconcile retained request' }).click();
  await expect(page.getByRole('button', { name: 'Retry exact retained request' })).toBeEnabled();
  expect(await journal(page)).toEqual(original);
  expect(api.posts).toHaveLength(1);
  await page.getByRole('button', { name: 'Retry exact retained request' }).click();
  await expect(page.getByRole('heading', { name: 'Drishti public observation' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Refresh choices' })).toBeEnabled();
  expect(await journal(page)).toBeNull();
  expect(api.posts).toHaveLength(2);
  for (const row of api.posts) {
    expect(row.key).toBe(original!.operationKey);
    expect(row.body).toBe(original!.bodyUtf8);
  }
  api.assertRoutes();
  await api.assertHistory();
});
