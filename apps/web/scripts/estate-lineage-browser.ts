/** Controlled read-only browser projection; synthetic rows, no live account,
 * database authority/ledger verification or retained acceptance implied. */
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { mkdtemp, writeFile, rm, stat, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { chromium } from './marketing-acceptance-browser';
async function main() {
  const proof = process.argv[2];
  if (!proof || resolve(proof) !== proof)
    throw new Error('Owned absolute proof directory required');
  const metadata = await stat(proof);
  if (
    !metadata.isDirectory() ||
    (metadata.mode & 0o777) !== 0o700 ||
    metadata.uid !== process.getuid?.()
  )
    throw new Error('Owned0700 proof directory required');
  const root = resolve('apps/web'),
    require = createRequire(join(root, 'package.json'));
  const bundler = createRequire(require.resolve('tsx/package.json'))('esbuild') as {
    build(input: Record<string, unknown>): Promise<{ outputFiles: { text: string }[] }>;
  };
  const temporary = await mkdtemp(join(tmpdir(), 'axiom-estate-lineage-browser-'));
  let server: ReturnType<typeof createServer> | undefined,
    browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    await writeFile(
      join(temporary, 'navigation.ts'),
      `export const useRouter=()=>({refresh:()=>{}});`,
    );
    await writeFile(
      join(temporary, 'link.tsx'),
      `export default function Link(p){return <a href={p.href}>{p.children}</a>}`,
    );
    const entry = `import{createRoot}from'react-dom/client';import{EstateGraph}from${JSON.stringify(join(root, 'src/app/(app)/estate/graph/estate-graph-client.tsx'))};import{projectApprovedDerivation}from${JSON.stringify(join(root, 'src/lib/estate-graph-provenance.ts'))};
const id=n=>'10000000-0000-4000-8000-'+String(n).padStart(12,'0'),when='2026-10-19T00:00:00Z',hash='a'.repeat(64);
const systems=[{id:id(3),estateId:id(2),name:'Synthetic payroll',status:'active',categories:['identity'],categoryOrigins:[{category:'identity',source:'observed'}]}];
const proposals=[{id:id(4),tenant_id:id(1),estate_id:id(2),content_sha256:hash,status:'approved',reviewed_at:when,onboarding_proposal_systems:[{tenant_id:id(1),proposal_id:id(4),source_index:0,system_id:id(3)}]}];
const receipts=[{id:'123',tenant_id:id(1),target_ref:id(4),actor_type:'human',action_type:'onboarding.proposal.approved',result:'success',occurred_at:when,commitment:hash,system_ids:[id(3)]}];
const readonly=new URL(location.href).searchParams.has('readonly');
createRoot(document.getElementById('root')).render(<EstateGraph snapshot={{tenantName:'Synthetic browser fixture',capturedAt:when}} input={{agents:[],estates:[{id:id(2),name:'Synthetic estate',status:'active'}],systems,connectors:[],grants:[],provenance:projectApprovedDerivation(id(1),systems,proposals,receipts,!readonly)}}/>);`;
    const built = await bundler.build({
      stdin: { contents: entry, resolveDir: root, loader: 'tsx' },
      bundle: true,
      write: false,
      platform: 'browser',
      format: 'iife',
      jsx: 'automatic',
      nodePaths: [join(root, 'node_modules'), resolve('node_modules')],
      alias: {
        'next/link': join(temporary, 'link.tsx'),
        'next/navigation': join(temporary, 'navigation.ts'),
        '@': join(root, 'src'),
      },
      define: { 'process.env.NODE_ENV': '"test"' },
    });
    const js = built.outputFiles[0]?.text;
    if (!js) throw new Error('Controlled graph bundle missing');
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
    if (!address || typeof address === 'string') throw new Error('Owned listener unavailable');
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 960 } });
    await page.goto(`http://127.0.0.1:${address.port}`);
    await page.getByRole('button', { name: 'system Synthetic payroll' }).click();
    await page.getByText(/Approval receipt 123/).waitFor();
    await page.getByText(/Recorded as observed \(scan evidence not linked\)/).waitFor();
    const href = await page
      .getByRole('link', { name: 'Open approved onboarding source' })
      .getAttribute('href');
    if (href !== '/estate/onboarding#proposal-10000000-0000-4000-8000-000000000004')
      throw new Error('Source navigation scope changed');
    const nodes = await page.locator('[data-node]').count(),
      edges = await page.locator('[data-edge]').count();
    const screenshot = join(proof, 'approved-creation-source.private.png');
    await page.screenshot({ path: screenshot, fullPage: true });
    await chmod(screenshot, 0o600);
    await page.goto(`http://127.0.0.1:${address.port}/?readonly`);
    await page.getByRole('button', { name: 'system Synthetic payroll' }).click();
    await page.getByText(/Approval receipt 123/).waitFor();
    if (await page.getByRole('link', { name: 'Open approved onboarding source' }).count())
      throw new Error('Unavailable role offered a source link');
    if (
      (await page.locator('[data-node]').count()) !== nodes ||
      (await page.locator('[data-edge]').count()) !== edges
    )
      throw new Error('Provenance changed graph topology');
    await writeFile(
      join(proof, 'estate-lineage-browser.private.json'),
      JSON.stringify(
        {
          kind: 'controlled_estate_lineage_browser',
          actualChromium: true,
          actualProjectionAndGraphClient: true,
          syntheticRows: true,
          liveAccountDatabaseAcceptance: false,
          metadataReadableWithoutSourcePermission: true,
          sourceHref: href,
          nodes,
          edges,
          categoryObservationNotPromotedToVerified: true,
          noGraphTopologyChange: true,
          noProviderOrDatabaseWrites: true,
        },
        null,
        2,
      ) + '\n',
      { mode: 0o600 },
    );
    console.log(
      'Controlled read-only graph lineage browser passed; synthetic source boundary explicit.',
    );
  } finally {
    await browser?.close();
    if (server)
      await new Promise<void>((done, fail) => server!.close((e) => (e ? fail(e) : done())));
    await rm(temporary, { recursive: true, force: true });
  }
}
void main();
