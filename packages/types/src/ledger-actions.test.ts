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
