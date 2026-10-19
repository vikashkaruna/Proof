export function ownedDeploymentAccess(role: string, internal: boolean) {
  const enabled =
    process.env.AXIOM_OWNED_SYNTHETIC_ENABLED === 'true' &&
    ['local', 'test'].includes(process.env.ENVIRONMENT ?? '') &&
    (process.env.AXIOM_AUTH_MODE ?? 'strict') === 'strict';
  return {
    available:
      enabled && (role === 'owner' || role === 'admin' || (internal && role === 'founder')),
    founder: internal && role === 'founder',
  };
}
