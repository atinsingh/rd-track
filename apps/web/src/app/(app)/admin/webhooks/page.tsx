import { redirect } from 'next/navigation';

/** Webhooks moved to Settings › Developers (F5). */
export default function WebhooksPage() {
  redirect('/admin/developers?tab=webhooks');
}
