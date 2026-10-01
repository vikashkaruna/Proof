/**
 * RPCs that append a human-labelled ledger event. Migration 0099 makes them
 * executable only by human_action_writer, so a BFF handler that reaches them
 * through the generic service-role client would fail in a real deployment.
 * Test doubles for the service-role client use `refuseMovedProofRpcs` so such a
 * regression fails here instead of only against PostgREST.
 */
export const MOVED_PROOF_RPCS: ReadonlySet<string> = new Set([
  'acknowledge_drift_event',
  'advance_breach',
  'advance_dsar',
  'begin_approval_proof_archive',
  'create_standing_policy',
  'delegate_workload_task',
  'draft_breach_notification',
  'onboard_organization',
  'publish_assessment_dispatch_key_policy',
  'reconcile_execution_dispatch',
  'record_approval_export',
  'record_breach',
  'record_dsar',
  'register_connector_tool',
  'register_monitoring_schedule',
  'review_approval_proof_archive',
  'review_breach_notification',
  'revoke_standing_policy',
  'revoke_workload_task',
  'send_breach_notification',
  'settle_approval_proof_archive',
  'verify_dsar_identity',
]);

type WithRpc = { rpc: (...args: never[]) => unknown };

export function refuseMovedProofRpcs<T extends WithRpc>(client: T): T {
  return new Proxy(client, {
    get(target, property, receiver) {
      if (property !== 'rpc') return Reflect.get(target, property, receiver);
      return (name: string, ...rest: never[]) => {
        if (MOVED_PROOF_RPCS.has(name)) {
          throw new Error(`${name} must use the human action writer, not the service-role client`);
        }
        return (target.rpc as (...args: unknown[]) => unknown)(name, ...rest);
      };
    },
  });
}
