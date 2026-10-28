import Link from 'next/link';
import { PageHeader } from '@/components/ui/Layout';

export function NoAccess({ what }: { what: string }) {
  return (
    <>
      <PageHeader eyebrow="No access" title="This page isn't available to you" description={what} />
      <p>
        <Link href="/me">Go to My day</Link>
      </p>
    </>
  );
}
