'use client';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { formatDateTime } from '@/lib/display-time';
import {
  ownedDeploymentList,
  ownedDeploymentOptions,
  type OwnedDeploymentSummary,
  type OwnedDeploymentOptions,
} from '@axiom/types';
import {
  deploymentJournal,
  deploymentJournalKey,
  readDeploymentJournal,
  retainDeploymentJournal,
  retainDeploymentFence,
  assertCurrentDeploymentJournal,
  completeDeploymentJournal,
  checkDeploymentReadback,
  withDeploymentLock,
  deploymentBody,
  deploymentTransport,
  type DeploymentJournal,
} from './deployment-journal';
const button =
  'min-h-10 rounded-lg border border-slate-300 px-4 py-2 text-sm font-semibold text-indigo-950 disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-teal-700';
const primary = `${button} bg-teal-700 text-white`;
const field = 'w-full rounded-lg border border-slate-300 p-2 text-sm';
const states: Record<OwnedDeploymentSummary['state'], string> = {
  requested: 'Waiting for preparation checks',
  preflight_ready: 'Ready for founder approval',
  preflight_refused: 'Preparation checks did not pass',
  approved: 'Approved; ready to install',
  installing: 'Installation in progress',
  active: 'Installation confirmed',
  unconfirmed: 'Outcome needs review',
  revoked: 'Setup authority revoked',
  expired: 'Setup authority expired',
};
const steps = {
  enroll_synthetic_resource: 'Register the synthetic resource',
  authorize_role_switch: 'Limit database role access',
  publish_scoped_credential: 'Make the scoped credential available',
  register_karya_identity: 'Register the execution identity',
  stage_owned_controller: 'Prepare the isolated executor',
  verify_installed_scope: 'Independently check the installed scope',
};
interface Props {
  tenantId: string;
  actorId: string;
  founder: boolean;
  engagements: { id: string; title: string }[];
}
export function OwnedDeploymentClient({ tenantId, actorId, founder, engagements }: Props) {
  const [rows, setRows] = useState<OwnedDeploymentSummary[]>([]),
    [options, setOptions] = useState<OwnedDeploymentOptions['data']>([]),
    [engagement, setEngagement] = useState(''),
    [selected, setSelected] = useState(''),
    [reason, setReason] = useState(''),
    [ack, setAck] = useState(false),
    [stopReason, setStopReason] = useState(''),
    [stopAck, setStopAck] = useState(false),
    [code, setCode] = useState(''),
    [retireAck, setRetireAck] = useState(false),
    [pending, setPending] = useState<DeploymentJournal | null>(null),
    [ready, setReady] = useState(false),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState(''),
    [error, setError] = useState('');
  const active = useRef(false),
    mounted = useRef(true);
  const scope = { tenantId, actorId },
    key = deploymentJournalKey(tenantId, actorId);
  const row = rows.find((r) => r.requestId === selected);
  async function reload() {
    const result = ownedDeploymentList.parse(await deploymentTransport(scope, ''));
    if (result.data.some((r) => r.tenantId !== tenantId)) throw Error('Setup organisation changed');
    if (mounted.current) setRows(result.data);
  }
  useEffect(() => {
    mounted.current = true;
    const read = () => {
      try {
        setPending(readDeploymentJournal(localStorage, tenantId, actorId));
        setReady(true);
      } catch {
        setReady(false);
        setError('The retained setup step is unreadable. Preserve it for review.');
      }
    };
    const listener = (event: StorageEvent) => {
      if (event.key === null || event.key === key) read();
    };
    read();
    void reload().catch(() => {
      if (mounted.current) setError('Demo setup is unavailable. No readiness can be inferred.');
    });
    window.addEventListener('storage', listener);
    return () => {
      mounted.current = false;
      window.removeEventListener('storage', listener);
    };
    // Scope changes remount this component; refreshes preserve the original request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId, actorId, key]);
  async function run(work: () => Promise<void>) {
    if (active.current || !ready) return;
    active.current = true;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await withDeploymentLock(tenantId, actorId, work);
    } catch (cause) {
      if (mounted.current)
        setError(
          cause instanceof Error
            ? cause.message
            : 'Keep the original setup step and check it again.',
        );
    } finally {
      active.current = false;
      if (mounted.current) {
        setBusy(false);
        try {
          setPending(readDeploymentJournal(localStorage, tenantId, actorId));
        } catch {
          setReady(false);
        }
      }
    }
  }
  async function readback(original: DeploymentJournal) {
    assertCurrentDeploymentJournal(localStorage, original);
    const value = await deploymentTransport(
      scope,
      `/${original.requestId}/operations/${original.intent.phase}/${original.intent.request.operationKey}`,
    );
    const receipt = await checkDeploymentReadback(value, original);
    assertCurrentDeploymentJournal(localStorage, original);
    return receipt;
  }
  async function recover(
    original: DeploymentJournal,
    existing?: Awaited<ReturnType<typeof readback>>,
  ) {
    const receipt = existing ?? (await readback(original));
    assertCurrentDeploymentJournal(localStorage, original);
    if (receipt.outcome !== 'recorded' || !receipt.receiptId) {
      setMessage(
        receipt.outcome === 'not_recorded'
          ? 'This exact step has no recorded outcome. You can retry the retained step; a new request has not been created.'
          : 'The original step is still unconfirmed. Preserve it and check again.',
      );
      return;
    }
    if (original.intent.phase === 'challenge' || original.intent.phase === 'revoke_challenge') {
      if (receipt.phaseResult?.phase !== original.intent.phase)
        throw Error('Recorded challenge is unavailable');
      const challenge = receipt.phaseResult.challenge;
      if (Date.parse(challenge.expiresAt) <= Date.now())
        throw Error(
          'The recorded challenge expired. Retire the old step after the server confirms that this step made no mutating effect, then review a fresh request.',
        );
      retainDeploymentJournal(localStorage, {
        ...original,
        intent:
          original.intent.phase === 'revoke_challenge'
            ? {
                phase: 'revoke_verify',
                request: original.intent.request,
                challengeId: challenge.challengeId,
              }
            : {
                phase: 'verify',
                request: original.intent.request,
                challengeId: challenge.challengeId,
              },
      });
      setMessage(
        original.intent.phase === 'revoke_challenge'
          ? 'Enter your current authenticator or recovery code. Revoking authority still needs your separate confirmation.'
          : 'Enter your current authenticator or recovery code. Approval still needs your confirmation.',
      );
      return;
    }
    if (original.intent.phase === 'verify' || original.intent.phase === 'revoke_verify') {
      retainDeploymentJournal(localStorage, {
        ...original,
        intent:
          original.intent.phase === 'revoke_verify'
            ? { ...original.intent, phase: 'revoke' }
            : { ...original.intent, phase: 'approve' },
      });
      setMessage(
        original.intent.phase === 'revoke_verify'
          ? 'Your code was verified for this exact stop request. Confirm revocation of its setup authority.'
          : 'Your code was verified for this exact setup. Review the frozen request and confirm founder approval.',
      );
      return;
    }
    completeDeploymentJournal(localStorage, original, receipt.receiptId);
    if (original.intent.phase === 'revoke') {
      setStopReason('');
      setStopAck(false);
    }
    setCode('');
    setRetireAck(false);
    setMessage(
      receipt.phaseResult?.phase === 'fence'
        ? `The server retired the original step and blocked its late retries. Receipt ${receipt.receiptId}. ${receipt.phaseResult.receipt.requiresPreflight ? 'Run fresh preparation checks before reviewing another approval.' : 'You can select and review a new step.'} No replacement approval or target change was made.`
        : original.intent.phase === 'revoke'
          ? `Setup authority revoked. Receipt ${receipt.receiptId}. The target setting and audit history are preserved.`
          : `Step recorded. Receipt ${receipt.receiptId}.`,
    );
    await reload();
  }
  async function send(original: DeploymentJournal) {
    assertCurrentDeploymentJournal(localStorage, original);
    const before = await readback(original);
    if (before.outcome !== 'not_recorded') {
      await recover(original, before);
      return;
    }
    const suffix =
      original.intent.phase === 'request'
        ? ''
        : `/${original.requestId}/${original.intent.phase === 'fence' ? 'fence-intent' : original.intent.phase.replaceAll('_', '-')}`;
    try {
      await deploymentTransport(
        scope,
        suffix,
        deploymentBody(original, code),
        original.intent.request.operationKey,
      );
    } finally {
      setCode('');
    }
    assertCurrentDeploymentJournal(localStorage, original);
    await recover(original);
  }
  function retire(original: DeploymentJournal) {
    void run(async () => {
      if (!retireAck) throw Error('Confirm retirement of the original step first');
      const current = await readback(original);
      if (current.outcome === 'unconfirmed')
        throw Error('An effect is still unconfirmed. Keep the original step for reconciliation.');
      if (
        (original.intent.phase === 'approve' || original.intent.phase === 'revoke') &&
        current.outcome === 'recorded'
      ) {
        await recover(original, current);
        return;
      }
      const fence = await retainDeploymentFence(localStorage, original, crypto.randomUUID());
      setCode('');
      setRetireAck(false);
      await send(fence);
    });
  }
  function begin(phase: 'request' | 'preflight' | 'challenge' | 'install' | 'revoke_challenge') {
    void run(async () => {
      if (readDeploymentJournal(localStorage, tenantId, actorId))
        throw Error('Check the retained step before starting another.');
      const operationKey = crypto.randomUUID();
      let intent: DeploymentJournal['intent'];
      let requestId: string;
      if (phase === 'request') {
        const option = options.find(
          (o) => o.manifestSha256 === selected && o.engagementId === engagement,
        );
        if (!option || !ack || Date.parse(option.expiresAt) <= Date.now())
          throw Error('Select and acknowledge a current reviewed setup option.');
        requestId = operationKey;
        intent = {
          phase,
          request: {
            operationKey,
            engagementId: option.engagementId,
            connectorId: option.connectorId,
            manifestSha256: option.manifestSha256,
            reason,
            acknowledgeOwnedSynthetic: true,
          },
        };
      } else {
        if (!row) throw Error('Select the retained setup request first');
        requestId = row.requestId;
        if (phase === 'revoke_challenge') {
          if (!row.approval || !stopAck)
            throw Error('Review and acknowledge the exact setup authority to stop');
          intent = {
            phase,
            request: {
              operationKey,
              expectedManifestSha256: row.manifestSha256,
              expectedApprovalId: row.approval.approvalId,
              reason: stopReason,
              acknowledgeOwnedSynthetic: true,
            },
          };
        } else if (phase === 'preflight')
          intent = { phase, request: { operationKey, expectedManifestSha256: row.manifestSha256 } };
        else if (phase === 'install') {
          if (!row.approval) throw Error('Recorded founder approval is required');
          intent = {
            phase,
            request: {
              operationKey,
              expectedManifestSha256: row.manifestSha256,
              expectedApprovalId: row.approval.approvalId,
            },
          };
        } else {
          if (!founder || !row.preflight || !ack)
            throw Error('Review the checks and acknowledge the exact setup first');
          intent = {
            phase,
            request: {
              operationKey,
              expectedManifestSha256: row.manifestSha256,
              expectedPreflightSha256: row.preflight.sha256,
              expectedRollbackSha256: row.preflight.rollbackSha256,
              reason,
              acknowledgeOwnedSynthetic: true,
            },
          };
        }
      }
      const original = retainDeploymentJournal(
        localStorage,
        deploymentJournal.parse({ version: 1, tenantId, actorId, requestId, intent }),
      );
      await send(original);
    });
  }
  function loadOptions() {
    void run(async () => {
      if (readDeploymentJournal(localStorage, tenantId, actorId))
        throw Error('Check the retained step first');
      const result = ownedDeploymentOptions.parse(
        await deploymentTransport(scope, `/options/${engagement}`),
      );
      if (result.data.some((o) => o.engagementId !== engagement))
        throw Error('Setup engagement changed');
      setOptions(result.data);
      setSelected('');
      setAck(false);
      setReason('');
      if (!result.data.length)
        setMessage(
          'No reviewed setup manifest is staged for this engagement. Ask the local operator to prepare one.',
        );
    });
  }
  return (
    <div className="space-y-5">
      <ol
        aria-label="Demo setup workflow"
        className="grid gap-2 rounded-xl bg-slate-50 p-4 text-sm sm:grid-cols-4"
      >
        {['Owner requests', 'Preparation checks', 'Founder approves', 'Install and verify'].map(
          (label, i) => (
            <li key={label}>
              {i + 1}. {label}
            </li>
          ),
        )}
      </ol>
      {error && (
        <p role="alert" className="rounded-lg border border-red-200 bg-red-50 p-4 text-red-900">
          {error}
        </p>
      )}
      {message && (
        <p role="status" className="rounded-lg border border-teal-200 bg-teal-50 p-4 text-teal-950">
          {message}
        </p>
      )}
      {pending ? (
        <section
          aria-label="Retained setup step"
          className="space-y-3 rounded-xl border border-slate-300 p-5"
        >
          <h2 className="font-semibold">Continue the original setup step</h2>
          <p>
            Step:{' '}
            {pending.intent.phase === 'approve'
              ? 'Confirm founder approval'
              : pending.intent.phase === 'revoke'
                ? 'Confirm stop of setup authority'
                : pending.intent.phase === 'revoke_verify'
                  ? 'Verify code for the stop request'
                  : pending.intent.phase === 'revoke_challenge'
                    ? 'Prepare the stop request'
                    : pending.intent.phase}
            . Its exact request is saved in this browser. Check its receipt before retrying.
          </p>
          {'reason' in pending.intent.request && <p>Reason: {pending.intent.request.reason}</p>}
          {(pending.intent.phase === 'verify' || pending.intent.phase === 'revoke_verify') && (
            <label className="block">
              Authenticator or recovery code
              <input
                className={field}
                autoComplete="one-time-code"
                value={code}
                onChange={(e) => setCode(e.target.value)}
              />
            </label>
          )}
          <div className="flex flex-wrap gap-3">
            <button
              className={button}
              disabled={busy}
              onClick={() => void run(() => recover(pending))}
            >
              Check original step
            </button>
            <button
              className={primary}
              disabled={
                busy || (['verify', 'revoke_verify'].includes(pending.intent.phase) && !code.trim())
              }
              onClick={() => void run(() => send(pending))}
            >
              {pending.intent.phase === 'approve'
                ? 'Approve this reviewed setup'
                : pending.intent.phase === 'revoke'
                  ? 'Revoke this setup authority'
                  : pending.intent.phase === 'revoke_verify'
                    ? 'Verify code for this stop request'
                    : pending.intent.phase === 'verify'
                      ? 'Verify code for this setup'
                      : 'Retry original step'}
            </button>
          </div>
          {!['install', 'fence'].includes(pending.intent.phase) && (
            <div className="space-y-2 border-t border-slate-200 pt-3">
              <p className="text-sm">
                If this step expired or you need to review a fresh request, ask the server to retire
                it. Retirement is refused while this step has a mutating or uncertain effect.
              </p>
              <label className="flex gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={retireAck}
                  onChange={(e) => setRetireAck(e.target.checked)}
                />
                I want to retire this exact step after the server confirms no mutating effect and
                blocks late retries.
              </label>
              <button
                className={button}
                disabled={busy || !retireAck}
                onClick={() => retire(pending)}
              >
                Check and retire the original step
              </button>
            </div>
          )}
          <details>
            <summary>Frozen scope and request reference</summary>
            <p className="break-all text-xs">
              {pending.requestId} · {pending.intent.request.operationKey}
            </p>
            <p className="text-sm">
              {pending.intent.phase.startsWith('revoke')
                ? 'Stopping authority blocks further setup and execution access. It preserves existing resources and history and does not undo the audit setting.'
                : 'Local synthetic audit configuration only. Setup does not change the audit setting.'}
            </p>
            {pending.intent.phase !== 'fence' && (
              <p className="break-all text-xs">
                Manifest:{' '}
                {'manifestSha256' in pending.intent.request
                  ? pending.intent.request.manifestSha256
                  : pending.intent.request.expectedManifestSha256}
              </p>
            )}
            {pending.intent.phase === 'fence' && (
              <p className="break-all text-xs">
                Retiring original operation {pending.intent.request.target.operationKey}; request
                digest {pending.intent.request.target.canonicalRequestHash}.
              </p>
            )}
            {'expectedPreflightSha256' in pending.intent.request && (
              <p className="break-all text-xs">
                Preparation: {pending.intent.request.expectedPreflightSha256} · Rollback:{' '}
                {pending.intent.request.expectedRollbackSha256}
              </p>
            )}
          </details>
        </section>
      ) : (
        <>
          <section
            aria-label="Request demo setup"
            className="space-y-3 rounded-xl border border-slate-200 bg-white p-5"
          >
            <h2 className="text-lg font-semibold">1. Request a reviewed synthetic setup</h2>
            <label className="block">
              Engagement
              <select
                className={field}
                value={engagement}
                disabled={busy || !ready}
                onChange={(e) => {
                  setEngagement(e.target.value);
                  setOptions([]);
                  setSelected('');
                  setReason('');
                  setAck(false);
                }}
              >
                <option value="">Choose an engagement</option>
                {engagements.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.title}
                  </option>
                ))}
              </select>
            </label>
            <button
              className={button}
              disabled={busy || !ready || !engagement}
              onClick={loadOptions}
            >
              Find reviewed setup options
            </button>
            {options.length > 0 && (
              <label className="block">
                Reviewed setup
                <select
                  className={field}
                  value={selected}
                  onChange={(e) => {
                    setSelected(e.target.value);
                    setReason('');
                    setAck(false);
                  }}
                >
                  <option value="">Choose a setup</option>
                  {options.map((o) => (
                    <option key={o.manifestSha256} value={o.manifestSha256}>
                      {o.label} · expires {formatDateTime(o.expiresAt)}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {options
              .find((o) => o.manifestSha256 === selected)
              ?.limitations.map((item) => (
                <p key={item} className="text-sm text-slate-700">
                  {item}
                </p>
              ))}
            {options.some((o) => o.manifestSha256 === selected) && (
              <ReviewStatement reason={reason} ack={ack} onReason={setReason} onAck={setAck} />
            )}
            <button
              className={primary}
              disabled={
                busy ||
                !ready ||
                !options.some((o) => o.manifestSha256 === selected) ||
                !ack ||
                reason.trim().length < 20
              }
              onClick={() => begin('request')}
            >
              Record setup request
            </button>
          </section>
          <section
            aria-label="Retained demo setups"
            className="space-y-3 rounded-xl border border-slate-200 bg-white p-5"
          >
            <h2 className="text-lg font-semibold">2. Review an existing setup</h2>
            <button className={button} disabled={busy || !ready} onClick={() => void run(reload)}>
              Refresh setup status
            </button>
            {rows.length === 0 && (
              <p className="text-sm">No setup requests are currently available.</p>
            )}
            <label className="block">
              Setup request
              <select
                className={field}
                value={rows.some((r) => r.requestId === selected) ? selected : ''}
                onChange={(e) => {
                  setSelected(e.target.value);
                  setAck(false);
                  setReason('');
                  setStopAck(false);
                  setStopReason('');
                }}
              >
                <option value="">Choose a request</option>
                {rows.map((r) => (
                  <option key={r.requestId} value={r.requestId}>
                    {engagements.find((e) => e.id === r.engagementId)?.title ?? 'Engagement'} ·{' '}
                    {states[r.state]} · {formatDateTime(r.requestedAt)}
                  </option>
                ))}
              </select>
            </label>
            {row && (
              <>
                <p className="font-medium">{states[row.state]}</p>
                <section
                  aria-label="Current setup authority"
                  className="rounded-lg bg-slate-50 p-3 text-sm"
                >
                  <h3 className="font-semibold">Current authority</h3>
                  <p>
                    {row.currentAuthority?.state === 'valid_recorded_scope'
                      ? 'Recorded scope currently valid'
                      : row.currentAuthority?.state === 'inactive'
                        ? 'Authority inactive'
                        : 'Authority needs verification'}
                  </p>
                  <p>
                    {row.currentAuthority?.detail ??
                      'Only the historical setup state is available. Refresh and independently verify current authority before execution.'}
                  </p>
                  {row.currentAuthority?.credentialExpiresAt && (
                    <p>
                      Credential expires {formatDateTime(row.currentAuthority.credentialExpiresAt)}
                    </p>
                  )}
                  <p>This status does not confirm that a worker is running or paused.</p>
                </section>
                <p>Request reason: {row.reason}</p>
                {row.limitations.map((item) => (
                  <p key={item} className="text-sm text-slate-700">
                    {item}
                  </p>
                ))}
                {row.preflight && (
                  <div>
                    <h3 className="font-semibold">Preparation checks</h3>
                    <p className="text-sm">
                      Dry run: {row.preflight.dryRunCompleted ? 'completed' : 'incomplete'} ·
                      Rollback: {row.preflight.rollbackValidated ? 'validated' : 'unvalidated'}
                    </p>
                    <ul className="mt-2 space-y-2">
                      {row.preflight.checks.map((check) => (
                        <li key={check.name}>
                          <strong>
                            {check.name}: {check.outcome}
                          </strong>
                          <p className="text-sm">{check.detail}</p>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {row.installation && (
                  <ol aria-label="Installation checks" className="space-y-2">
                    {row.installation.steps.map((step) => (
                      <li key={step.step}>
                        <strong>
                          {steps[step.step]}: {step.state}
                        </strong>
                        {step.detail && <p className="text-sm">{step.detail}</p>}
                      </li>
                    ))}
                  </ol>
                )}
                {['requested', 'preflight_refused', 'preflight_ready'].includes(row.state) && (
                  <button
                    className={primary}
                    disabled={busy || !ready}
                    onClick={() => begin('preflight')}
                  >
                    {row.state === 'preflight_ready'
                      ? 'Refresh preparation checks'
                      : 'Run preparation checks'}
                  </button>
                )}
                {row.state === 'preflight_ready' &&
                  (founder ? (
                    <>
                      <ReviewStatement
                        reason={reason}
                        ack={ack}
                        onReason={setReason}
                        onAck={setAck}
                      />
                      <button
                        className={primary}
                        disabled={busy || !ready || !ack || reason.trim().length < 20}
                        onClick={() => begin('challenge')}
                      >
                        Prepare founder approval
                      </button>
                    </>
                  ) : (
                    <p>
                      Preparation passed. An internal founder must review and approve this setup.
                    </p>
                  ))}
                {row.state === 'approved' && (
                  <button
                    className={primary}
                    disabled={busy || !ready}
                    onClick={() => begin('install')}
                  >
                    Install the approved setup
                  </button>
                )}
                {row.state === 'active' && (
                  <p>
                    Installation scope is confirmed.{' '}
                    <Link className="font-semibold text-teal-800 underline" href="/plans">
                      Create and review a remediation plan
                    </Link>{' '}
                    to change the synthetic audit setting through its separate dry run and approval.
                  </p>
                )}
                {row.approval && row.state !== 'revoked' && (
                  <section
                    aria-label="Stop setup authority"
                    className="space-y-3 rounded-xl border border-slate-300 p-4"
                  >
                    <h3 className="font-semibold">Stop this setup authority</h3>
                    <p className="text-sm">
                      A current organisation owner, administrator or founder can revoke this exact
                      enrollment with a fresh authenticator or recovery code, including after its
                      original approval expires. Existing resources, target settings and audit
                      history are preserved. An uncertain installation still needs reconciliation.
                    </p>
                    <label className="block">
                      Reason for stopping this setup
                      <textarea
                        className={field}
                        minLength={20}
                        maxLength={2000}
                        value={stopReason}
                        onChange={(e) => setStopReason(e.target.value)}
                      />
                    </label>
                    <label className="flex gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={stopAck}
                        onChange={(e) => setStopAck(e.target.checked)}
                      />
                      I reviewed this exact enrollment and want to revoke its setup authority. This
                      does not undo its target setting.
                    </label>
                    <button
                      className={button}
                      disabled={busy || !ready || !stopAck || stopReason.trim().length < 20}
                      onClick={() => begin('revoke_challenge')}
                    >
                      Prepare stop request
                    </button>
                  </section>
                )}
                <details>
                  <summary>Technical references and receipts</summary>
                  <dl className="space-y-1 break-all text-xs">
                    <dt>Setup request</dt>
                    <dd>{row.requestId}</dd>
                    <dt>Manifest digest</dt>
                    <dd>{row.manifestSha256}</dd>
                    <dt>Preparation receipt</dt>
                    <dd>{row.preflight?.receiptId ?? 'None'}</dd>
                    <dt>Approval receipt</dt>
                    <dd>{row.approval?.receiptId ?? 'None'}</dd>
                    <dt>Installation receipt</dt>
                    <dd>{row.installation?.receiptId ?? 'None'}</dd>
                  </dl>
                </details>
              </>
            )}
          </section>
        </>
      )}
      <p className="text-sm">
        <Link href="/settings/local-custody" className="text-teal-800 underline">
          Review local custody policy
        </Link>{' '}
        ·{' '}
        <Link href="/settings/security" className="text-teal-800 underline">
          Manage authenticator and recovery codes
        </Link>
      </p>
    </div>
  );
}

function ReviewStatement({
  reason,
  ack,
  onReason,
  onAck,
}: {
  reason: string;
  ack: boolean;
  onReason: (value: string) => void;
  onAck: (value: boolean) => void;
}) {
  return (
    <section
      aria-label="Setup review statement"
      className="space-y-3 rounded-xl border border-slate-200 p-5"
    >
      <label className="block">
        Reason for your request or approval
        <textarea
          className={field}
          minLength={20}
          maxLength={2000}
          value={reason}
          onChange={(e) => onReason(e.target.value)}
        />
      </label>
      <label className="flex gap-2 text-sm">
        <input type="checkbox" checked={ack} onChange={(e) => onAck(e.target.checked)} />I reviewed
        the selected synthetic setup, its limitations and the current preparation and rollback
        checks. This authority is limited to the displayed local setup.
      </label>
    </section>
  );
}
