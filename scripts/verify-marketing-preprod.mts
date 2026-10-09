/** Parent-run hosted marketing acceptance only. No guessed URLs or product fixtures.
 * API201 acknowledges persistence; independent DB rows and lifecycle remain gates. */
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import {
  constants,
  openSync,
  closeSync,
  fstatSync,
  fchmodSync,
  ftruncateSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  lstatSync,
  existsSync,
} from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '../apps/web/scripts/marketing-acceptance-browser.ts';
import { GAP_SCAN_QUESTIONS } from '../packages/control-library/src/gap-scan-questions.ts';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
type Config = {
  schemaVersion: number;
  environment: string;
  project: string;
  releaseSha: string;
  marketingUrl: string;
  bffUrl: string;
  approvalSha256: string;
  expiresAt: string;
  scope: { maxContacts: number; maxGapScans: number; emailDelivery: string };
};
function privateRead(path: string): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const s = fstatSync(fd);
    assert(s.isFile() && !(s.mode & 0o077) && s.size < 1048576);
    return readFileSync(fd, 'utf8');
  } finally {
    closeSync(fd);
  }
}
function save(path: string, body: string | Buffer): void {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  try {
    assert(fstatSync(fd).isFile());
    fchmodSync(fd, 0o600);
    ftruncateSync(fd, 0);
    writeFileSync(fd, body);
  } finally {
    closeSync(fd);
  }
}
function privateCache(headers: Record<string, string>): void {
  const cache = headers['cache-control']?.toLowerCase() ?? '';
  assert(
    cache.includes('private') &&
      cache.includes('no-store') &&
      !/\bpublic\b|s-maxage\s*=\s*[1-9]/.test(cache),
  );
  assert(!headers.age || Number(headers.age) === 0);
}
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  assert(args.length === 4 && args[0] === '--config' && args[2] === '--output');
  const c = JSON.parse(privateRead(resolve(args[1]))) as Config;
  assert(
    c.schemaVersion === 1 &&
      c.environment === 'preprod' &&
      /^[a-f0-9]{40}$/.test(c.releaseSha) &&
      /^[a-f0-9]{64}$/.test(c.approvalSha256),
  );
  assert(
    Date.parse(c.expiresAt) > Date.now() &&
      c.scope.maxContacts === 2 &&
      c.scope.maxGapScans === 1 &&
      c.scope.emailDelivery === 'disabled',
  );
  const host = new URL(c.marketingUrl),
    bff = new URL(c.bffUrl);
  assert(
    host.protocol === 'https:' && bff.protocol === 'https:' && bff.hostname.endsWith('.run.app'),
  );
  const output = resolve(args[3]);
  assert(output.startsWith(resolve(ROOT, '.axiom-runtime/review') + sep));
  // Refuse existing symlink ancestors before creating private files/directories.
  for (let p = dirname(output); p !== ROOT && p.startsWith(ROOT); p = dirname(p)) {
    try {
      assert(!lstatSync(p).isSymbolicLink());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  assert(!existsSync(output), 'Use a fresh run directory; previous evidence must remain intact');
  mkdirSync(output, { recursive: true, mode: 0o700 });
  assert(!lstatSync(output).isSymbolicLink() && !(lstatSync(output).mode & 0o077));
  const run = randomUUID(),
    email = `marketing-${run}@example.invalid`;
  const proof: Record<string, unknown> = {
    run,
    config: c,
    status: 'running',
    contacts: [],
    gapScans: [],
    remainingGates: [
      'Independent retained-row and rate-budget readback',
      'Separate lifecycle cold-wake and inflight-stop acceptance',
    ],
  };
  const journal = () =>
    save(resolve(output, 'acceptance.private.json'), JSON.stringify(proof, null, 2));
  journal();
  const get = async (path: string) => {
    const r = await fetch(new URL(path, bff), {
      redirect: 'error',
      signal: AbortSignal.timeout(90000),
    });
    assert(r.ok);
    return r.json();
  };
  const health = await get('/health');
  assert(
    health.status === 'healthy' &&
      health.profile === 'marketing' &&
      health.releaseSha === c.releaseSha,
  );
  const contact = await get('/public/contact/config'),
    report = await get('/public/gap-scan/config');
  assert(contact.emailDeliveryEnabled === false && report.emailDeliveryEnabled === false);
  proof.health = health;
  proof.emailConfiguration = { contact, report };
  journal();
  assert(Date.parse(c.expiresAt) > Date.now());
  const direct = await fetch(new URL('/public/contact', bff), {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(90000),
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Synthetic preprod acceptance',
      email,
      company: `Synthetic ${run}`,
      message: `Recorded preprod acceptance ${run}; retain synthetic record without email.`,
    }),
  });
  assert(direct.status === 201);
  const directBody = await direct.json();
  assert(/^[a-f0-9-]{36}$/.test(directBody.id) && directBody.delivery === 'not_configured');
  proof.contacts = [{ channel: 'bff', email, response: directBody, independentlyReadBack: false }];
  journal();
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    const writes = { contact: 0, gapScan: 0 };
    await context.route('**/*', async (route) => {
      const request = route.request(),
        target = new URL(request.url());
      if (!['GET', 'HEAD'].includes(request.method())) {
        if (Date.parse(c.expiresAt) <= Date.now()) return route.abort('blockedbyclient');
        if (request.method() !== 'POST' || target.origin !== host.origin)
          return route.abort('blockedbyclient');
        if (target.pathname === '/api/contact' && ++writes.contact === 1) return route.continue();
        if (target.pathname === '/api/gap-scan' && ++writes.gapScan === 1) return route.continue();
        return route.abort('blockedbyclient');
      }
      return route.continue();
    });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', () => errors.push('uncaught-browser-error'));
    const pages: unknown[] = [];
    for (const width of [360, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      for (const path of [
        '/',
        '/about',
        '/agents',
        '/pricing',
        '/privacy',
        '/terms',
        '/contact',
        '/gap-scan',
      ]) {
        const r = await page.goto(new URL(path, host).href, {
          waitUntil: 'networkidle',
          timeout: 90000,
        });
        assert(r && r.ok());
        assert(new URL(page.url()).origin === host.origin);
        assert(await page.locator('h1').first().isVisible());
        assert(
          await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
          `${path} horizontal overflow at ${width}`,
        );
        const image = `${width}-${path === '/' ? 'home' : path.slice(1)}.png`;
        save(resolve(output, image), await page.screenshot({ fullPage: true }));
        pages.push({ path, width, status: r.status(), screenshot: image });
      }
    }
    proof.staticPages = pages;
    journal();
    await page.goto(new URL('/contact', host).href);
    await page.locator('#contact-name').fill('Synthetic browser acceptance');
    await page.locator('#contact-email').fill(`browser-${run}@example.invalid`);
    await page.locator('#contact-company').fill(`Synthetic ${run}`);
    await page
      .locator('#contact-message')
      .fill(`Recorded browser preprod acceptance ${run}; no email delivery requested.`);
    const contactResponse = page.waitForResponse(
      (r) =>
        new URL(r.url()).origin === host.origin &&
        new URL(r.url()).pathname === '/api/contact' &&
        r.request().method() === 'POST',
    );
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    const cr = await contactResponse;
    assert(cr.status() === 201);
    const cb = await cr.json();
    assert(cb.delivery === 'not_configured');
    await page.getByTestId('contact-delivery-outcome').waitFor();
    assert(!/sent successfully/i.test(await page.locator('main').innerText()));
    (proof.contacts as unknown[]).push({
      channel: 'firebase-browser',
      email: `browser-${run}@example.invalid`,
      response: cb,
      independentlyReadBack: false,
    });
    journal();
    await page.goto(new URL('/gap-scan', host).href);
    await page.locator('#sector').selectOption({ label: 'Other' });
    await page.locator('#emp').selectOption('1-50');
    await page.getByRole('button', { name: /Next/ }).click();
    assert(GAP_SCAN_QUESTIONS.length === 12);
    for (const q of GAP_SCAN_QUESTIONS) {
      const row = page
        .locator('div.rounded-md')
        .filter({ has: page.getByText(q.prompt, { exact: true }) });
      await row.getByRole('button', { name: 'No', exact: true }).click();
    }
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await page.getByRole('button', { name: 'Review', exact: true }).click();
    const submission = page.waitForResponse(
      (r) =>
        new URL(r.url()).origin === host.origin &&
        new URL(r.url()).pathname === '/api/gap-scan' &&
        r.request().method() === 'POST',
    );
    await page.getByRole('button', { name: 'Generate my report', exact: true }).click();
    const sr = await submission;
    assert(sr.ok());
    const sb = await sr.json();
    assert(/^[a-f0-9-]{36}$/.test(sb.id) && !('accessToken' in sb));
    privateCache(await sr.allHeaders());
    const headers = await sr.allHeaders(),
      setCookie = headers['set-cookie'] ?? '';
    assert(
      /__session=gap-scan\.[a-f0-9]{64}/.test(setCookie) &&
        /;\s*Secure/i.test(setCookie) &&
        !/;\s*Domain=/i.test(setCookie),
    );
    const cookie = (await context.cookies(host.href)).find((k) => k.name === '__session');
    assert(
      cookie &&
        cookie.httpOnly &&
        cookie.secure &&
        cookie.sameSite === 'Lax' &&
        cookie.domain === host.hostname &&
        cookie.path === '/',
    );
    await page.waitForURL(new URL(`/gap-scan/report/${sb.id}`, host).href, { timeout: 90000 });
    await page.getByText('Overall posture', { exact: true }).waitFor();
    const reload = await page.reload({ waitUntil: 'networkidle', timeout: 90000 });
    assert(reload && reload.ok());
    privateCache(await reload.allHeaders());
    save(resolve(output, 'actual-report.png'), await page.screenshot({ fullPage: true }));
    await page.setViewportSize({ width: 360, height: 900 });
    assert(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
    );
    save(resolve(output, 'actual-report-mobile.png'), await page.screenshot({ fullPage: true }));
    const stranger = await browser.newContext();
    const url = new URL(`/gap-scan/report/${sb.id}`, host).href;
    const anonymous = await stranger.request.get(url);
    assert(anonymous.status() === 404);
    privateCache(anonymous.headers());
    await stranger.addCookies([
      {
        name: '__session',
        value: `gap-scan.${'b'.repeat(64)}`,
        url: host.href,
        httpOnly: true,
        secure: true,
        sameSite: 'Lax',
      },
    ]);
    const wrong = await stranger.request.get(url);
    assert(wrong.status() === 404);
    privateCache(wrong.headers());
    assert(/^gap-scan\.[a-f0-9]{64}$/.test(cookie.value));
    save(
      resolve(output, 'report-capability.private.json'),
      JSON.stringify({
        project: c.project,
        releaseSha: c.releaseSha,
        approvalSha256: c.approvalSha256,
        reportId: sb.id,
        accessToken: cookie.value.slice('gap-scan.'.length),
        expiresAt: c.expiresAt,
      }),
    );
    proof.gapScans = [
      {
        id: sb.id,
        response: sb,
        questionIds: GAP_SCAN_QUESTIONS.map((q) => q.id),
        sessionCookie: {
          name: cookie.name,
          secure: cookie.secure,
          httpOnly: cookie.httpOnly,
          domain: cookie.domain,
          valueSha256: createHash('sha256').update(cookie.value).digest('hex'),
          accessProofSha256: createHash('sha256')
            .update(cookie.value.slice('gap-scan.'.length))
            .digest('hex'),
        },
        anonymousStatus: anonymous.status(),
        wrongCapabilityStatus: wrong.status(),
        independentlyReadBack: false,
      },
    ];
    assert(errors.length === 0 && writes.contact === 1 && writes.gapScan === 1);
    proof.status = 'browser-and-api-green-storage-and-lifecycle-pending';
    journal();
    await stranger.close();
    await context.close();
  } finally {
    await browser.close();
  }
  console.log(
    'Hosted marketing browser/API milestone passed; independent storage and lifecycle gates remain.',
  );
}
main().catch(() => {
  console.error(
    'Hosted marketing acceptance failed; protected partial evidence retained; no automatic retry or cleanup.',
  );
  process.exitCode = 1;
});
