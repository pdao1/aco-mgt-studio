import nodemailer, { type Transporter } from 'nodemailer';
import type { InvoiceRecord } from '../database/repository.js';

export interface SmtpConfig {
  host: string | null;
  port: number;
  secure: boolean;
  user: string | null;
  password: string | null;
  from: string | null;
}

/**
 * Small, bounded notification queue. SMTP is deliberately kept out of the
 * request critical path; a failed delivery is logged without message content
 * or credentials and can be retried by the next invoice action.
 */
export class SmtpNotifier {
  private readonly transporter: Transporter | null;
  private readonly from: string | null;
  private readonly pending = new Set<string>();
  private readonly sent = new Set<string>();
  private queueDepth = 0;

  constructor(config: SmtpConfig) {
    this.from = config.from;
    if (!config.host || !config.from) {
      this.transporter = null;
      return;
    }
    this.transporter = nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: config.secure,
      auth: config.user && config.password ? { user: config.user, pass: config.password } : undefined,
    });
  }

  enqueueInvoiceGenerated(invoice: InvoiceRecord, buyerEmail: string) {
    this.enqueue(`generated:${invoice.id}:${buyerEmail}`, buyerEmail, `Invoice ${invoice.invoiceNumber} is ready`, invoiceMessage(invoice, 'Your service-fee invoice has been generated.'));
  }

  enqueueInvoicePaid(invoice: InvoiceRecord, buyerEmail: string, sellerEmail: string | null) {
    const message = invoiceMessage(invoice, 'Payment received. Thank you.');
    this.enqueue(`paid:${invoice.id}:${buyerEmail}`, buyerEmail, `Invoice ${invoice.invoiceNumber} was paid`, message);
    if (sellerEmail && sellerEmail.toLowerCase() !== buyerEmail.toLowerCase()) {
      this.enqueue(`paid:${invoice.id}:${sellerEmail}`, sellerEmail, `Invoice ${invoice.invoiceNumber} was paid`, message);
    }
  }

  private enqueue(key: string, to: string, subject: string, html: string) {
    if (!this.transporter || !this.from || this.pending.has(key) || this.sent.has(key) || this.queueDepth >= 100) return;
    this.pending.add(key);
    this.queueDepth += 1;
    setImmediate(() => {
      void this.transporter!.sendMail({ from: this.from!, to, subject, html })
        .then(() => { this.sent.add(key); })
        .catch((error: unknown) => {
          console.error('[notifications] SMTP delivery failed', error instanceof Error ? error.message : 'unknown error');
        })
        .finally(() => {
          this.pending.delete(key);
          this.queueDepth = Math.max(0, this.queueDepth - 1);
        });
    });
  }
}

function invoiceMessage(invoice: InvoiceRecord, lead: string) {
  const amount = `${invoice.currency} ${(invoice.totalCents / 100).toFixed(2)}`;
  return `<div style="font-family:Arial,sans-serif;line-height:1.5">${invoice.companyName ? `<h2>${escapeHtml(invoice.companyName)}</h2>` : ''}<p>${escapeHtml(lead)}</p><p><strong>${escapeHtml(invoice.invoiceNumber)}</strong><br/>Service fees: ${escapeHtml(amount)}</p><p>This invoice does not include retailer purchase amounts.</p></div>`;
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] ?? character);
}
