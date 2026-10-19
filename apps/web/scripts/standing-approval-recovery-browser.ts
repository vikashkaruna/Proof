/** Controlled browser boundary only: synthetic HTTP receipts/MFA, no account,
 * server-authority/native/runtime acceptance or deployment enablement implied. */
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile, rm, stat, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { chromium } from './marketing-acceptance-browser';
import { encodeStandingRevisionIntent } from '@axiom/types';
import { fixture, id, binding } from '../src/app/(app)/approvals/standing/standing.test-fixture';
import { journalKey, journalText } from '../src/app/(app)/approvals/standing/standing-journal';
async function main() {
  const directory = process.argv[2];
  if (!directory || resolve(directory) !== directory)
    throw new Error('Owned absolute proof directory required');
  const mode = await stat(directory);
  if (!mode.isDirectory() || (mode.mode & 0o777) !== 0o700 || mode.uid !== process.getuid?.())
    throw new Error('Owned0700 proof directory required');
  const require = createRequire(resolve('apps/web/package.json'));
  const bundler = createRequire(require.resolve('tsx/package.json'))('esbuild') as {
    build(input: Record<string, unknown>): Promise<{ outputFiles: { text: string }[] }>;
  };
  const temporary = await mkdtemp(join(tmpdir(), 'axiom-standing-browser-'));
  const { journal, context } = fixture(),
    key = journalKey(journal.tenantId, journal.actorId),
    text = journalText(journal);
  const commitment = createHash('sha256')
    .update(encodeStandingRevisionIntent(journal.intent))
    .digest('hex');
  let server: ReturnType<typeof createServer> | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    await writeFile(
      join(temporary, 'link.tsx'),
      `export default function Link(p){return <a href={p.href}>{p.children}</a>}`,
    );
    const entry = `import{createRoot}from'react-dom/client';import{StandingApprovalClient}from${JSON.stringify(resolve('apps/web/src/app/(app)/approvals/standing/standing-client.tsx'))};createRoot(document.getElementById('root')).render(<StandingApprovalClient tenantId=${JSON.stringify(journal.tenantId)} actorId={new URL(location.href).searchParams.has('reviewer')?${JSON.stringify(id(2))}:${JSON.stringify(journal.actorId)}}/>);`;
    const built = await bundler.build({
      stdin: { contents: entry, resolveDir: resolve('apps/web'), loader: 'tsx' },
      bundle: true,
      write: false,
      platform: 'browser',
      nodePaths: [resolve('apps/web/node_modules'), resolve('node_modules')],
      format: 'iife',
      jsx: 'automatic',
      alias: { 'next/link': join(temporary, 'link.tsx'), '@': resolve('apps/web/src') },
      define: { 'process.env.NODE_ENV': '"test"' },
    });
    const js = built.outputFiles[0]?.text;
    if (!js) throw new Error('Controlled browser bundle missing');
    server = createServer((req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      if (req.url === '/fixture.js') {
        res.setHeader('Content-Type', 'text/javascript');
        res.end(js);
      } else {
        res.setHeader('Content-Type', 'text/html');
        res.end(
          '<!doctype html><html data-display-tz="Asia/Kolkata"><body><div id="root"></div><script src="/fixture.js"></script></body></html>',
        );
      }
    });
    await new Promise<void>((done) => server!.listen(0, '127.0.0.1', done));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Owned fixture listener missing');
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 960 } });
    await page.addInitScript(
      ({ key, text }) => {
        if (!localStorage.getItem(key) && !localStorage.getItem(key + ':seeded')) {
          localStorage.setItem(key, text);
          localStorage.setItem(key + ':seeded', 'true');
        }
      },
      { key, text },
    );
    let recorded = false,
      recordCalls = 0,
      challengeCalls = 0,
      verifyCalls = 0;
    await page.route('**/api/bff/v1/standing-approvals**', async (route) => {
      const request = route.request(),
        url = new URL(request.url());
      if (
        request.headers()['x-expected-actor-id'] !== journal.actorId ||
        request.headers()['x-tenant-id'] !== journal.tenantId
      )
        throw new Error('Browser lost actor/tenant request binding');
      if (request.method() === 'GET') {
        await route.fulfill({ json: { data: context } });
        return;
      }
      const body = request.postDataJSON() as Record<string, unknown>;
      if (
        encodeStandingRevisionIntent(body.intent as typeof journal.intent) !==
        encodeStandingRevisionIntent(journal.intent)
      )
        throw new Error('Browser changed original intent');
      if (url.pathname.endsWith('/recover'))
        await route.fulfill({
          json: {
            data: recorded
              ? {
                  ...binding(journal),
                  recorded: true,
                  requestSha256: commitment,
                  revisionId: id(30),
                  state: 'reviewed',
                  receiptId: '123',
                }
              : {
                  ...binding(journal),
                  recorded: false,
                  requestSha256: commitment,
                  fenced: false,
                  fenceReceiptId: null,
                  challengeExpiresAt: null,
                },
          },
        });
      else if (url.pathname.endsWith('/challenge')) {
        challengeCalls++;
        await route.fulfill({
          json: {
            data: { challengeId: id(50), expiresAt: new Date(Date.now() + 300000).toISOString() },
          },
        });
      } else if (url.pathname.endsWith('/verify')) {
        verifyCalls++;
        await route.fulfill({ json: { data: { verified: true, challengeId: id(50) } } });
      } else if (url.pathname.endsWith('/record')) {
        recordCalls++;
        recorded = true;
        await route.abort('failed');
      } else throw new Error('Unexpected browser fixture request');
    });
    await page.goto(`http://127.0.0.1:${address.port}`);
    await page.getByRole('button', { name: 'Prepare authenticator challenge' }).click();
    await page.getByLabel('Authenticator code').fill('111222');
    await page.getByRole('button', { name: 'Verify authenticator code' }).click();
    await page.getByRole('button', { name: 'Record original request' }).click();
    await page.getByRole('alert').filter({ hasText: 'Outcome uncertain' }).waitFor();
    const retained = await page.evaluate((key) => localStorage.getItem(key), key);
    if (!retained || retained.includes('111222'))
      throw new Error('Code leaked or original request missing');
    await page.reload();
    await page.getByRole('button', { name: 'Recover original request' }).click();
    await page.getByRole('status').filter({ hasText: 'Recorded receipt 123' }).waitFor();
    if (
      (await page.evaluate((key) => localStorage.getItem(key), key)) !== retained ||
      recordCalls !== 1 ||
      challengeCalls !== 1 ||
      verifyCalls !== 1
    )
      throw new Error('Reload changed/repeated the original decision');
    const screenshot = join(directory, 'standing-original-recovery.private.png');
    await page.screenshot({ path: screenshot, fullPage: true });
    await chmod(screenshot, 0o600);
    await page
      .getByRole('button', { name: 'Archive confirmed receipt and prepare another decision' })
      .click();
    await page
      .getByRole('heading', { name: '1. Owner: select an eligible measured scope' })
      .waitFor();
    const archived = await page.evaluate(
      ({ key }) => ({
        active: localStorage.getItem(key),
        archive: localStorage.getItem(key + ':archive:10000000-0000-4000-8000-000000000030'),
      }),
      { key },
    );
    if (archived.active !== null || !archived.archive?.includes('123'))
      throw new Error('Original receipt was not preserved before replacement');
    if (journal.intent.phase !== 'request') throw new Error('Synthetic request fixture required');
    const reviewer = await browser.newPage({ viewport: { width: 1280, height: 960 } });
    await reviewer.route('**/api/bff/v1/standing-approvals', async (route) => {
      if (route.request().headers()['x-expected-actor-id'] !== id(2))
        throw new Error('Reviewer account binding missing');
      await route.fulfill({
        json: {
          data: {
            ...context,
            actorId: id(2),
            candidates: [],
            revisions: [
              {
                revisionId: id(30),
                requestSha256: commitment,
                request: journal.intent.request,
                state: 'requested',
                ownerReceiptId: '123',
                reviewerReceiptId: null,
              },
            ],
          },
        },
      });
    });
    await reviewer.goto(`http://127.0.0.1:${address.port}/?reviewer`);
    await reviewer
      .getByLabel('Decision reason (20–2,000 characters)')
      .fill('Reviewed exact synthetic scope and one-authorization bound.');
    await reviewer.getByLabel('I reviewed this exact revision and measured scope.').check();
    await reviewer.getByRole('button', { name: 'Retain approval of revision 10000000' }).click();
    await reviewer
      .getByRole('heading', { name: 'Recover or confirm your retained approve' })
      .waitFor();
    const reviewerIntent = await reviewer.evaluate(
      (key) => localStorage.getItem(key),
      journalKey(journal.tenantId, id(2)),
    );
    if (!reviewerIntent || JSON.parse(reviewerIntent).intent.phase !== 'approve')
      throw new Error('Named reviewer original intent missing');
    const reviewerShot = join(directory, 'standing-named-reviewer.private.png');
    await reviewer.screenshot({ path: reviewerShot, fullPage: true });
    await chmod(reviewerShot, 0o600);
    await writeFile(
      join(directory, 'standing-browser-proof.private.json'),
      JSON.stringify(
        {
          kind: 'controlled_standing_browser_recovery',
          actualChromium: true,
          namedReviewerScopeRetained: true,
          actualUiAndFetchTransport: true,
          realWebLocksAndStorage: true,
          syntheticHttpAuthorityAndMfa: true,
          liveAccountOrNativeAcceptance: false,
          recordCalls,
          challengeCalls,
          verifyCalls,
          originalRetainedAfterLostReply: true,
          noCodePersisted: true,
          originalReceiptArchivedBeforeReplacement: true,
          sourceSha256: createHash('sha256')
            .update(
              await readFile(
                resolve('apps/web/src/app/(app)/approvals/standing/standing-client.tsx'),
              ),
            )
            .digest('hex'),
        },
        null,
        2,
      ) + '\n',
      { mode: 0o600 },
    );
    console.log(
      'Controlled standing browser recovery passed; synthetic authority boundary explicit.',
    );
  } finally {
    await browser?.close();
    if (server)
      await new Promise<void>((done, fail) => server!.close((e) => (e ? fail(e) : done())));
    await rm(temporary, { recursive: true, force: true });
  }
}
void main();
