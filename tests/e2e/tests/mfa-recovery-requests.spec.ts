import { expect, test } from '@playwright/test';
import { createMfaAccount, selectTenant, signInAs } from '../fixtures';

test('password-only subject asks a nominated founder; only the founder sees the request and no case opens', async ({
  browser,
}) => {
  const founder = await createMfaAccount('request-recipient', {
    role: 'founder',
    withFactor: true,
    isInternal: true,
  });
  const subject = await createMfaAccount('request-subject', { role: 'owner', withFactor: true });
  const subjectContext = await browser.newContext();
  const recipientContext = await browser.newContext();
  try {
    const page = await subjectContext.newPage();
    await selectTenant(page, 'a');
    await signInAs(page, subject.email, subject.password);
    await page.goto('/settings/security');
    const panel = page.getByTestId('mfa-recovery-requests');
    await panel.getByRole('button', { name: 'Check recovery requests' }).click();
    await panel.getByLabel('Ask for help from').selectOption(founder.id);
    await panel
      .getByLabel('What happened?')
      .fill('Fixture phone lost; request independently verified help');
    await panel.getByRole('button', { name: 'Send recovery request' }).click();
    await expect(panel.getByRole('status')).toContainText('Recovery request recorded');
    await page.reload();
    await panel.getByRole('button', { name: 'Check recovery requests' }).click();
    await expect(panel.getByText(`Requested from ${founder.email}: pending.`)).toBeVisible();
    // The password-only request did not lift quarantine or start account recovery.
    await page.goto('/dashboard');
    await expect(page).toHaveURL(/\/verify/);
    const recipientPage = await recipientContext.newPage();
    await selectTenant(recipientPage, 'a');
    await signInAs(recipientPage, founder.email, founder.password, founder.totpSecret);
    await recipientPage.goto('/settings/security');
    const inbox = recipientPage.getByTestId('mfa-recovery-requests');
    await inbox.getByRole('button', { name: 'Check recovery requests' }).click();
    await expect(inbox.getByText(`${subject.email} needs authenticator recovery.`)).toBeVisible();
    await expect(inbox.getByText(/This request is not identity verification/)).toBeVisible();
    await expect(
      recipientPage
        .getByTestId('mfa-recovery-console')
        .getByRole('button', { name: 'Open recovery console' }),
    ).toBeVisible();
    await page.goto('/settings/security');
    await panel.getByRole('button', { name: 'Check recovery requests' }).click();
    await panel.getByRole('button', { name: 'Cancel request' }).click();
    await expect(panel.getByRole('status')).toContainText('Request cancelled');
    await inbox.getByRole('button', { name: 'Check recovery requests' }).click();
    await expect(inbox.getByText(`${subject.email} needs authenticator recovery.`)).toHaveCount(0);
  } finally {
    await subjectContext.close();
    await recipientContext.close();
  }
});
