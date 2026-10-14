import { UserRole } from './enums';

/** Human roles that tenant configuration cannot exempt from login MFA.
 * Workload authentication remains a separate service-identity boundary.
 */
export const MANDATORY_HUMAN_MFA_ROLES = Object.freeze([
  UserRole.FOUNDER,
  UserRole.AXIOM_ANALYST,
  UserRole.OWNER,
  UserRole.ADMIN,
  UserRole.APPROVER,
] as const);

export function requiresMandatoryHumanMfa(role: string): boolean {
  return MANDATORY_HUMAN_MFA_ROLES.some((required) => required === role);
}
