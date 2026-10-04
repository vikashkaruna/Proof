import { Capability, UserRole, can } from '@axiom/types';

/** The web's Pramaan view has a usable dossier reader only for these operators. */
export function canAccessClosureDossiers(role: UserRole, isAxiomInternal: boolean): boolean {
  return (
    can(Capability.REPORT_READ, { role }) &&
    ((role === UserRole.FOUNDER && isAxiomInternal) ||
      role === UserRole.OWNER ||
      role === UserRole.ADMIN)
  );
}
