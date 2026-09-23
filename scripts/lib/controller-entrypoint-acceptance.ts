/** Disposable fixture for the real controller entrypoint. No cloud calls or jobs.
 * Synthetic secrets enter only private stdin and owner-only Docker-volume files.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import type { vmControllerConfiguration } from '../../services/bff/src/workloads/assessment-vm.js';

type Configuration = z.output<typeof vmControllerConfiguration>;
const DIRECTORY = '/run/controller-secrets';

export async function verifyControllerEntrypoint(input: {
  image: string;
  config: Configuration;
  healthVolume: string;
  serviceKey: string;
  certificate: string;
  privateKey: string;
  daemonGroup: string;
  dockerHost: string;
}) {
  const prefix = `axiom-entrypoint-${randomUUID()}`;
  const network = `${prefix}-network`,
    volume = `${prefix}-files`;
  const proxy = `${prefix}-backend`,
    controller = `${prefix}-controller`;
  const containers = new Set<string>();
  let phase = 'setup';
  let networkCreated = false,
    volumeCreated = false;
  const outcomes: Record<string, boolean> = {};
  async function docker(args: string[], data?: string, timeout = 30000) {
    const child = spawn('docker', ['--host', input.dockerHost, ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return new Promise<{ code: number | null; stdout: string; stderr: string }>((done, reject) => {
      let stdout = '',
        stderr = '',
        failed = false;
      const timer = setTimeout(() => {
        failed = true;
        child.kill('SIGKILL');
        reject(new Error('Entrypoint fixture deadline'));
      }, timeout);
      child.once('error', () => {
        failed = true;
        clearTimeout(timer);
        reject(new Error('Entrypoint fixture transport refused'));
      });
      child.stdout.on('data', (part: Buffer) => {
        stdout += part.toString();
        if (stdout.length > 65536) child.kill('SIGKILL');
      });
      child.stderr.on('data', (part: Buffer) => {
        stderr += part.toString();
        if (stderr.length > 65536) child.kill('SIGKILL');
      });
      child.stdin.on('error', () => {});
      child.once('close', (code) => {
        clearTimeout(timer);
        if (!failed) done({ code, stdout, stderr });
      });
      child.stdin.end(data);
    });
  }
  async function required(args: string[], data?: string, timeout?: number) {
    const result = await docker(args, data, timeout);
    if (result.code !== 0) throw new Error('Entrypoint fixture operation refused');
    return result.stdout;
  }
  const fileMount = `type=volume,src=${volume},dst=${DIRECTORY},readonly,volume-nocopy`;
  const protection = [
    '--read-only',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges:true',
    '--log-driver',
    'none',
    '--pids-limit',
    '128',
    '--memory',
    '512m',
  ];
  const service = {
    controller: {
      ...input.config,
      scheduler: { ...input.config.scheduler, audience: 'https://controller.fixture.test:8443' },
    },
    listen: { host: '0.0.0.0', port: 8443 },
    tls: { keyFile: `${DIRECTORY}/tls.key`, certFile: `${DIRECTORY}/tls.crt` },
    backendServiceKeyFile: `${DIRECTORY}/backend.key`,
  };
  const launch = (name: string, mode: '--check' | '--serve', config = 'service.json') => [
    'run',
    '--name',
    name,
    '--pull',
    'never',
    ...protection,
    '--network',
    network,
    '--network-alias',
    'controller.fixture.test',
    '--user',
    '20000:20000',
    '--group-add',
    input.daemonGroup,
    '--env',
    'AXIOM_REGION=ap-south-1',
    '--env',
    'SUPABASE_URL=https://backend.fixture.test:8443',
    '--env',
    `NODE_EXTRA_CA_CERTS=${DIRECTORY}/tls.crt`,
    '--mount',
    fileMount,
    '--mount',
    'type=bind,src=/var/run/docker.sock,dst=/run/docker.sock',
    '--mount',
    `type=volume,src=${input.config.launcher.workloadApiVolume},dst=/run/workload,readonly,volume-nocopy`,
    '--mount',
    `type=volume,src=${input.healthVolume},dst=/run/spire-health,readonly,volume-nocopy`,
    input.image,
    mode,
    `${DIRECTORY}/${config}`,
  ];
  try {
    await required(['network', 'create', '--internal', network]);
    networkCreated = true;
    await required(['volume', 'create', volume]);
    volumeCreated = true;
    const writer = `${prefix}-writer`;
    containers.add(writer);
    await required(
      [
        'run',
        '--rm',
        '--name',
        writer,
        '--pull',
        'never',
        '-i',
        '--network',
        'none',
        ...protection,
        '--cap-add',
        'CHOWN',
        '--user',
        '0:0',
        '--mount',
        `type=volume,src=${volume},dst=${DIRECTORY},volume-nocopy`,
        '--entrypoint',
        'node',
        input.image,
        '-e',
        `const fs=require('node:fs');const values=JSON.parse(fs.readFileSync(0,'utf8'));for(const [name,value] of Object.entries(values)){const p='${DIRECTORY}/'+name;fs.writeFileSync(p,value,{mode:0o400,flag:'wx'});fs.chownSync(p,20000,20000);}process.stdout.write('prepared');`,
      ],
      JSON.stringify({
        'service.json': JSON.stringify(service),
        'wrong-host.json': JSON.stringify({
          ...service,
          controller: {
            ...service.controller,
            scheduler: {
              ...service.controller.scheduler,
              audience: 'https://foreign.fixture.test:8443',
            },
          },
        }),
        'foreign-node.json': JSON.stringify({
          ...service,
          controller: {
            ...service.controller,
            issuerNodeId: service.controller.issuerNodeId + '-foreign',
          },
        }),
        'backend.key': input.serviceKey,
        'tls.key': input.privateKey,
        'tls.crt': input.certificate,
      }),
    );
    containers.add(proxy);
    await required([
      'run',
      '-d',
      '--name',
      proxy,
      '--pull',
      'never',
      ...protection,
      '--network',
      network,
      '--network-alias',
      'backend.fixture.test',
      '--add-host',
      'host.docker.internal:host-gateway',
      '--user',
      '20000:20000',
      '--mount',
      fileMount,
      '--entrypoint',
      'node',
      input.image,
      '-e',
      `const fs=require('node:fs'),https=require('node:https'),http=require('node:http');let reads=0,refused=0;const server=https.createServer({key:fs.readFileSync('${DIRECTORY}/tls.key'),cert:fs.readFileSync('${DIRECTORY}/tls.crt')},(req,res)=>{if(req.method==='GET'&&req.url==='/ready'){res.writeHead(204).end();return;}if(req.method==='GET'&&req.url==='/observations'){res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({reads,refused}));return;}if(req.method!=='GET'||!(req.url.startsWith('/rest/v1/assessment_dispatch_key_policies?')||req.url==='/rest/v1/rpc/current_assessment_controller_tenant')){refused++;res.writeHead(405).end();return;}reads++;const upstream=http.request({hostname:'host.docker.internal',port:56321,path:req.url,method:'GET',headers:req.headers,timeout:5000},reply=>{res.writeHead(reply.statusCode,reply.headers);reply.pipe(res);});upstream.on('error',()=>{if(!res.headersSent)res.writeHead(503);res.end();});upstream.on('timeout',()=>upstream.destroy());req.pipe(upstream);});server.listen(8443,'0.0.0.0');`,
    ]);
    await required(['network', 'connect', 'bridge', proxy]);
    phase = 'backend-ready';
    const ready = `${prefix}-ready`;
    containers.add(ready);
    let backendReady = false;
    for (let attempt = 0; attempt < 12; attempt++) {
      const checked = await docker(
        [
          'run',
          '--rm',
          '--name',
          ready,
          '--pull',
          'never',
          ...protection,
          '--network',
          network,
          '--user',
          '20000:20000',
          '--mount',
          fileMount,
          '--entrypoint',
          'node',
          input.image,
          '-e',
          `const https=require('node:https'),fs=require('node:fs');const req=https.get('https://backend.fixture.test:8443/ready',{ca:fs.readFileSync('${DIRECTORY}/tls.crt'),timeout:3000},res=>{res.resume();res.on('end',()=>process.exit(res.statusCode===204?0:1));});req.on('error',()=>process.exit(2));req.on('timeout',()=>req.destroy());`,
        ],
        undefined,
        15000,
      );
      if (checked.code === 0) {
        backendReady = true;
        break;
      }
      await new Promise((done) => setTimeout(done, 250));
    }
    assert.equal(backendReady, true);
    phase = 'startup-check';
    const check = `${prefix}-check`;
    containers.add(check);
    const checked = await required(launch(check, '--check'), undefined, 45000);
    assert.equal(checked, 'Controller configuration and read-only startup checks passed.\n');
    outcomes['vm-entrypoint-protected-files-real-https-backend-and-live-trust'] = true;
    for (const [file, label] of [
      ['wrong-host.json', 'tls-host-mismatch'],
      ['foreign-node.json', 'foreign-node'],
    ] as const) {
      phase = label;
      const name = `${prefix}-${label}`;
      containers.add(name);
      const refused = await docker(launch(name, '--check', file), undefined, 45000);
      assert.notEqual(refused.code, 0);
      assert.equal(refused.stdout, '');
      assert.equal(refused.stderr, 'VM assessment controller startup refused.\n');
      outcomes[`vm-entrypoint-${label}-refused`] = true;
    }
    const chmod = async (mode: number) => {
      const name = `${prefix}-mode-${mode}`;
      containers.add(name);
      await required([
        'run',
        '--rm',
        '--name',
        name,
        '--pull',
        'never',
        '--network',
        'none',
        ...protection,
        '--user',
        '20000:20000',
        '--mount',
        `type=volume,src=${volume},dst=${DIRECTORY},volume-nocopy`,
        '--entrypoint',
        'node',
        input.image,
        '-e',
        `require('node:fs').chmodSync('${DIRECTORY}/backend.key',${mode})`,
      ]);
    };
    phase = 'unsafe-file';
    await chmod(0o644);
    const unsafe = `${prefix}-unsafe-file`;
    containers.add(unsafe);
    const refused = await docker(launch(unsafe, '--check'), undefined, 45000);
    assert.notEqual(refused.code, 0);
    assert.equal(refused.stdout, '');
    assert.equal(refused.stderr, 'VM assessment controller startup refused.\n');
    outcomes['vm-entrypoint-unsafe-backend-file-refused'] = true;
    await chmod(0o400);
    phase = 'serve';
    containers.add(controller);
    const args = launch(controller, '--serve');
    args.splice(1, 0, '-d');
    await required(args);
    const probe = `${prefix}-probe`;
    containers.add(probe);
    let reachable = false;
    for (let attempt = 0; attempt < 12; attempt++) {
      const response = await docker(
        [
          'run',
          '--rm',
          '--name',
          probe,
          '--pull',
          'never',
          ...protection,
          '--network',
          network,
          '--user',
          '20000:20000',
          '--mount',
          fileMount,
          '--entrypoint',
          'node',
          input.image,
          '-e',
          `const https=require('node:https'),fs=require('node:fs');const req=https.request('https://controller.fixture.test:8443/assessment/run',{method:'POST',ca:fs.readFileSync('${DIRECTORY}/tls.crt'),headers:{authorization:'Bearer synthetic.invalid.proof','content-type':'application/json'},timeout:3000},res=>{res.resume();res.on('end',()=>process.exit(res.statusCode===503?0:1));});req.on('error',()=>process.exit(2));req.on('timeout',()=>req.destroy());req.end(JSON.stringify({tenantId:'${input.config.tenantId}',jobId:'${randomUUID()}'}));`,
        ],
        undefined,
        15000,
      );
      if (response.code === 0) {
        reachable = true;
        break;
      }
      await new Promise((done) => setTimeout(done, 250));
    }
    assert.equal(reachable, true);
    outcomes['vm-entrypoint-real-private-tls-listener-refuses-invalid-identity'] = true;
    phase = 'environment';
    const environment = JSON.parse(
      await required(['inspect', '--format', '{{json .Config.Env}}', controller]),
    ) as string[];
    for (const value of [
      input.serviceKey,
      JSON.parse(input.serviceKey).accessToken,
      input.privateKey,
    ])
      assert(environment.every((entry) => !entry.includes(value)));
    outcomes['vm-entrypoint-container-env-excludes-backend-and-tls-secrets'] = true;
    phase = 'backend-observations';
    const observations = `${prefix}-observations`;
    containers.add(observations);
    await required([
      'run',
      '--rm',
      '--name',
      observations,
      '--pull',
      'never',
      ...protection,
      '--network',
      network,
      '--user',
      '20000:20000',
      '--mount',
      fileMount,
      '--entrypoint',
      'node',
      input.image,
      '-e',
      `const https=require('node:https'),fs=require('node:fs');const req=https.get('https://backend.fixture.test:8443/observations',{ca:fs.readFileSync('${DIRECTORY}/tls.crt'),timeout:3000},res=>{let wire='';res.on('data',part=>{wire+=part;if(wire.length>1024)process.exit(1);});res.on('end',()=>{try{const value=JSON.parse(wire);process.exit(res.statusCode===200&&value.reads>=2&&value.refused===0?0:1);}catch{process.exit(1);}});});req.on('error',()=>process.exit(2));req.on('timeout',()=>req.destroy());`,
    ]);
    phase = 'shutdown';
    await required(['stop', '--time', '90', controller], undefined, 100000);
    const stopped = JSON.parse(
      await required(['inspect', '--format', '{{json .State}}', controller]),
    ) as { Running: boolean; ExitCode: number };
    assert.equal(stopped.Running, false);
    assert.equal(stopped.ExitCode, 0);
    outcomes['vm-entrypoint-sigterm-stops-cleanly'] = true;
    return outcomes;
  } catch {
    throw new Error('Controller entrypoint fixture refused at ' + phase);
  } finally {
    for (const name of containers) await docker(['rm', '-f', name]);
    if (volumeCreated) await docker(['volume', 'rm', volume]);
    if (networkCreated) await docker(['network', 'rm', network]);
    const remaining = (
      await required([
        'container',
        'ls',
        '--all',
        '--filter',
        `name=^/${prefix}-`,
        '--format',
        '{{.Names}}',
      ])
    ).trim();
    assert.equal(remaining, '');
    assert(
      !(await required(['volume', 'ls', '--format', '{{.Name}}'])).split('\n').includes(volume),
    );
    assert(
      !(await required(['network', 'ls', '--format', '{{.Name}}'])).split('\n').includes(network),
    );
  }
}
