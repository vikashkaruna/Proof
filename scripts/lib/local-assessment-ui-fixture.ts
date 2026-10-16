/** Configuration metadata fixture for local Playwright SSR only. It never
 * dispatches an assessment and confers no authentication or execution authority. */
import { z } from 'zod';
import type { AssessmentRequestProducer } from '../../services/bff/src/workloads/assessment-producer.js';
const evidence = z.object({
  environment: z.literal('local'),
  authMode: z.literal('strict'),
  deployed: z.literal(false),
  parity: z.object({
    apiOrigin: z.literal('http://127.0.0.1:56321'),
    databaseId: z.string().regex(/^[a-f0-9]{64}$/),
    status: z.object({
      API_URL: z.literal('http://127.0.0.1:56321'),
      ANON_KEY: z.string().min(1),
      SERVICE_ROLE_KEY: z.string().min(1),
    }),
  }),
  application: z.object({
    url: z.literal('http://127.0.0.1:56321'),
    anonKey: z.string().min(1),
    serviceKey: z.string().min(1),
  }),
  persona: z.object({
    deployment: z.null().optional(),
    supabaseUrl: z.literal('http://127.0.0.1:56321'),
    anonKey: z.string().min(1),
    serviceKey: z.string().min(1),
    tenantA: z.object({ id: z.uuid(), slug: z.string().min(1), name: z.string().min(1) }),
  }),
});
export function localAssessmentUiFixture(value: unknown) {
  const result = evidence.safeParse(value);
  if (!result.success) throw new Error('Local assessment UI fixture target refused');
  const v = result.data;
  if (
    v.persona.anonKey !== v.parity.status.ANON_KEY ||
    v.persona.serviceKey !== v.parity.status.SERVICE_ROLE_KEY ||
    v.application.anonKey !== v.parity.status.ANON_KEY ||
    v.application.serviceKey !== v.parity.status.SERVICE_ROLE_KEY
  )
    throw new Error('Local assessment UI fixture target refused');
  const tenant = v.persona.tenantA;
  const producer: AssessmentRequestProducer = Object.freeze({
    configurationForTenant: (tenantId: string) => tenantId === tenant.id.toLowerCase(),
    async request() {
      throw new Error('Local assessment UI fixture refuses real dispatch');
    },
  });
  return { tenant, producer };
}
