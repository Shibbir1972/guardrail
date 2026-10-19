import { SESSION_COOKIE, sessionToken, timingSafeEqual } from '@/lib/session';

export const runtime = 'nodejs';

export async function POST(req: Request) {
  const expected = process.env.GUARDRAIL_ADMIN_PASSWORD;
  if (!expected) return Response.json({ ok: true });
  const { password } = (await req.json().catch(() => ({}))) as { password?: string };
  if (!password || !timingSafeEqual(await sessionToken(password), await sessionToken(expected))) {
    return Response.json({ error: 'Wrong password.' }, { status: 401 });
  }
  const token = await sessionToken(expected);
  const secure = new URL(req.url).protocol === 'https:' ? '; Secure' : '';
  return Response.json(
    { ok: true },
    { headers: { 'Set-Cookie': `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${60 * 60 * 12}${secure}` } },
  );
}
