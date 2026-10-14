import { expect, it } from 'vitest';
import { UserRole } from './enums';
import { MANDATORY_HUMAN_MFA_ROLES, requiresMandatoryHumanMfa } from './mfa-policy';

it.each(Object.values(UserRole))('classifies the mandatory human role %s', (role) => {
  expect(requiresMandatoryHumanMfa(role)).toBe(
    ['founder', 'axiom_analyst', 'owner', 'admin', 'approver'].includes(role),
  );
});
it('keeps the mandatory list immutable and treats no workload or arbitrary role as a human grant', () => {
  expect(Object.isFrozen(MANDATORY_HUMAN_MFA_ROLES)).toBe(true);
  for (const role of ['agent', '', 'ADMIN', 'service', 'admin '])
    expect(requiresMandatoryHumanMfa(role)).toBe(false);
});
