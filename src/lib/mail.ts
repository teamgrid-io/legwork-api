import { config } from "../config.js";

export interface MailMessage {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
}

export type MailSender = (message: MailMessage) => Promise<void>;

/**
 * There is no mail provider wired up yet. Outside production the message goes
 * to the log instead, so a developer can follow the activation link by hand.
 * In production the call fails loudly rather than silently dropping a real
 * customer's activation email.
 */
async function logOnlySender(message: MailMessage): Promise<void> {
  if (config.isProduction) {
    throw new Error("Mail provider not configured");
  }

  // Subject and body only. The recipient address is never logged.
  console.log(`Mail subject: ${message.subject}\n${message.text}`);
}

let activeSender: MailSender = logOnlySender;

/**
 * Test-only seam. ES module bindings cannot be replaced after import, so a test
 * installs a capturing sender here instead of patching this module.
 */
export function setMailSender(sender: MailSender | null): void {
  activeSender = sender ?? logOnlySender;
}

/**
 * Deliver one plain-text message. Nothing is queued through Redis, so a mail
 * failure surfaces to the caller instead of being lost in a background worker.
 */
export async function sendMail(message: MailMessage): Promise<void> {
  await activeSender(message);
}
