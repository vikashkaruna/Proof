import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { GapScanSubmitSchema } from '@axiom/types';
import { gapScanBackend } from '@/lib/gap-scan-backend';
export const runtime = 'nodejs';
export async function POST(request: Request) {
  const parsed = GapScanSubmitSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success)
    return NextResponse.json(
      { error: { code: 'validation_failed', message: 'Invalid request' } },
      { status: 400 },
    );
  try {
    const access = (await cookies()).get('gap_scan_access')?.value;
    const res = await gapScanBackend('/public/gap-scan', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(access ? { 'X-Gap-Scan-Access': access } : {}),
      },
      body: JSON.stringify(parsed.data),
    });
    const payload = await res.json();
    const { accessToken, ...publicPayload } = payload;
    const response = NextResponse.json(publicPayload, {
      status: res.status,
      headers: {
        'Cache-Control': 'private, no-store',
        ...(res.headers.has('Retry-After')
          ? { 'Retry-After': res.headers.get('Retry-After')! }
          : {}),
      },
    });
    if (res.ok) {
      if (typeof accessToken !== 'string' || !/^[a-f0-9]{64}$/.test(accessToken))
        throw new Error('Invalid backend ownership response');
      response.cookies.set('gap_scan_access', accessToken, {
        httpOnly: true,
        sameSite: 'lax',
        secure: request.url.startsWith('https:'),
        maxAge: 60 * 60 * 24 * 7,
        path: '/',
      });
    }
    return response;
  } catch {
    return NextResponse.json(
      {
        error: {
          code: 'service_unavailable',
          message: 'Report service unavailable. Please try again.',
        },
      },
      { status: 503 },
    );
  }
}
