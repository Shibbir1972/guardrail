import { NextRequest, NextResponse } from 'next/server';
import { SESSION_COOKIE, sessionToken, timingSafeEqual } from '@/lib/session';

// The admin panel and its API sit behind a password when GUARDRAIL_ADMIN_PASSWORD is set.
// The /v1 gateway authenticates with API keys instead and is not matched here.
export async function middleware(req: NextRequest) {
  const password = process.env.GUARDRAIL_ADMIN_PASSWORD;
  if (!password) return NextResponse.next();
  const cookie = req.cookies.get(SESSION_COOKIE)?.value ?? '';
  if (cookie && timingSafeEqual(cookie, await sessionToken(password))) return NextResponse.next();
  if (req.nextUrl.pathname.startsWith('/api/')) return NextResponse.json({ error: 'Sign in first.' }, { status: 401 });
  const url = req.nextUrl.clone();
  url.pathname = '/login';
  url.searchParams.set('next', req.nextUrl.pathname);
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ['/((?!v1/|api/auth/|login|_next/|favicon).*)'],
};
