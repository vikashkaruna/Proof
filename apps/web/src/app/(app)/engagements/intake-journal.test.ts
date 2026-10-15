import { describe, expect, it } from 'vitest';
import {
  clearIntakeJournal,
  readIntakeJournal,
  retainIntakeJournal,
  intakeJournalKey,
  type IntakeIntent,
} from './intake-journal';
class MemoryStorage implements Storage {
  values = new Map<string, string>();
  get length() {
    return this.values.size;
  }
  key(index: number) {
    return [...this.values.keys()][index] ?? null;
  }
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
  removeItem(key: string) {
    this.values.delete(key);
  }
  clear() {
    this.values.clear();
  }
}
const a: IntakeIntent = {
  actorId: '11111111-1111-4111-8111-111111111111',
  tenantId: '22222222-2222-4222-8222-222222222222',
  libraryVersion: '0.1.1',
  requestKey: '33333333-3333-4333-8333-333333333333',
  title: 'Reviewed intake',
  estateId: '',
};
const b: IntakeIntent = {
  ...a,
  requestKey: '44444444-4444-4444-8444-444444444444',
  title: 'Another explicit intent',
};
const key = (value: IntakeIntent) =>
  intakeJournalKey(value.actorId) + value.tenantId + ':' + value.requestKey;
describe('durable intake journal', () => {
  it('restores exact intent and refuses another tenant/library/body or key without overwriting', () => {
    const s = new MemoryStorage();
    retainIntakeJournal(s, a);
    expect(readIntakeJournal(s, a.actorId)).toEqual(a);
    for (const changed of [
      b,
      { ...a, title: 'Changed body' },
      { ...a, libraryVersion: 'later' },
      { ...b, tenantId: b.actorId },
    ])
      expect(() => retainIntakeJournal(s, changed)).toThrow();
    expect(readIntakeJournal(s, a.actorId)).toEqual(a);
  });
  it('keeps independently retained concurrent entries and clears only confirmed own intent', () => {
    const s = new MemoryStorage();
    retainIntakeJournal(s, a);
    // Another tab may have passed its preflight before our write. Separate keys
    // preserve both intents; no claim of atomic exclusion across tabs is made.
    s.setItem(key(b), JSON.stringify(b));
    retainIntakeJournal(s, a);
    clearIntakeJournal(s, a);
    expect(readIntakeJournal(s, a.actorId)).toEqual(b);
    expect(() => clearIntakeJournal(s, { ...b, title: 'changed' })).toThrow();
    expect(readIntakeJournal(s, a.actorId)).toEqual(b);
  });
  it('detects a competing write during readback/rescan without deleting either entry', () => {
    const s = new MemoryStorage();
    const original = s.setItem.bind(s);
    s.setItem = (k, v) => {
      original(k, v);
      original(key(b), JSON.stringify(b));
    };
    expect(() => retainIntakeJournal(s, a)).toThrow();
    expect(s.length).toBe(2);
  });
  it('preserves a late pending write after an earlier operation was confirmed and cleared', () => {
    const s = new MemoryStorage();
    retainIntakeJournal(s, a);
    clearIntakeJournal(s, a);
    // Without Web Locks, an explicit intent prepared by a second tab before the
    // commit can arrive afterward. It remains a distinct recoverable intent.
    s.setItem(key(b), JSON.stringify(b));
    clearIntakeJournal(s, a);
    expect(readIntakeJournal(s, a.actorId)).toEqual(b);
  });
  it('refuses corrupt, oversized, wrong-key and wrong-actor entries', () => {
    for (const raw of [
      '{',
      'x'.repeat(4097),
      JSON.stringify({ ...a, actorId: b.tenantId }),
      JSON.stringify({ ...a, requestKey: b.requestKey }),
    ]) {
      const s = new MemoryStorage();
      s.setItem(key(a), raw);
      expect(() => readIntakeJournal(s, a.actorId)).toThrow();
    }
  });
});
