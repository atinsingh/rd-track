import { MANDATORY_CATEGORIES, NOTIFICATION_CATEGORY_LABELS, type NotificationCategory } from '@rd/contracts';
import type { EmailMessage } from './sender';

/**
 * Notification emails: the title, one line, and a link into the app. They never carry
 * activity data (times, apps, screenshots), only what the in-app notice says.
 */

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function notificationEmail(p: {
  to: string;
  orgName: string;
  title: string;
  body: string;
  link: string | null;
  category: NotificationCategory;
  webUrl: string;
}): EmailMessage {
  const url = p.link ? `${p.webUrl}${p.link}` : `${p.webUrl}/me`;
  const settings = `${p.webUrl}/me/settings`;
  const why = MANDATORY_CATEGORIES.includes(p.category)
    ? `You get this because it is about your ${p.category === 'billing' ? 'organization’s subscription' : p.category === 'privacy' ? 'data' : 'account'}; it can't be turned off.`
    : `You get this for “${NOTIFICATION_CATEGORY_LABELS[p.category].label}”. Change what you get by email: ${settings}`;
  const text = `${p.title}\n\n${p.body}\n\nOpen RoundDigital Track: ${url}\n\n—\n${p.orgName} · RoundDigital Track\n${why}\n`;
  const html = `<!doctype html><html><body style="margin:0;background:#eceef2;font-family:Inter,system-ui,-apple-system,'Segoe UI',sans-serif;color:#0e1013">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:16px">
<tr><td style="padding:24px 28px 0;font:500 11px/1.4 'JetBrains Mono',ui-monospace,monospace;letter-spacing:.14em;text-transform:uppercase;color:#53595f">
<span style="display:inline-block;width:16px;height:2px;background:#fd3d41;vertical-align:middle;margin-right:8px"></span>${escape(p.orgName)} · Track</td></tr>
<tr><td style="padding:14px 28px 0"><h1 style="margin:0;font:700 22px/1.25 'Inter Tight',Inter,system-ui,sans-serif;letter-spacing:-.02em">${escape(p.title)}</h1></td></tr>
<tr><td style="padding:10px 28px 0;font-size:15px;line-height:1.5;color:#3f444b">${escape(p.body)}</td></tr>
<tr><td style="padding:22px 28px 26px"><a href="${escape(url)}" style="display:inline-block;background:#d42b2b;color:#ffffff;text-decoration:none;font-weight:600;font-size:14px;padding:12px 18px;border-radius:10px">Open in Track</a></td></tr>
</table>
<p style="max-width:560px;margin:16px auto 0;font-size:12px;line-height:1.5;color:#53595f">${escape(why)}</p>
</td></tr></table></body></html>`;
  return { to: p.to, subject: p.title, text, html };
}
