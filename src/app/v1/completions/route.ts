import { handleCompletion } from '@/lib/gateway';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = (req: Request) => handleCompletion(req, 'completions');
