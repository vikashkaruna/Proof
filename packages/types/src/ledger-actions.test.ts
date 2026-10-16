import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AuditLedgerEntrySchema } from './domain';
import { LedgerActionType } from './enums';

describe('ledger action compatibility', () => {
  it('keeps the client ledger decoder aligned with every append-only SQL enum addition', () => {
    const directory = new URL('../../../infra/supabase/migrations/', import.meta.url);
    const initial = readFileSync(new URL('0005_approvals_ledger.sql', directory), 'utf8');
    const declaration = initial.match(/create type ledger_action_type as enum \(([\s\S]*?)\);/i);
    expect(declaration).not.toBeNull();
    const sql = new Set([...declaration![1]!.matchAll(/'([a-z_.]+)'/g)].map((m) => m[1]));
    for (const file of readdirSync(directory).filter((name) => name.endsWith('.sql'))) {
      const source = readFileSync(new URL(file, directory), 'utf8');
      for (const match of source.matchAll(
        /alter type (?:public\.)?ledger_action_type add value (?:if not exists )?'([^']+)'/gi,
      ))
        sql.add(match[1]);
    }
    expect([...sql].sort()).toEqual(Object.values(LedgerActionType).sort());
    for (const action of sql)
      expect(AuditLedgerEntrySchema.shape.actionType.parse(action)).toBe(action);
  });
  it('refuses undeclared workload action names', () => {
    expect(
      AuditLedgerEntrySchema.shape.actionType.safeParse('workload.task_executed').success,
    ).toBe(false);
  });
});

it.each(['custody.local_credential_issued', 'custody.local_credential_revoked'])(
  'decodes retained %s as a system fact without inventing human approval',
  (actionType) => {
    const entry = AuditLedgerEntrySchema.parse({
      id: '401',
      tenantId: '11111111-1111-4111-8111-111111111111',
      sequenceNo: 12,
      correlationId: '22222222-2222-4222-8222-222222222222',
      actorType: 'system',
      actorId: 'axiom-local-custody-issuer',
      agentVersion: null,
      modelId: null,
      promptHash: null,
      actionType,
      targetRef: '22222222-2222-4222-8222-222222222222',
      inputHash: 'a'.repeat(64),
      outputHash: 'b'.repeat(64),
      approvalTokenId: null,
      approverId: null,
      preStateRef: null,
      postStateRef: null,
      result: 'success',
      detail: { credential_id: '22222222-2222-4222-8222-222222222222', activation_epoch: 1 },
      occurredAt: '2026-10-16T00:00:00Z',
      prevEntryHash: 'c'.repeat(64),
      entryHash: 'd'.repeat(64),
    });
    expect(entry.actorType).toBe('system');
    expect(entry.actorId).toBe('axiom-local-custody-issuer');
    expect(entry.actionType).toBe(actionType);
    expect(entry.inputHash).toBe('a'.repeat(64));
    expect(entry.entryHash).toBe('d'.repeat(64));
    expect(entry.approvalTokenId).toBeNull();
    expect(entry.approverId).toBeNull();
    expect(entry.modelId).toBeNull();
    expect(
      AuditLedgerEntrySchema.shape.actionType.safeParse(
        actionType.replace('credential_', 'report_signing_'),
      ).success,
    ).toBe(false);
  },
);
