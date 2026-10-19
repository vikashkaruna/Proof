/** Owned engineering fixture: actual private controller, Python processes and
 * PostgreSQL journals. Synthetic human/SVID issuer adapters are explicit;
 * this does not qualify deployed GoTrue/SPIRE enrollment or UID Unix daemon. */
import { spawn, execFileSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { generateKeyPairSync, sign, createHash, randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Hono } from 'hono';
import { PrativedanPrivateController } from '../src/workloads/prativedan-private-controller.js';
import { prativedanContainerFactory } from '../src/workloads/prativedan-container.js';
import { prativedanAccountedDraftRoutes } from '../src/routes/prativedan-accounted-drafts.js';
import type { Variables } from '../src/types.js';
import type { MfaService } from '../src/services/mfa.js';
import type { PrativedanAssessmentRpcClient } from '../src/services/prativedan-assessment-draft-store.js';
import { z } from 'zod';

const [cid, image, proofDirectory, maliciousImage] = process.argv.slice(2);
if (
  !cid ||
  !/^[a-f0-9]{64}$/.test(cid) ||
  !image ||
  !/^sha256:[a-f0-9]{64}$/.test(image) ||
  !proofDirectory ||
  resolve(proofDirectory) !== proofDirectory
)
  throw new Error('owned fixture arguments refused');
const docker = '/usr/local/bin/docker';
const endpoint = 'unix:///var/run/docker.sock';
const cliEnv = {
  PATH: '/usr/local/bin:/usr/bin:/bin',
  DOCKER_CONFIG: '/nonexistent/axiom-docker-config',
};
const cli = (args: string[]) =>
  execFileSync(docker, ['--host', endpoint, ...args], {
    encoding: 'utf8',
    timeout: 5000,
    maxBuffer: 4 * 1024 * 1024,
    env: cliEnv,
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
const owner = JSON.parse(cli(['inspect', '--format', '{{json .Config.Labels}}', cid])) as Record<
  string,
  string
>;
if (
  owner['com.axiom.fixture'] !== 'database-policy-test' ||
  owner['com.axiom.fixture.project'] !== 'axiom-db-tests' ||
  owner['com.axiom.owner-worktree'] !== process.cwd()
)
  throw new Error('foreign fixture refused');
const identity = (n: number) => `51230000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const tenantId = identity(11),
  actorId = identity(1),
  sessionId = identity(95),
  engagementId = identity(21);

class NativePeer {
  child: ChildProcessWithoutNullStreams;
  private pending:
    | { lines: string[]; marker: string; done: (value: unknown) => void; fail: () => void }
    | undefined;
  private queued: Promise<unknown> = Promise.resolve();
  private buffer = '';
  constructor() {
    this.child = spawn(
      docker,
      [
        '--host',
        endpoint,
        'exec',
        '-i',
        cid!,
        'psql',
        '-X',
        '-U',
        'supabase_admin',
        '-d',
        'axiom_proof_local',
        '-v',
        'ON_ERROR_STOP=1',
        '-Atq',
      ],
      { stdio: ['pipe', 'pipe', 'pipe'], env: cliEnv },
    );
    this.child.stderr.resume();
    this.child.stdin.on('error', () => this.pending?.fail());
    this.child.on('error', () => this.pending?.fail());
    this.child.stdout.on('data', (raw: Buffer) => {
      this.buffer += raw.toString('utf8');
      if (this.buffer.length > 8 * 1024 * 1024) {
        this.pending?.fail();
        return;
      }
      let at: number;
      while ((at = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, at);
        this.buffer = this.buffer.slice(at + 1);
        const pending = this.pending;
        if (!pending) continue;
        if (line === pending.marker) {
          this.pending = undefined;
          try {
            if (pending.lines.length !== 1) throw new Error();
            pending.done(JSON.parse(pending.lines[0]!));
          } catch {
            pending.fail();
          }
        } else if (line) pending.lines.push(line);
      }
    });
    this.child.on('close', () => this.pending?.fail());
    // Keep task proof, source and synthetic JWT arguments out of server logs.
    this.child.stdin.write('set log_min_error_statement=panic;set log_error_verbosity=terse;\n');
  }
  query(sql: string): Promise<unknown> {
    const next = this.queued.then(
      () =>
        new Promise<unknown>((done, reject) => {
          const marker = 'fixture_' + randomUUID().replaceAll('-', '');
          const timer = setTimeout(() => {
            reject(new Error('native scoped query unconfirmed'));
            this.child.kill();
          }, 15000);
          this.pending = {
            marker,
            lines: [],
            done: (v) => {
              clearTimeout(timer);
              done(v);
            },
            fail: () => {
              clearTimeout(timer);
              reject(new Error('native scoped query refused'));
            },
          };
          this.child.stdin.write(sql + `\n\\echo ${marker}\n`);
        }),
    );
    this.queued = next.catch(() => undefined);
    return next;
  }
  writer(
    role: 'human_action_writer' | 'axiom_prativedan_controller',
  ): PrativedanAssessmentRpcClient {
    return {
      rpc: (name, args) => ({
        abortSignal: async () => {
          const literal = (v: string) => "'" + v.replaceAll("'", "''") + "'";
          const value = await this.query(
            `begin;do $fixture$ begin perform set_config('request.jwt.claims',p172_fixture.controller_claims(),true);end $fixture$;set local role ${role};select p172_fixture.rpc(${literal(name)},${literal(JSON.stringify(args))}::jsonb);commit;`,
          );
          if (value && typeof value === 'object' && 'fixture_error' in value) {
            rpcErrors.push({ name, code: value.fixture_error });
            return { data: null, error: { code: value.fixture_error } };
          }
          return { data: value, error: null };
        },
      }),
    };
  }
  close() {
    this.child.stdin.end('\\q\n');
  }
}
const peer = new NativePeer();
const rpcErrors: { name: string; code: unknown }[] = [];
const owned: {
  id: string;
  role: string;
  childUid: number;
  networkNone: boolean;
  noMounts: boolean;
  emptySupplementaryGroups: boolean;
}[] = [];
let rendererImage = image!;
const launch = (role: 'computation' | 'renderer') => {
  return () => {
    const selectedImage = role === 'renderer' ? rendererImage : image!;
    const factory = prativedanContainerFactory(
      {
        executable: docker,
        dockerHost: endpoint,
        image: selectedImage,
        resourcePrefix: 'axiom-proof-local-prativedan',
      },
      role,
    );
    const child = factory();
    const name = child.spawnargs[child.spawnargs.indexOf('--name') + 1];
    if (!name?.startsWith(`axiom-proof-local-prativedan-${role}-`))
      throw new Error('owned worker name refused');
    let meta:
      | {
          id: string;
          image: string;
          network: string;
          readonly: boolean;
          mounts: number;
          labels: Record<string, string>;
        }
      | undefined;
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && !meta) {
      try {
        meta = JSON.parse(
          cli([
            'inspect',
            '--format',
            '{"id":{{json .Id}},"image":{{json .Image}},"network":{{json .HostConfig.NetworkMode}},"readonly":{{json .HostConfig.ReadonlyRootfs}},"mounts":{{len .Mounts}},"labels":{{json .Config.Labels}}}',
            name,
          ]),
        );
      } catch {}
    }
    if (
      !meta ||
      meta.image !== selectedImage ||
      meta.network !== 'none' ||
      !meta.readonly ||
      meta.mounts !== 0 ||
      meta.labels['com.axiom.role'] !== `prativedan-${role}`
    )
      throw new Error('worker confinement refused');
    const uid = role === 'renderer' ? 20006 : 20107;
    const ownedRow = {
      id: meta.id,
      role,
      childUid: uid,
      networkNone: true,
      noMounts: true,
      emptySupplementaryGroups: false,
    };
    owned.push(ownedRow);
    const probe = `import pathlib,json\nrows=[]\nfor p in pathlib.Path('/proc').glob('[0-9]*/status'):\n try:\n  s=p.read_text();cmd=(p.parent/'cmdline').read_bytes()\n  if b'axiom.prativedan_${role === 'renderer' ? 'pure_worker' : 'accounted_process'}' in cmd:\n   rows.append({'uid':int(next(x for x in s.splitlines() if x.startswith('Uid:')).split()[1]),'groups':next(x for x in s.splitlines() if x.startswith('Groups:')).split()[1:]})\n except (FileNotFoundError,ProcessLookupError,PermissionError):pass\nprint(json.dumps({'found':any(x['uid']==${uid} and x['groups']==[] for x in rows)}))`;
    let confirmed = false;
    while (Date.now() < deadline && !confirmed) {
      try {
        confirmed =
          JSON.parse(
            cli(['exec', meta.id, '/app/services/agent-runtime/.venv/bin/python', '-c', probe]),
          ).found === true;
      } catch {}
    }
    if (!confirmed) throw new Error('actual worker UID/group refused');
    ownedRow.emptySupplementaryGroups = true;
    return child;
  };
};
const keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
const jwt = (claims: Record<string, unknown>) => {
  const now = Math.floor(Date.now() / 1000),
    body =
      encode({ alg: 'ES256', typ: 'JWT', kid: 'fixture' }) +
      '.' +
      encode({ iat: now, exp: now + 240, ...claims });
  return (
    body +
    '.' +
    sign('sha256', Buffer.from(body), { key: keys.privateKey, dsaEncoding: 'ieee-p1363' }).toString(
      'base64url',
    )
  );
};
const subject = 'spiffe://local.axiomproof.test/agent/prativedan';
const humanBearer = jwt({ sub: actorId, session_id: sessionId, aud: 'authenticated' });
const trust = {
  load: async () => ({
    revision: 'synthetic-fixture-current',
    validUntil: Date.now() + 10000,
    jwks: {
      keys: [{ ...keys.publicKey.export({ format: 'jwk' }), kid: 'fixture', use: 'jwt-svid' }],
    },
  }),
  stillCurrent: async () => true,
};
let discardFinishReply = false;
let stopAfterAdmission = false;
const nativeWriter = peer.writer('axiom_prativedan_controller');
const writer: PrativedanAssessmentRpcClient = {
  rpc: (name, args) => ({
    abortSignal: async (signal) => {
      const reply = await nativeWriter.rpc(name, args).abortSignal(signal);
      if (name === 'finish_prativedan_accounted_draft' && discardFinishReply && !reply.error) {
        discardFinishReply = false;
        return { data: null, error: { code: 'synthetic_lost_reply_after_commit' } };
      }
      if (name === 'start_prativedan_accounted_draft' && stopAfterAdmission && !reply.error) {
        stopAfterAdmission = false;
        await peer.query(
          "update public.kill_switch_state set engaged=true where scope_key='global';select '{}'::jsonb;",
        );
      }
      return reply;
    },
  }),
};
const controller = new PrativedanPrivateController({
  tenantId,
  trustDomain: 'local.axiomproof.test',
  trust,
  token: async () => jwt({ sub: subject, aud: ['axiom-prativedan-assessment-tools'] }),
  writer,
  currentUser: async (bearer) => {
    if (bearer !== humanBearer) throw new Error('fixture current human refused');
    return {
      id: actorId,
      aud: 'authenticated',
      app_metadata: {},
      user_metadata: {},
      created_at: '2026-10-19T00:00:00Z',
    };
  },
  computation: launch('computation'),
  renderer: launch('renderer'),
});
const app = new Hono<{ Variables: Variables }>();
app.use('*', async (c, next) => {
  c.set('user', { id: actorId } as Variables['user']);
  c.set('tenantId', tenantId);
  c.set('role', 'founder');
  c.set('sessionId', sessionId);
  c.set('token', humanBearer);
  await next();
});
const mfa = {
  sessionAttestation: async () => ({
    id: identity(96),
    satisfiedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 240000).toISOString(),
  }),
} as unknown as MfaService;
app.route(
  '/',
  prativedanAccountedDraftRoutes({
    mfa,
    client: controller,
    humanWriterFactory: () => peer.writer('human_action_writer'),
  }),
);
const post = async (step: string, body: unknown) => {
  const response = await app.request(`/reports/accounted-drafts/${step}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Expected-Actor-Id': actorId },
    body: JSON.stringify(body),
  });
  const parsed: unknown = await response.json();
  if (response.status >= 400)
    throw new Error(
      'mounted source fixture request refused at ' + step + ': ' + JSON.stringify(rpcErrors),
    );
  return z.object({ data: z.unknown() }).parse(parsed).data;
};
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
try {
  const seed = z
    .object({ assessmentRunId: z.uuid() })
    .parse(
      await peer.query(
        "select jsonb_build_object('assessmentRunId',run_id) from p172_fixture.issued;",
      ),
    );
  const preview = z
    .object({ source_sha256: z.string() })
    .parse(await post('preview', { engagementId, assessmentRunId: seed.assessmentRunId }));
  const operationKey = randomUUID();
  const reviewedRequestText = JSON.stringify({
    operationKey,
    engagementId,
    assessmentRunId: seed.assessmentRunId,
    expectedSourceSha256: preview.source_sha256,
    sourceReviewed: true,
  });
  await post('request', { reviewedRequestText });
  discardFinishReply = true;
  const uncertain = z
    .object({ outcome: z.string() })
    .parse(await post('generate', { reviewedRequestText }));
  if (uncertain.outcome !== 'invocation_uncertain')
    throw new Error('lost terminal reply not preserved');
  const settled = z
    .object({
      state: z.literal('unpublished'),
      run_id: z.uuid(),
      runtime_output_text: z.string(),
      response_output_sha256: z.string(),
    })
    .parse(await post('reconcile', { reviewedRequestText }));
  if (Number(owned.length) !== 2) throw new Error('reconciliation created duplicate computation');
  await post('review', {
    reviewedRequestText,
    reviewKey: randomUUID(),
    expectedHash: settled.response_output_sha256,
    decision: 'accepted',
    reason: 'Synthetic owned engineering review; unpublished fixture only.',
  });
  const failureCases: Record<string, unknown>[] = [];
  if (maliciousImage) {
    if (!/^sha256:[a-f0-9]{64}$/.test(maliciousImage))
      throw new Error('owned adversary image refused');
    const newIntent = async () => {
      const text = JSON.stringify({
        operationKey: randomUUID(),
        engagementId,
        assessmentRunId: seed.assessmentRunId,
        expectedSourceSha256: preview.source_sha256,
        sourceReviewed: true,
      });
      await post('request', { reviewedRequestText: text });
      return text;
    };
    rendererImage = maliciousImage;
    const maliciousIntent = await newIntent();
    const malicious = z
      .object({ outcome: z.literal('recorded_failure'), failureCode: z.literal('target_failed') })
      .parse(await post('generate', { reviewedRequestText: maliciousIntent }));
    if (Number(owned.length) !== 4) throw new Error('malicious fixture worker count refused');
    failureCases.push({
      kind: 'unexpected_complete_with_detached_child',
      outcome: malicious.outcome,
      failureCode: malicious.failureCode,
      modelStarts: 0,
    });
    rendererImage = image!;
    const stoppedIntent = await newIntent();
    stopAfterAdmission = true;
    const refused = await app.request('/reports/accounted-drafts/generate', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Expected-Actor-Id': actorId },
      body: JSON.stringify({ reviewedRequestText: stoppedIntent }),
    });
    if (refused.status !== 409)
      throw new Error('stopped authority should keep original uncertain response');
    await peer.query(
      "update public.kill_switch_state set engaged=false where scope_key='global';select '{}'::jsonb;",
    );
    const stopped = z
      .object({
        outcome: z.literal('recorded_failure'),
        failureCode: z.literal('current_authority_refused'),
      })
      .parse(await post('generate', { reviewedRequestText: stoppedIntent }));
    if (Number(owned.length) !== 5)
      throw new Error('halted attempt rendered or replayed computation');
    failureCases.push({
      kind: 'authority_halted_after_admission',
      outcome: stopped.outcome,
      failureCode: stopped.failureCode,
      modelStarts: 0,
    });
  }
  const facts = await peer.query(
    `select jsonb_build_object('opened',(select count(*) from public.model_accounting_runs),'calls',(select count(*) from public.model_accounting_call_starts),'seals',(select count(*) from public.model_accounting_seals),'capsules',(select count(*) from public.prativedan_accounted_capsules),'basis',(select min(summary->>'basis') from public.model_accounting_seals),'reviews',(select count(*) from public.prativedan_draft_reviews),'ledgerVerified',not exists(select 1 from public.verify_ledger('${tenantId}')));`,
  );
  const actual = z
    .object({
      opened: z.literal(maliciousImage ? 3 : 1),
      calls: z.literal(0),
      seals: z.literal(maliciousImage ? 3 : 1),
      capsules: z.literal(maliciousImage ? 3 : 1),
      basis: z.literal('no_model'),
      reviews: z.literal(1),
      ledgerVerified: z.literal(true),
    })
    .parse(facts);
  for (const row of owned) {
    let exists = true;
    const deadline = Date.now() + 5000;
    while (exists && Date.now() < deadline) {
      try {
        cli(['inspect', '--format', '{{.Id}}', row.id]);
        await new Promise((done) => setTimeout(done, 10));
      } catch {
        exists = false;
      }
    }
    if (exists) throw new Error('owned worker not removed');
  }
  const proof = {
    kind: 'owned_prativedan172_mounted_source_process_fixture',
    actualSql: true,
    actualPythonProcesses: true,
    syntheticHumanAdapter: true,
    syntheticSignedSvidIssuer: true,
    deployedGoTrueSpireUidSocketProven: false,
    operationKey,
    runId: settled.run_id,
    sourceSha256: preview.source_sha256,
    requestSha256: hash(reviewedRequestText),
    outputSha256: hash(settled.runtime_output_text),
    lostReplyRecoveredWithoutNewComputation: true,
    actual,
    workers: owned,
    failureCases,
    allOwnedWorkersRemoved: true,
    retainedRuntimeChanged: false,
    hostedProviderCalls: 0,
  };
  writeFileSync(
    resolve(proofDirectory!, 'mounted-process-proof.private.json'),
    JSON.stringify(proof, null, 2) + '\n',
    { mode: 0o600 },
  );
  console.log(
    'Mounted Prativedan source/process/native SQL fixture passed: real opened/sealed zero-call journal, exact lost-reply recovery, two isolated UID-bound Python processes removed.',
  );
} finally {
  peer.close();
  for (const row of owned) {
    try {
      const labels = JSON.parse(
        cli(['inspect', '--format', '{{json .Config.Labels}}', row.id]),
      ) as Record<string, string>;
      if (
        labels['com.axiom.role'] === `prativedan-${row.role}` &&
        labels['com.axiom.resource-prefix'] === 'axiom-proof-local-prativedan'
      )
        cli(['rm', '-f', row.id]);
    } catch {}
  }
}
