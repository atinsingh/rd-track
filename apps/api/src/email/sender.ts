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

/** Transactional email. Messages carry links, never tenant activity data. */
export interface EmailSender {
  send(m: EmailMessage): Promise<void>;
}

/** Development: prints the message so links can be followed locally. */
export class ConsoleEmailSender implements EmailSender {
  async send(m: EmailMessage) {
    console.log(`\n── email to ${m.to}: ${m.subject}\n${m.text}\n──`);
  }
}

/** Tests: keeps messages in memory. */
export class MemoryEmailSender implements EmailSender {
  readonly sent: EmailMessage[] = [];
  async send(m: EmailMessage) {
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
