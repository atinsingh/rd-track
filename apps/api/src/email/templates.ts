import { MANDATORY_CATEGORIES, NOTIFICATION_CATEGORY_LABELS, type DeletionCertificateDTO, type NotificationCategory } from '@rd/contracts';
import type { EmailMessage } from './sender';

/**
 * Notification emails: the title, one line, and a link into the app. They never carry
 * activity data (times, apps, screenshots), only what the in-app notice says.
 */

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** The one email layout: eyebrow, title, a short body, one button. */
function layout(p: { orgName: string; title: string; body: string; actionLabel: string; url: string; footer: string }): string {
  return `<!doctype html><html><body style="margin:0;background:#eceef2;font-family:Inter,system-ui,-apple-system,'Segoe UI',sans-serif;color:#0e1013">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:16px">
<tr><td style="padding:24px 28px 0;font:500 11px/1.4 'JetBrains Mono',ui-monospace,monospace;letter-spacing:.14em;text-transform:uppercase;color:#53595f">
<span style="display:inline-block;width:16px;height:2px;background:#fd3d41;vertical-align:middle;margin-right:8px"></span>${escape(p.orgName)} · Track</td></tr>
<tr><td style="padding:14px 28px 0"><h1 style="margin:0;font:700 22px/1.25 'Inter Tight',Inter,system-ui,sans-serif;letter-spacing:-.02em">${escape(p.title)}</h1></td></tr>
<tr><td style="padding:10px 28px 0;font-size:15px;line-height:1.5;color:#3f444b">${escape(p.body)}</td></tr>
<tr><td style="padding:22px 28px 26px"><a href="${escape(p.url)}" style="display:inline-block;background:#d42b2b;color:#ffffff;text-decoration:none;font-weight:600;font-size:14px;padding:12px 18px;border-radius:10px">${escape(p.actionLabel)}</a></td></tr>
</table>
<p style="max-width:560px;margin:16px auto 0;font-size:12px;line-height:1.5;color:#53595f">${escape(p.footer)}</p>
</td></tr></table></body></html>`;
}

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
  return { to: p.to, subject: p.title, text, html: layout({ orgName: p.orgName, title: p.title, body: p.body, actionLabel: 'Open in Track', url, footer: why }) };
}

/**
 * A single-use link (invite, password reset, email change). These are sent directly,
 * never stored as notifications, because the link itself grants access.
 */
export function actionEmail(p: { to: string; orgName: string; title: string; body: string; actionLabel: string; url: string; expires: string; ignore: string }): EmailMessage {
  const footer = `The link works once and expires ${p.expires}. ${p.ignore}`;
  const text = `${p.title}\n\n${p.body}\n\n${p.actionLabel}: ${p.url}\n\n—\n${p.orgName} · RoundDigital Track\n${footer}\n`;
  return { to: p.to, subject: p.title, text, html: layout({ ...p, footer }) };
}

/**
 * An issued invoice sent to a client's billing contact. Clients have no account, so the
 * invoice itself is the message: lines, totals and due date. It names projects and,
 * when the invoice is grouped by person, the people on each line — what the client is
 * billed for, nothing more (no activity, apps or screenshots ever appear on invoices).
 */
export function invoiceEmail(p: {
  to: string;
  replyTo: string;
  orgName: string;
  number: string;
  clientName: string;
  period: string;
  due: string | null;
  lines: { label: string; hours: string; rate: string; amount: string }[];
  subtotal: string;
  tax: string | null;
  total: string;
  notes: string | null;
  message: string | null;
}): EmailMessage {
  const subject = `Invoice ${p.number} from ${p.orgName}`;
  const dueLine = p.due ? `Due ${p.due}.` : '';
  const text = [
    `${subject}`,
    '',
    p.message ?? `Please find invoice ${p.number} for ${p.period} below.`,
    '',
    ...p.lines.map((l) => `${l.label} — ${l.hours} h × ${l.rate} = ${l.amount}`),
    '',
    `Subtotal: ${p.subtotal}`,
    ...(p.tax ? [`Tax: ${p.tax}`] : []),
    `Total: ${p.total}`,
    dueLine,
    ...(p.notes ? ['', p.notes] : []),
    '',
    `Reply to this email to reach ${p.orgName}.`,
  ].join('\n');
  const rows = p.lines
    .map(
      (l) =>
        `<tr><td style="padding:8px 0;border-top:1px solid #e3e6ea">${escape(l.label)}</td><td style="padding:8px 0;border-top:1px solid #e3e6ea;text-align:right;font-family:ui-monospace,monospace">${escape(l.hours)} h</td><td style="padding:8px 0;border-top:1px solid #e3e6ea;text-align:right;font-family:ui-monospace,monospace">${escape(l.rate)}</td><td style="padding:8px 0;border-top:1px solid #e3e6ea;text-align:right;font-family:ui-monospace,monospace">${escape(l.amount)}</td></tr>`,
    )
    .join('');
  const sum = (label: string, value: string, strong = false) =>
    `<tr><td colspan="3" style="padding:6px 0;text-align:right;${strong ? 'font-weight:700' : ''}">${escape(label)}</td><td style="padding:6px 0;text-align:right;font-family:ui-monospace,monospace;${strong ? 'font-weight:700' : ''}">${escape(value)}</td></tr>`;
  const html = `<!doctype html><html><body style="margin:0;background:#eceef2;font-family:Inter,system-ui,-apple-system,'Segoe UI',sans-serif;color:#0e1013">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:640px;background:#ffffff;border-radius:16px"><tr><td style="padding:24px 28px">
<p style="margin:0;font:500 11px/1.4 ui-monospace,monospace;letter-spacing:.14em;text-transform:uppercase;color:#53595f">${escape(p.orgName)} · Invoice</p>
<h1 style="margin:12px 0 4px;font:700 22px/1.25 Inter,system-ui,sans-serif">${escape(p.number)}</h1>
<p style="margin:0 0 16px;color:#3f444b">${escape(p.clientName)} · ${escape(p.period)}${p.due ? ` · Due ${escape(p.due)}` : ''}</p>
${p.message ? `<p style="margin:0 0 16px;white-space:pre-line">${escape(p.message)}</p>` : ''}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:14px">
<tr><th align="left" style="padding:0 0 8px;font-weight:600">Item</th><th align="right" style="padding:0 0 8px;font-weight:600">Hours</th><th align="right" style="padding:0 0 8px;font-weight:600">Rate</th><th align="right" style="padding:0 0 8px;font-weight:600">Amount</th></tr>
${rows}${sum('Subtotal', p.subtotal)}${p.tax ? sum('Tax', p.tax) : ''}${sum('Total', p.total, true)}
</table>
${p.notes ? `<p style="margin:16px 0 0;white-space:pre-line;color:#3f444b">${escape(p.notes)}</p>` : ''}
</td></tr></table>
<p style="max-width:640px;margin:16px auto 0;font-size:12px;color:#53595f">Reply to this email to reach ${escape(p.orgName)}.</p>
</td></tr></table></body></html>`;
  return { to: p.to, replyTo: p.replyTo, subject, text, html };
}

/**
 * The certificate of deletion (slice 5b), sent to the organization's admins after its
 * data is gone. The text is the certificate itself; the digest lets a kept copy be
 * checked against RoundDigital's record.
 */
export function certificateEmail(to: string, c: DeletionCertificateDTO, certificateText: string): EmailMessage {
  const text = `${certificateText}\n\nCertificate ${c.id} · SHA-256 ${c.digest}`;
  const html = `<!doctype html><html><body style="margin:0;background:#eceef2;font-family:Inter,system-ui,sans-serif;color:#0e1013">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:640px;background:#ffffff;border-radius:16px"><tr><td style="padding:24px 28px">
<pre style="margin:0;white-space:pre-wrap;font:13px/1.55 ui-monospace,monospace">${escape(text)}</pre>
</td></tr></table></td></tr></table></body></html>`;
  return { to, subject: `Certificate of deletion — ${c.organization_name}`, text, html };
}
