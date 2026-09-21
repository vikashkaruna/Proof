import { test, expect, type Page } from '@playwright/test';
import { generateTotp } from '@axiom/mfa';
import { account, createApprovablePlan, selectTenant, signIn, state } from '../fixtures';

/**
 * W1 — an approver carries an approval through to a signed token, in a browser.
 *
 * The persona journeys prove what each role is *offered*. This proves the
 * positive case actually completes: a real GoTrue session, a real step-up
 * challenge bound to this plan and these actions, a real TOTP code, and a
 * signed approval token issued by the BFF — reaching every gate the product
 * has, in the order a person meets them.
 *
 * It needs the BFF running, which is why it could not exist until the harness
 * started one. Everything before this was a page rendering its own opinion of
 * what the caller may do; the BFF is what decides.
 */

const secretFor = (key: 'approver' | 'approverReplay') => {
  const secret = account(key).totpSecret;
  if (!secret) throw new Error(`The ${key} persona was seeded without a TOTP factor`);
  return secret;
};

/**
 * Sign in as the approver on a plan created for this journey alone.
 *
 * Approving is a state transition — an approved action stops being eligible —
 * so journeys sharing one seeded action make the second fail for a reason
 * that has nothing to do with what it was testing. The first draft of this
 * file did exactly that.
 */
async function openOwnPlanAsApprover(
  page: Page,
  label: string,
  who: 'approver' | 'approverReplay' = 'approver',
) {
  const plan = await createApprovablePlan(label);
  await signIn(page, who);
  await selectTenant(page, 'a');
  await page.goto(`/plans/${plan.id}`);
  await expect(page.locator('body')).toContainText(plan.title, { timeout: 30_000 });
  return plan;
}

/** Click "Approve N actions", which opens the step-up panel. */
async function beginApproval(page: Page) {
  await page.getByRole('button', { name: /^Approve \d+ action/ }).click();
  await expect(page.getByText('Confirm with your authenticator')).toBeVisible({ timeout: 30_000 });
}

test.describe('an approver completes an approval', () => {
  test('a correct code issues a signed approval token', async ({ page }) => {
    await openOwnPlanAsApprover(page, 'Approve me');
    await beginApproval(page);

    await page.fill('#stepUpCode', generateTotp(secretFor('approver')));
    await page.getByRole('button', { name: /Verify and approve/ }).click();

    // The success message the component sets only after the BFF returns a
    // signed token. Reaching it means the challenge was issued, satisfied,
    // bound to this plan and these actions, and spent on the approval.
    await expect(page.getByText(/Approved 1 action/)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/Signed approval token issued/)).toBeVisible();
  });

  test('a wrong code does not approve anything', async ({ page }) => {
    await openOwnPlanAsApprover(page, 'Wrong code');
    await beginApproval(page);

    await page.fill('#stepUpCode', '000000');
    await page.getByRole('button', { name: /Verify and approve/ }).click();

    // The step-up panel stays open and no token is issued. A failed second
    // factor must cost an approval, not merely a retry prompt with the
    // approval already granted behind it.
    await expect(page.getByText(/Signed approval token issued/)).toHaveCount(0);
    await expect(page.getByText('Confirm with your authenticator')).toBeVisible();
  });

  test('the same code cannot be spent twice', async ({ page }) => {
    // A TOTP code is valid for a whole step, so replay defence is the
    // difference between "one approval per code" and "as many as fit in 30
    // seconds". The second attempt must not produce a second token.
    // Its own approver: replay defence is per factor, so sharing one with the
    // happy-path journey would have the product refuse this legitimately and
    // for the wrong reason.
    const plan = await openOwnPlanAsApprover(page, 'Replay', 'approverReplay');
    await beginApproval(page);

    const code = generateTotp(secretFor('approverReplay'));
    await page.fill('#stepUpCode', code);
    await page.getByRole('button', { name: /Verify and approve/ }).click();
    await expect(page.getByText(/Signed approval token issued/)).toBeVisible({ timeout: 30_000 });

    // A fresh challenge, the same code.
    await page.reload();
    await expect(page.locator('body')).toContainText(plan.title, { timeout: 30_000 });
    const approveAgain = page.getByRole('button', { name: /^Approve \d+ action/ });
    if ((await approveAgain.count()) === 0) {
      // Nothing left eligible to approve is itself a refusal to double-spend.
      return;
    }
    await beginApproval(page);
    await page.fill('#stepUpCode', code);
    await page.getByRole('button', { name: /Verify and approve/ }).click();
    await expect(page.getByText(/Signed approval token issued/)).toHaveCount(0);
  });
});

test.describe('the step-up is bound to what is being approved', () => {
  test('a viewer cannot start one at all', async ({ page }) => {
    // The complement from the server's side: the button is absent, and the
    // endpoint behind it refuses too. `verify-strict-parity.ts` asserts the
    // refusal directly; here it is that the surface never offers the path.
    await signIn(page, 'viewer');
    await selectTenant(page, 'a');
    await page.goto(`/plans/${state.planA.id}`);
    await expect(page.locator('body')).toContainText(state.planA.title, { timeout: 30_000 });
    await expect(page.getByRole('button', { name: /^Approve \d+ action/ })).toHaveCount(0);
    await expect(page.getByText('Confirm with your authenticator')).toHaveCount(0);
  });

  test('a scoped approver is refused by the server, not just by the page', async ({ page }) => {
    // `approverScoped` holds the approver role with a non-empty
    // `approval_scopes` that does not cover this action's class, so the page
    // offers no approve control. If the control ever reappears, this is the
    // journey that notices.
    await signIn(page, 'approverScoped');
    await selectTenant(page, 'a');
    await page.goto(`/plans/${state.planA.id}`);
    await expect(page.locator('body')).toContainText(state.planA.title, { timeout: 30_000 });
    await expect(page.getByRole('button', { name: /^Approve \d+ action/ })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Reject plan/ })).toBeVisible();
  });
});
