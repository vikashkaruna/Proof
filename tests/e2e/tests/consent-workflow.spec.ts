import { test, expect, type Page } from '@playwright/test';
import { selectTenant, signIn, state } from '../fixtures';

// Real GoTrue session -> browser bridge -> BFF -> RPC-only database writes.
// These are synthetic principals/notices. Completion records a human attestation;
// this journey does not claim connector propagation or locked object storage.
function post(page: Page, path: string, data: unknown) {
  return page.request.post(`/api/bff/v1/consent${path}`, {
    headers: { 'x-tenant-id': state.tenantA.id, 'idempotency-key': crypto.randomUUID() },
    data,
  });
}
function get(page: Page, path: string) {
  return page.request.get(`/api/bff/v1/consent${path}`, {
    headers: { 'x-tenant-id': state.tenantA.id },
  });
}

test('reviewed bilingual purpose, pinned notice, withdrawal and human completion persist', async ({
  page,
}) => {
  await signIn(page, 'owner');
  await selectTenant(page, 'a');
  const suffix = crypto.randomUUID();
  const purpose = {
    purposeKey: `journey-${suffix}`,
    nameEn: `Consent journey ${suffix}`,
    nameHi: 'सहमति यात्रा',
    lawfulBasis: 'consent',
    noticeEn: 'Send a monthly newsletter. Withdrawal stops further mail.',
    noticeHi: 'मासिक समाचार भेजें। सहमति वापस लेने पर आगे मेल बंद करें।',
    reviewed: true,
  };
  const unreviewed = await post(page, '/purposes', { ...purpose, reviewed: false });
  expect(unreviewed.status()).toBe(400);
  const registered = await post(page, '/purposes', purpose);
  expect(registered.status()).toBe(201);
  const { data: initial } = (await registered.json()) as {
    data: { purpose_id: string; notice_version: number };
  };
  expect(initial.notice_version).toBe(1);
  const purposeId = initial.purpose_id;

  const grant = {
    purposeId,
    expectedNoticeVersion: 1,
    principalType: 'cookie_id',
    principalRef: `fixture-${suffix}`,
    language: 'hi',
    channel: 'form',
  };
  const captured = await post(page, '/records', grant);
  expect(captured.status()).toBe(201);
  const { data: consent } = (await captured.json()) as {
    data: {
      consent_id: string;
      status: string;
      notice_version: number;
      notice_snapshot_sha256: string;
    };
  };
  expect(consent.status).toBe('granted');
  expect(consent.notice_version).toBe(1);
  expect(consent.notice_snapshot_sha256).toMatch(/^[a-f0-9]{64}$/);

  const nextNotice = {
    expectedNoticeVersion: 1,
    noticeEn: 'Send a quarterly newsletter. Withdrawal stops further mail.',
    noticeHi: 'त्रैमासिक समाचार भेजें। सहमति वापस लेने पर आगे मेल बंद करें।',
    reviewed: true,
  };
  const published = await post(page, `/purposes/${purposeId}/versions`, nextNotice);
  expect(published.status()).toBe(201);
  expect((await published.json()).data.notice_version).toBe(2);
  const stalePublication = await post(page, `/purposes/${purposeId}/versions`, nextNotice);
  expect(stalePublication.status()).toBe(409);
  expect((await stalePublication.json()).error.code).toBe('stale_notice_version');
  const staleCapture = await post(page, '/records', {
    ...grant,
    principalRef: `stale-${suffix}`,
  });
  expect(staleCapture.status()).toBe(409);
  expect((await staleCapture.json()).error.code).toBe('stale_notice_version');

  const historyResponse = await get(page, `/purposes/${purposeId}/versions`);
  expect(historyResponse.status()).toBe(200);
  const history = (await historyResponse.json()) as {
    data: {
      notice_version: number;
      notice_en: string;
      notice_hi: string;
      provenance: string;
      snapshot_sha256: string;
    }[];
    meta: { hasMore: boolean };
  };
  expect(history.meta.hasMore).toBe(false);
  expect(history.data.map((version) => version.notice_version)).toEqual([2, 1]);
  expect(history.data[0]).toMatchObject({
    notice_en: nextNotice.noticeEn,
    notice_hi: nextNotice.noticeHi,
    provenance: 'published',
  });
  expect(history.data[1]).toMatchObject({
    notice_en: purpose.noticeEn,
    notice_hi: purpose.noticeHi,
    provenance: 'published',
  });
  expect(history.data[1]?.snapshot_sha256).toBe(consent.notice_snapshot_sha256);
  for (const version of history.data) expect(version.snapshot_sha256).toMatch(/^[a-f0-9]{64}$/);

  const held = await post(page, `/records/${consent.consent_id}/legal-hold`, { hold: true });
  expect(held.status()).toBe(200);
  expect((await held.json()).data.legal_hold).toBe(true);
  const withdrawn = await post(page, `/records/${consent.consent_id}/withdraw`, {
    language: 'hi',
    reason: 'Controlled journey withdrawal',
  });
  expect(withdrawn.status()).toBe(200);
  const { data: withdrawal } = (await withdrawn.json()) as {
    data: { withdrawal_id: string; consent_id: string; withdrawn_at: string };
  };
  expect(withdrawal.consent_id).toBe(consent.consent_id);
  expect(Number.isFinite(Date.parse(withdrawal.withdrawn_at))).toBe(true);

  const recordsResponse = await get(page, '/records');
  expect(recordsResponse.status()).toBe(200);
  const { data: records } = (await recordsResponse.json()) as {
    data: {
      id: string;
      status: string;
      notice_version: number;
      language: string;
      legal_hold: boolean;
    }[];
  };
  expect(records.find((record) => record.id === consent.consent_id)).toMatchObject({
    status: 'withdrawn',
    notice_version: 1,
    language: 'hi',
    legal_hold: true,
  });
  const pendingResponse = await get(page, '/withdrawals');
  expect(pendingResponse.status()).toBe(200);
  const { data: pending } = (await pendingResponse.json()) as {
    data: { id: string; downstream_completed_at: string | null }[];
  };
  expect(
    pending.find((record) => record.id === withdrawal.withdrawal_id)?.downstream_completed_at,
  ).toBeNull();
  const completion = await post(page, `/withdrawals/${withdrawal.withdrawal_id}/complete`, {});
  expect(completion.status()).toBe(200);
  expect(Number.isFinite(Date.parse((await completion.json()).data.completed_at))).toBe(true);
  const repeated = await post(page, `/withdrawals/${withdrawal.withdrawal_id}/complete`, {});
  expect(repeated.status()).toBe(409);
  expect((await repeated.json()).error.code).toBe('already_completed');
  const released = await post(page, `/records/${consent.consent_id}/legal-hold`, { hold: false });
  expect(released.status()).toBe(200);
  expect((await released.json()).data.legal_hold).toBe(false);

  // Disable the purpose through the sanctioned path. The historical capture
  // keeps its original notice version, even after publication and deactivation.
  const disabled = await post(page, `/purposes/${purposeId}/status`, { active: false });
  expect(disabled.status()).toBe(200);
  const inactiveCapture = await post(page, '/records', {
    ...grant,
    expectedNoticeVersion: 2,
    principalRef: `inactive-${suffix}`,
  });
  expect(inactiveCapture.status()).toBe(409);
  expect((await inactiveCapture.json()).error.code).toBe('purpose_inactive');
  await page.goto('/consent');
  await expect(
    page.getByRole('heading', { name: `${purpose.nameEn} ${purpose.nameHi}`, exact: true }),
  ).toBeVisible();
  await expect(page.getByText(grant.principalRef, { exact: true }).first()).toBeVisible();
});

test('read-only consent access cannot publish or change a lifecycle through the BFF', async ({
  page,
}) => {
  await signIn(page, 'viewer');
  await selectTenant(page, 'a');
  await page.goto('/consent');
  await expect(page.getByRole('button', { name: 'Register purpose', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Record consent', exact: true })).toHaveCount(0);
  const id = crypto.randomUUID();
  for (const path of [
    '/purposes',
    `/purposes/${id}/versions`,
    `/purposes/${id}/status`,
    '/records',
    `/records/${id}/withdraw`,
    `/records/${id}/legal-hold`,
    `/withdrawals/${id}/complete`,
  ]) {
    const refused = await post(page, path, {});
    expect(refused.status()).toBe(403);
  }
  for (const path of ['/purposes', '/records', '/withdrawals', `/purposes/${id}/versions`]) {
    expect((await get(page, path)).status()).toBe(200);
  }
  const foreign = await page.request.get('/api/bff/v1/consent/records', {
    headers: { 'x-tenant-id': state.tenantB.id },
  });
  expect(foreign.status()).toBe(403);
});

test('consent forms require fresh acknowledgement for the chosen notice and record withdrawal follow-up', async ({
  page,
}) => {
  await signIn(page, 'owner');
  await selectTenant(page, 'a');
  await page.goto('/consent');
  await expect(page.getByRole('heading', { name: 'Consent register', exact: true })).toBeVisible();
  const suffix = crypto.randomUUID();
  const consentAcknowledgement = page.getByRole('checkbox', {
    name: 'I confirm the principal received this notice version in the selected language and gave consent.',
    exact: true,
  });
  const register = async (which: string) => {
    const name = `Form consent ${which} ${suffix}`;
    const noticeEn = `Reviewed ${which} notice for this synthetic browser journey.`;
    const noticeHi = `${which} सहमति की समीक्षा की गई सूचना।`;
    await page.getByRole('button', { name: 'Register purpose', exact: true }).click();
    await page.getByLabel('Purpose key', { exact: true }).fill(`form-${which}-${suffix}`);
    await page.getByLabel('English purpose name', { exact: true }).fill(name);
    await page.getByLabel('Hindi purpose name', { exact: true }).fill('सहमति उद्देश्य');
    await page.getByLabel('Lawful basis', { exact: true }).selectOption('consent');
    await page.getByLabel('English notice', { exact: true }).fill(noticeEn);
    await page.getByLabel('Hindi notice', { exact: true }).fill(noticeHi);
    await page
      .getByRole('checkbox', {
        name: 'I reviewed and approve both notice texts for publication.',
        exact: true,
      })
      .check();
    const response = page.waitForResponse(
      (res) =>
        res.url().endsWith('/api/bff/v1/consent/purposes') && res.request().method() === 'POST',
    );
    await page.getByRole('button', { name: 'Save reviewed purpose', exact: true }).click();
    const saved = await response;
    expect(saved.status()).toBe(201);
    const { data } = (await saved.json()) as {
      data: { purpose_id: string; notice_version: number };
    };
    expect(data.notice_version).toBe(1);
    await expect(
      page.getByRole('heading', { name: `${name} सहमति उद्देश्य`, exact: true }),
    ).toBeVisible();
    return { id: data.purpose_id, name, noticeEn, noticeHi };
  };
  const first = await register('first');
  const second = await register('second');
  const purposeCard = page.locator('article').filter({
    has: page.getByRole('heading', { name: `${first.name} सहमति उद्देश्य`, exact: true }),
  });
  await purposeCard.getByRole('button', { name: 'View notice history', exact: true }).click();
  await purposeCard.getByText('Version 1 · Published reviewed snapshot', { exact: true }).click();
  await expect(purposeCard.getByText(first.noticeEn, { exact: true })).toBeVisible();
  await expect(purposeCard.getByText(first.noticeHi, { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Record consent', exact: true }).click();
  await page.getByLabel('Consent purpose', { exact: true }).selectOption(first.id);
  await page.getByLabel('Notice language', { exact: true }).selectOption('en');
  await consentAcknowledgement.check();
  await page.getByLabel('Notice language', { exact: true }).selectOption('hi');
  await expect(consentAcknowledgement).not.toBeChecked();
  await consentAcknowledgement.check();
  await page.getByLabel('Consent purpose', { exact: true }).selectOption(second.id);
  await expect(consentAcknowledgement).not.toBeChecked();
  await consentAcknowledgement.check();
  await page.getByLabel('Consent purpose', { exact: true }).selectOption(first.id);
  await expect(consentAcknowledgement).not.toBeChecked();
  const principal = `form-${suffix}`;
  await page.getByLabel('Principal identifier type', { exact: true }).selectOption('cookie_id');
  await page.getByLabel('Principal identifier', { exact: true }).fill(principal);
  await page.getByLabel('Capture channel', { exact: true }).selectOption('form');
  await consentAcknowledgement.check();
  const captureResponse = page.waitForResponse(
    (res) => res.url().endsWith('/api/bff/v1/consent/records') && res.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Save consent record', exact: true }).click();
  const capture = await captureResponse;
  expect(capture.status()).toBe(201);
  expect(capture.request().postDataJSON()).toMatchObject({
    purposeId: first.id,
    expectedNoticeVersion: 1,
    language: 'hi',
    principalRef: principal,
  });
  const { data: record } = (await capture.json()) as { data: { consent_id: string } };
  const recordsSection = page.locator('section').filter({
    has: page.getByRole('heading', { name: 'Consent records', exact: true }),
  });
  const recordCard = recordsSection.locator('article').filter({
    has: page.getByRole('heading', { name: principal, exact: true }),
  });
  await expect(recordCard).toContainText('granted · Notice 1 (hi)');
  await expect(recordCard).toContainText('Notice snapshot SHA-256:');
  await recordCard.getByRole('button', { name: 'Withdraw consent', exact: true }).click();
  await recordCard.getByLabel('Withdrawal language', { exact: true }).selectOption('hi');
  await recordCard
    .getByLabel('Withdrawal reason (optional)', { exact: true })
    .fill('Synthetic principal requested withdrawal.');
  await recordCard
    .getByRole('checkbox', {
      name: 'I confirm the principal requested this withdrawal.',
      exact: true,
    })
    .check();
  const withdrawalResponse = page.waitForResponse(
    (res) =>
      res.url().endsWith(`/api/bff/v1/consent/records/${record.consent_id}/withdraw`) &&
      res.request().method() === 'POST',
  );
  await recordCard.getByRole('button', { name: 'Confirm withdrawal', exact: true }).click();
  const withdrawal = await withdrawalResponse;
  expect(withdrawal.status()).toBe(200);
  const { data: withdrawn } = (await withdrawal.json()) as { data: { withdrawal_id: string } };
  await expect(recordCard).toContainText('withdrawn · Notice 1 (hi)');
  await expect(
    recordCard.getByRole('button', { name: 'Withdraw consent', exact: true }),
  ).toHaveCount(0);
  const followUp = page
    .locator('section')
    .filter({
      has: page.getByRole('heading', { name: 'Withdrawal follow-up', exact: true }),
    })
    .locator('article')
    .filter({ has: page.getByRole('heading', { name: principal, exact: true }) });
  await expect(followUp).toContainText('Awaiting downstream confirmation');
  await followUp
    .getByRole('checkbox', {
      name: 'I have checked downstream processing has stopped where this withdrawal applies.',
      exact: true,
    })
    .check();
  const completionResponse = page.waitForResponse(
    (res) =>
      res.url().endsWith(`/api/bff/v1/consent/withdrawals/${withdrawn.withdrawal_id}/complete`) &&
      res.request().method() === 'POST',
  );
  await followUp
    .getByRole('button', { name: 'Confirm downstream completion', exact: true })
    .click();
  expect((await completionResponse).status()).toBe(200);
  await expect(followUp).toContainText('Downstream completion confirmed');
  await expect(
    followUp.getByRole('button', { name: 'Confirm downstream completion', exact: true }),
  ).toHaveCount(0);
});
