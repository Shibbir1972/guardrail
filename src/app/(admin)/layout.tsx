import { Shell } from '@/components/shell';

export const dynamic = 'force-dynamic';

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return <Shell>{children}</Shell>;
}
