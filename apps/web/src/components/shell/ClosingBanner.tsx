'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Banner } from '@/components/ui/Layout';
import { rd } from '@/lib/api';
import { useMe } from '@/lib/me';
import { formatDateTime } from '@/lib/time';
import { useApi } from '@/lib/useApi';

/** On every page for org admins while the organization is closing (slice 5b). */
export function ClosingBanner() {
  const { access, timezone: tz } = useMe();
  const org = useApi(access.isAdmin ? 'admin:organization' : null, (signal) => rd.admin.organization(signal));
  const here = usePathname();
  const at = org.data?.deletion_scheduled_at;
  // The Organization data page shows its own, with the cancel button.
  if (!at || here === '/admin/data') return null;
  return (
    <Banner tone="warn" title={`${org.data!.name} will be deleted on ${formatDateTime(at, tz)}`} actions={<Link href="/admin/data">Export or cancel →</Link>}>
      All records and stored files are deleted that day.
    </Banner>
  );
}
