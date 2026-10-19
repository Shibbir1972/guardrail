import { dispatch } from '@/lib/admin-api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ path: string[] }> };
const handle = async (req: Request, ctx: Ctx) => dispatch(req, (await ctx.params).path);

export { handle as GET, handle as POST, handle as PUT, handle as PATCH, handle as DELETE };
