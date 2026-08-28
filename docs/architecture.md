# ACO Studio architecture

This document is the implementation contract for the customer order, shipment,
manual-override, and billing phase. It deliberately keeps the product small:
the operator sees **Overview**, **Customers**, **Billing**, and **Settings**. Orders,
shipments, fee edits, and status overrides live inside a selected customer.
The customer sees one static secret portal with orders, tracking, invoices, and
Stripe/Venmo payment links when configured.

## Execution contract

| Area | Decision |
| --- | --- |
| Goal | Turn each connected Gmail inbox into scoped, normalized order facts, then let an operator review, override, invoice, and collect payment. |
| Source of truth | PostgreSQL rows scoped by `workspace_id`; browser filters are presentation only. |
| Mailbox boundary | Gmail IMAP is read-only. App passwords are encrypted with `SecretBox`; raw bodies and attachments are not persisted. |
| Order facts | Parser-owned status and purchase totals remain separate from `status_override`, `override_note`, fee basis type, custom basis amount, and fee basis points. |
| Billing | An invoice snapshots selected ACO service fees. Purchase totals and fee bases remain informational references; drafts can be recalculated and issued invoices lock order fees. |
| Payment | Stripe Invoicing creates a hosted payment page. An optional workspace Venmo URL is shown as an external manual-payment option. Stripe webhook event IDs are stored before applying a state transition. |
| Access | A server-side `SERVICE_SERIAL` unlocks a signed, HttpOnly access cookie. Operator sessions remain separate and are still required. |
| Notifications | Optional SMTP delivery is queued outside request handlers for invoice-created (buyer) and invoice-paid (buyer + seller) notices. |
| Platform subscription | One subscribed ACO business maps to one isolated workspace/node group. Provider entitlements such as Whop are separate from downstream customer fee invoices. |
| Async work | `MailboxSyncCoordinator` is a bounded background consumer today. It searches order/shipment mail plus cancellation/refund notices, matches known customer order numbers, and applies cancellation events idempotently. `orders.ingestion.v1` is the seam for a separately deployed worker or Render Workflow later. |
| AI | Deterministic parsing runs first. The optional enrichment provider receives only a redacted, bounded excerpt and must return data that the workflow validates before loading. No model is enabled by default. |
| Empty state | A new installation contains no customers, orders, invoices, or sample records. |

## Product surfaces

- **Overview**: customer count, completed orders, stuck orders, cancelled
  orders, ACO service fees, and a short needs-attention list.
- **Customers**: one customer rail; the selected customer shows order status
  filters, search, tracking, fees, billing state, timeline, and manual status
  controls.
- **Billing**: select unbilled orders for the selected customer, create a
  draft snapshot, issue it through Stripe, and copy/open the hosted payment
  page.
- **Customer portal**: persistent random link; the customer can see every
  normalized order, informational purchase total, ACO service fee, current or manually overridden status,
  tracking, invoices, and optional Venmo payment links. No operator credentials or mailbox data are sent.
- **Settings**: workspace-scoped customer-facing name/logo/color, seller email,
  and Venmo URL. Settings are never shared with another node group.

## Data and state contracts

1. `orders.status` is the canonical parser value. `orders.status_override` is
   nullable and wins only in reads; clearing it returns the view to the parser.
2. `orders.fee_basis_points` is an integer from 0–10,000. `fee_basis` is
   `checkout_total` or `custom_amount`; custom mode requires a non-negative
   custom basis in the order currency. Fee cents are
   `round(resolved_basis_cents * basis_points / 10,000)`.
3. `orders.billing_invoice_id` is set in the same transaction that creates
   `invoice_lines`. Cancelled orders are never billable; checkout-based fees
   require a parsed total, while custom-amount fees may be billed even when
   the retailer total is unavailable.
4. New invoice lines use `billing_model = service_fee_only` and copy the
   informational purchase total, basis kind and resolved amount, basis points,
   fee cents, currency, and order identity. Amount due equals fee cents. This
   preserves the amount that was actually invoiced even if parser data changes
   later. Previously issued legacy invoices remain immutable.
5. Stripe identifiers stay server-side. The API exposes only a hosted payment
   URL and safe invoice state to the portal.

## Ingestion task contract

The current IMAP consumer calls these stages through
`server/workflows/order-ingestion.ts`.

| Task | Input reference | Output/status | Side effect | Retry/idempotency |
| --- | --- | --- | --- | --- |
| Extract | workspace, customer, sync run, bounded Gmail search window | message source held in memory; scanned count | read-only IMAP fetch | reconnect with bounded timeout; message key is provider Message-ID or content hash |
| Normalize | one fetched source | bounded `EmailInput` with subject/from/date/text/html | none | deterministic per message key; source is never logged or stored |
| Deterministic parse | normalized email | `ParsedOrderEmail` or no match | none | pure function; reruns produce the same normalized values |
| Optional AI enrich | redacted domain, subject, 6,000-character excerpt, message key | unknown provider output validated into `ParsedOrderEmail` or rejected | model usage accounting belongs to provider | provider call is bounded; no blind retry of validation failures |
| Load | workspace, customer, message metadata, validated order | processed-message result and normalized order/event/shipment rows | PostgreSQL transaction/upserts | unique `(workspace, customer, message_key)` and order keys prevent duplicates |
| Reconcile | sync run and database counts | completed/failed run and repair candidates | customer sync state update | repeatable query; failed records remain visible for operator repair |

### Throughput and failure assumptions

- One active sync per customer; the default poll interval is five minutes.
- A sync searches at most 500 messages and skips sources larger than 12 MiB.
- An invoice contains at most 200 orders and one currency.
- IMAP timeouts are 15 seconds for connect/greeting and 90 seconds for a
  socket. Authentication, timeout, rate-limit, and unknown failures become a
  customer-visible sync state.
- Transient IMAP failures are retried by the next scheduled run. Duplicate
  messages are skipped by the processed-message unique key. Ambiguous AI
  results are rejected and remain unbilled until an operator reviews them.

Terminal states are `completed`, `failed`, or `cancelled` for a run;
`synced`, `warning`, or `error` for a customer; and `draft`, `open`, `paid`,
`void`, or `uncollectible` for an invoice.

### Backfill and reconciliation

Backfill a customer by moving the sync window backward and replaying the same
idempotent extraction/load path. Do not re-import raw bodies. A useful repair
query is:

```sql
SELECT o.id, o.customer_id, o.order_number, o.total_cents
FROM orders o
LEFT JOIN invoice_lines l
  ON l.workspace_id = o.workspace_id AND l.order_id = o.id
WHERE o.billing_invoice_id IS NULL
  AND o.total_cents IS NOT NULL
  AND COALESCE(o.status_override, o.status) <> 'cancelled'
  AND l.id IS NOT NULL;
```

The query identifies orders whose billing pointer and invoice line disagree.
Repair must be an explicit operator action, never an automatic charge.

## Billing and Stripe decision record

The downstream user flow is operator-created service-fee invoices, not retailer
purchase collection. Customers pay retailers with their own cards. ACO Studio
therefore uses Stripe Invoicing only for the ACO fee and never adds the order
purchase total to the amount due. It does not collect card data. Invoice
creation is local and draft-first. Issuing creates fee-only Stripe invoice
items with idempotency keys, finalizes the invoice, and stores only the hosted
URL. A signed webhook updates the local invoice to `open`, `paid`, `void`, or
`uncollectible`.

The Stripe secret and webhook secret are optional in development. Without a
secret, drafts still prove the fee snapshot and the UI explains that Stripe
must be connected before issue. This avoids fake payment success. Before live
use, configure `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, and a webhook
endpoint for invoice events.

## ACO subscriptions and node-group provisioning

Platform subscriptions are a separate billing domain. The intended mapping is
one subscribed ACO owner → one workspace/node group → that ACO's customers,
mailboxes, orders, overrides, and fee invoices. A provider-neutral entitlement
record identifies the subscription provider and external subscription; a
membership associates a verified external user with the workspace; provider
event IDs are deduplicated before state changes.

The future Whop adapter must verify the raw webhook signature against current
primary Whop documentation, translate the event into a versioned provisioning
command, and perform one transaction that deduplicates the event, upserts the
workspace/entitlement/membership, and returns the same workspace on retries.
Cancellation suspends access and polling without deleting tenant data. The
current password login and single-workspace IMAP coordinator remain local-mode
boundaries; they are not represented as Whop authentication or multi-tenant
scheduling until those adapters exist.

## OpenAI/AI decision record

The deterministic parser already handles known retailer and carrier templates,
so it remains the acceptance baseline. The repository currently ships only the
provider interface and redaction/validation boundary. A future provider must
document its verified model/capabilities, structured-output schema, prompt
version, confidence threshold, escalation reason, usage budget, retention
behavior, and evaluation set before being enabled. Low-confidence or malformed
results go to the operator queue rather than changing an order silently.

## Security and rollback

- Every operator API route requires both the service serial access cookie and
  the signed operator session and scopes every query to its workspace. Portal
  links are random, persistent, customer-scoped, and stored as a hash with an
  encrypted recovery value. Legacy signed links are accepted only for transition.
- Mailbox app passwords remain encrypted at rest and are decrypted only for a
  bounded IMAP connection. They are never sent to the browser, Stripe, or a
  model.
- Stripe webhook payloads are verified against the raw body. Event IDs are
  recorded before applying a state change, so retries cannot double-apply.
- Migrations `004_service_fee_tenancy.sql` and `005_beta_access_settings.sql` preserve issued legacy invoice
  snapshots, converts only drafts to service-fee-only totals, and adds the
  provider-neutral node-group entitlement seam. Rollback must preserve invoice
  history and pause issuing before any constraint change; never rewrite paid or
  issued invoices during a routine deploy.

## Acceptance checklist

- [ ] A fresh database and browser show empty states, not seeded records.
- [ ] Operator can connect a Gmail inbox, sync it, and see only that
  customer's orders.
- [ ] Completed, stuck, cancelled, shipped, and confirmed filters work; a
  manual status override appears in both operator and customer timelines.
- [ ] Checkout-total and custom-amount fee edits recalculate the service fee
  and draft fee-only invoice line in one transaction, then are rejected after
  issue.
- [ ] Stripe receives only service-fee cents; purchase totals remain
  informational and no purchase-plus-fee calculation is shown.
- [ ] Retailer, status, and search filters compose without weakening workspace
  or customer scoping.
- [ ] Stripe issue is safe to retry, and webhook replay does not duplicate a
  payment or state transition.
- [ ] Customer portal exposes only normalized orders/invoices for its static
  customer token and payment links point to Stripe-hosted checkout.
- [ ] The operator surface is serial-gated, root marketing is public, and
  `/app/admin/super` remains owner-reserved.
- [ ] Static customer links are stable across repeated link requests, while
  SMTP notifications are configured and tested with non-production recipients.
- [ ] Workspace branding and Venmo URL changes are visible only within that
  workspace and Venmo reconciliation remains an explicit manual action.
