import { NextResponse } from 'next/server';
import { GapScanEmailRequestSchema } from '@axiom/types';
import { gapScanBackend } from '@/lib/gap-scan-backend';
import { readGapScanAccess } from '@/lib/gap-scan-access';
export const runtime = 'nodejs';
export async function POST(request: Request) {
  const parsed = GapScanEmailRequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success)
    return NextResponse.json(
      { error: { code: 'validation_failed', message: 'Invalid request' } },
      { status: 400, headers: { 'Cache-Control': 'private, no-store' } },
    );
  try {
    const access = await readGapScanAccess();
    const res = await gapScanBackend('/public/gap-scan/send-email', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(access ? { 'X-Gap-Scan-Access': access } : {}),
      },
      body: JSON.stringify(parsed.data),
    });
    const payload = await res.json();
    return NextResponse.json(payload, {
      status: res.status,
      headers: {
        'Cache-Control': 'private, no-store',
        ...(res.headers.has('Retry-After')
          ? { 'Retry-After': res.headers.get('Retry-After')! }
          : {}),
      },
    });
  } catch {
    return NextResponse.json(
      {
        error: {
          code: 'service_unavailable',
          message: 'Report service unavailable. Please try again.',
        },
      },
      { status: 503, headers: { 'Cache-Control': 'private, no-store' } },
    );
  }
}
