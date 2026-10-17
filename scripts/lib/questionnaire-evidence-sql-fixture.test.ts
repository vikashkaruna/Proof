import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  PARITY_SQL_PATH,
  questionnaireEvidenceParitySql,
} from './questionnaire-evidence-sql-fixture.js';

test('committed SQL parity suite matches current report-kit output', () => {
  assert.equal(
    readFileSync(PARITY_SQL_PATH, 'utf8'),
    questionnaireEvidenceParitySql(),
    'regenerate with: pnpm exec tsx scripts/lib/questionnaire-evidence-sql-fixture.ts --write',
  );
});
