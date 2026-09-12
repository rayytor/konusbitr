import { createTransport } from 'nodemailer';
import { loadWebEnv } from '../env';

/**
 * Delivery for the four emails auth sends: verification, magic link, password
 * reset and team invitation.
 *
 * Konusbitr is self-hosted software and most people running it locally have no
 * mail server. Requiring SMTP before anyone can sign up would break the
 * one-command promise, so delivery degrades instead of failing: with `SMTP_URL`
 * set the message is sent, and without it the message — link included — is
 * written to the server log, where `docker compose logs web` will find it.
 *
 * The fallback is a development convenience and says so loudly in the log. A
 * deployment that real users sign up to needs `SMTP_URL`.
 */

export type AuthEmail = {
  to: string;
  subject: string;
  /** The one thing the recipient has to act on. */
  url: string;
  /** A sentence of context above the link. */
  body: string;
};

export interface Mailer {
  send(message: AuthEmail): Promise<void>;
}

function renderText(message: AuthEmail): string {
  return `${message.body}\n\n${message.url}\n`;
}

function renderHtml(message: AuthEmail): string {
  const escape = (value: string) =>
    value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  return [
    '<div style="font-family:ui-sans-serif,system-ui,sans-serif;color:#29251f">',
    `<p>${escape(message.body)}</p>`,
    `<p><a href="${escape(message.url)}">${escape(message.url)}</a></p>`,
    '</div>',
  ].join('');
}

/** Writes the message to the server log. The default when SMTP is unconfigured. */
export function createLogMailer(): Mailer {
  return {
    async send(message) {
      // biome-ignore lint/suspicious/noConsole: this *is* the delivery mechanism.
      console.warn(
        [
          '',
          '  SMTP_URL is not set, so this email was not sent. The link is below.',
          `  To:      ${message.to}`,
          `  Subject: ${message.subject}`,
          `  Link:    ${message.url}`,
          '',
        ].join('\n'),
      );
    },
  };
}

/** Sends over SMTP. */
export function createSmtpMailer(url: string, from: string): Mailer {
  const transport = createTransport(url);
  return {
    async send(message) {
      await transport.sendMail({
        from,
        to: message.to,
        subject: message.subject,
        text: renderText(message),
        html: renderHtml(message),
      });
    },
  };
}

let cached: Mailer | undefined;

/** The configured mailer: SMTP when `SMTP_URL` is set, the log otherwise. */
export function mailer(): Mailer {
  if (!cached) {
    const env = loadWebEnv();
    cached = env.SMTP_URL ? createSmtpMailer(env.SMTP_URL, env.EMAIL_FROM) : createLogMailer();
  }
  return cached;
}
