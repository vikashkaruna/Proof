import { Hono } from 'hono';
import { createClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { publicRoutes } from './routes/public.js';
import { createMarketingIdleGate } from './marketing-idle-gate.js';

const MarketingConfig = z.object({
  ENVIRONMENT: z.literal('preprod'),
  NODE_ENV: z.literal('production'),
  AXIOM_AUTH_MODE: z.literal('strict'),
  AXIOM_RELEASE_SHA: z.string().regex(/^[a-f0-9]{40}$/),
  SUPABASE_URL: z.string().url().startsWith('https://'),
  SUPABASE_SERVICE_KEY: z.string().min(40),
  AXIOM_PROOF_MARKETING_URL: z.string().url().startsWith('https://'),
  AXIOM_CONTACT_EMAIL_MODE: z.enum(['disabled', 'delivery']),
  AXIOM_REPORT_EMAIL_MODE: z.enum(['disabled', 'delivery']),
  GCP_PROJECT_ID: z.string().min(1),
  GCP_REGION: z.literal('asia-south1'),
  AXIOM_IDLE_PROJECT_ID: z.string().min(1),
  AXIOM_IDLE_CONTROLLER_URL: z.string().url(),
  AXIOM_IDLE_CONTROLLER_AUDIENCE: z.string().url(),
  RESEND_API_KEY: z.string().optional(),
  AXIOM_FROM_EMAIL: z.string().optional(),
  CONTACT_RECIPIENT_EMAIL: z.string().email().optional(),
});

/** Dedicated marketing deployment: no product execution, agent or admin routes. */
export function createMarketingApp(raw: Record<string, string | undefined> = process.env) {
  const parsed = MarketingConfig.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `Invalid marketing configuration: ${parsed.error.issues.map((i) => i.path.join('.')).join(', ')}`,
    );
  }
  const config = parsed.data;
  const parts = config.SUPABASE_SERVICE_KEY.split('.');
  let claims: { role?: string; exp?: number };
  try {
    claims = JSON.parse(Buffer.from(parts[1] ?? '', 'base64url').toString());
  } catch {
    throw new Error('Invalid marketing configuration: SUPABASE_SERVICE_KEY');
  }
  if (
    parts.length !== 3 ||
    claims.role !== 'service_role' ||
    typeof claims.exp !== 'number' ||
    claims.exp <= Date.now() / 1000
  ) {
    throw new Error('Invalid marketing configuration: SUPABASE_SERVICE_KEY');
  }
  if (
    config.AXIOM_CONTACT_EMAIL_MODE === 'delivery' ||
    config.AXIOM_REPORT_EMAIL_MODE === 'delivery'
  ) {
    if (
      !config.RESEND_API_KEY?.startsWith('re_') ||
      !config.AXIOM_FROM_EMAIL ||
      config.AXIOM_FROM_EMAIL.includes('placeholder') ||
      !config.CONTACT_RECIPIENT_EMAIL
    ) {
      throw new Error('Invalid marketing delivery configuration');
    }
  }
  const gate = createMarketingIdleGate(config);
  const client = createClient(config.SUPABASE_URL, config.SUPABASE_SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { fetch: gate.databaseFetch },
  });
  const app = new Hono();
  app.get('/health', (c) =>
    c.json({ status: 'healthy', profile: 'marketing', releaseSha: config.AXIOM_RELEASE_SHA }),
  );
  app.use('/public/*', gate.middleware);
  app.route('/public', publicRoutes({ client: () => client }));
  return app;
}
