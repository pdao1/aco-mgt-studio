import Stripe from 'stripe';
import type { CustomerBillingProfile, InvoiceRecord } from '../database/repository.js';

export interface StripeInvoiceResult {
  stripeCustomerId: string;
  stripeInvoiceId: string;
  paymentUrl: string | null;
}

export class StripeNotConfiguredError extends Error {
  constructor() {
    super('Stripe is not connected for this workspace yet. Add STRIPE_SECRET_KEY before issuing invoices.');
  }
}

export class StripeBillingError extends Error {
  constructor(message: string) {
    super(message);
  }
}

/**
 * Stripe is deliberately isolated behind this small gateway. The rest of the
 * application only deals in invoice snapshots and hosted payment URLs, so a
 * later Checkout or Connect decision does not leak into order ingestion.
 */
export class StripeBillingGateway {
  private readonly client: Stripe | null;

  constructor(secretKey: string | null) {
    this.client = secretKey ? new Stripe(secretKey) : null;
  }

  get configured(): boolean {
    return this.client !== null;
  }

  async issueInvoice(
    customer: CustomerBillingProfile,
    invoice: InvoiceRecord,
    dueDays: number,
  ): Promise<StripeInvoiceResult> {
    if (!this.client) throw new StripeNotConfiguredError();

    try {
      const stripeCustomerId = await this.ensureCustomer(customer);
      for (const line of invoice.lines) {
        await this.client.invoiceItems.create({
          customer: stripeCustomerId,
          amount: line.feeCents,
          currency: invoice.currency.toLowerCase(),
          description: `ACO service fee · ${line.description}`,
          metadata: {
            aco_invoice_id: invoice.id,
            aco_order_id: line.orderId,
            aco_charge_type: 'service_fee',
          },
        }, {
          idempotencyKey: `aco-invoice-line-${invoice.id}-${line.orderId}`,
        });
      }

      const created = await this.client.invoices.create({
        customer: stripeCustomerId,
        collection_method: 'send_invoice',
        days_until_due: dueDays,
        auto_advance: false,
        metadata: {
          aco_invoice_id: invoice.id,
          aco_customer_id: customer.id,
        },
      }, {
        idempotencyKey: `aco-invoice-${invoice.id}`,
      });

      const finalized = created.status === 'draft'
        ? await this.client.invoices.finalizeInvoice(created.id, {}, { idempotencyKey: `aco-invoice-finalize-${invoice.id}` })
        : created;
      return {
        stripeCustomerId,
        stripeInvoiceId: finalized.id,
        paymentUrl: finalized.hosted_invoice_url ?? null,
      };
    } catch (error) {
      if (error instanceof StripeNotConfiguredError) throw error;
      const message = error instanceof Error ? error.message : 'Stripe rejected the invoice.';
      throw new StripeBillingError(message.slice(0, 240));
    }
  }

  constructWebhookEvent(payload: Buffer, signature: string, webhookSecret: string): Stripe.Event {
    if (!this.client) throw new StripeNotConfiguredError();
    try {
      return this.client.webhooks.constructEvent(payload, signature, webhookSecret);
    } catch {
      throw new StripeBillingError('Stripe webhook signature verification failed.');
    }
  }

  private async ensureCustomer(customer: CustomerBillingProfile): Promise<string> {
    if (!this.client) throw new StripeNotConfiguredError();
    if (customer.stripeCustomerId) return customer.stripeCustomerId;
    const created = await this.client.customers.create({
      name: customer.name,
      email: customer.gmailAddress,
      metadata: { aco_customer_id: customer.id },
    }, { idempotencyKey: `aco-customer-${customer.id}` });
    return created.id;
  }
}
