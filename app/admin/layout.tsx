import type { Metadata, Viewport } from 'next';
import { AdminDocument } from '@/components/admin/admin-document';
import { adminFontClassName } from '@/lib/admin/admin-fonts';
import '@/styles/admin.css';

export const metadata: Metadata = {
  title: 'Knowledge Base Upload | Auraplex Admin',
  description: 'Restricted Auraplex knowledge-base upload workspace.',
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: '#181b20',
  width: 'device-width',
  initialScale: 1,
};

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return <AdminDocument fontClassName={adminFontClassName}>{children}</AdminDocument>;
}
