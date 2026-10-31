import { SendEmailCommand, SESv2Client } from '@aws-sdk/client-sesv2';
import type { Config } from '../config';

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  /** Optional HTML alternative; the text part is always sent. */
  html?: string;
  /** Where replies go, e.g. the person who sent an invoice to a client. */
  replyTo?: string;
}

/**
 * Children in a family (doc 08) have an address on this reserved domain (RFC 2606): it is
 * never delivered to, whichever code path asks.
 */
export const CHILD_EMAIL_DOMAIN = 'family.invalid';

export function childEmail(userId: string): string {
  return `child-${userId}@${CHILD_EMAIL_DOMAIN}`;
}

/** Whether an address may be sent to at all. */
export function deliverable(to: string): boolean {
  return !to.trim().toLowerCase().endsWith(`@${CHILD_EMAIL_DOMAIN}`);
}

/** Transactional email. Messages carry links, never tenant activity data. */
export interface EmailSender {
  send(m: EmailMessage): Promise<void>;
}

/** Development: prints the message so links can be followed locally. */
export class ConsoleEmailSender implements EmailSender {
  async send(m: EmailMessage) {
    if (!deliverable(m.to)) return;
    console.log(`\n── email to ${m.to}: ${m.subject}\n${m.text}\n──`);
  }
}

/** Tests: keeps messages in memory. */
export class MemoryEmailSender implements EmailSender {
  readonly sent: EmailMessage[] = [];
  async send(m: EmailMessage) {
    if (!deliverable(m.to)) return;
    this.sent.push(m);
  }
}

export class SesEmailSender implements EmailSender {
  private readonly client: SESv2Client;
  constructor(
    region: string,
    private readonly from: string,
  ) {
    this.client = new SESv2Client({ region });
  }
  async send(m: EmailMessage) {
    if (!deliverable(m.to)) return;
    await this.client.send(
      new SendEmailCommand({
        FromEmailAddress: this.from,
        Destination: { ToAddresses: [m.to] },
        ...(m.replyTo ? { ReplyToAddresses: [m.replyTo] } : {}),
        Content: {
          Simple: { Subject: { Data: m.subject }, Body: { Text: { Data: m.text }, ...(m.html ? { Html: { Data: m.html } } : {}) } },
        },
      }),
    );
  }
}

export function createEmailSender(config: Config): EmailSender {
  switch (config.email.provider) {
    case 'ses':
      return new SesEmailSender(config.email.region, config.email.from);
    case 'memory':
      return new MemoryEmailSender();
    default:
      return new ConsoleEmailSender();
  }
}
