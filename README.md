# ACO Studio

ACO Studio is a secure customer order, shipment, and billing workspace for ACO operators. Connect one Gmail mailbox per customer, scan order-like messages through read-only IMAP, and turn confirmations and shipping updates into a searchable customer dashboard.

## What is implemented

- Customer-by-customer order dashboards with status totals, search, filters, tracking links, and an event timeline.
- A compact operator surface: Overview, Customers, Billing, and per-ACO Settings. Orders and shipments stay inside a customer view instead of becoming separate navigation tabs.
- Gmail app-password verification before a mailbox is saved.
- AES-256-GCM encryption for app passwords at rest. The API never returns them and logs never include them.
- Read-only Gmail IMAP polling of All Mail (with Inbox fallback), message de-duplication, and a bounded Gmail search for order-like mail.
- Generic parsing for order number, merchant, total, confirmed/processing/shipped/delivered/cancelled status, UPS/USPS/FedEx/Amazon tracking, tracking URLs, and estimated delivery dates.
- PostgreSQL workspace isolation with forced row-level security on customer, mailbox, order, shipment, event, processed-message, sync-run, invoice, invoice-line, and Stripe-event tables.
- An operator-password login backed by a signed, `HttpOnly`, `SameSite=Strict` session cookie.
- A customer-facing portal at `/portal/:token`, reached through a persistent random link. The token is stored as a hash plus an encrypted recovery value and only returns that customer's normalized orders. Legacy seven-day signed links remain readable during transition.
- Per-order fee percentages (0–100%, stored as integer basis points) calculated from either the checkout purchase total or a custom amount such as expected sale value or profit.
- Draft invoices snapshot selected service fees, preserve the purchase and fee basis as informational references, and lock fee edits after issue. Stripe Invoicing charges only ACO service fees; signed webhooks update paid/open/void states idempotently.
- Manual status overrides are stored separately from parsed email state and are visible in the customer timeline and portal.
- A beta serial gate protects the operator surface. The serial is server-side (`SERVICE_SERIAL`) and unlocks a signed, HttpOnly access cookie; it is never shipped to the browser.
- `/` is the public marketing site, `/app/dashboard` is the operator app, and `/app/admin/super` is reserved for the service owner.
- Each workspace can set its customer-facing name, HTTPS logo, accent color, seller notification email, and Venmo payment URL. SMTP invoice notifications are optional and disabled until configured.
- A versioned `orders.ingestion.v1` workflow seam separates extract, normalize, deterministic parse, optional AI enrichment, and load stages. The current safe default uses no external model until an approved provider is configured.
- A Docker/PostgreSQL runtime and a Render Blueprint.

Raw email bodies, attachments, customer shipping addresses, and ordinary Gmail passwords are not persisted.

Fee policy: `fee = round(selected fee basis × fee percentage)`. The fee basis is either the checkout purchase total or an operator-entered custom amount. Retailer purchases are paid with the customer's own card and are never added to an ACO invoice; the invoice amount due is the service fee only. A fee can be changed per order, and there is no hidden workspace-wide default.

## Run locally

Requires Node 22.12+ LTS or Node 24+, plus Docker Desktop for PostgreSQL.

```powershell
npm ci --legacy-peer-deps
npm run dev
```

On the first run, the setup script creates a gitignored `.env` with generated
local-only secrets, verifies that Docker Desktop is ready, starts PostgreSQL,
and then starts both the API and Vite. If Docker is stopped or unhealthy,
startup exits with a direct error before Vite starts instead of producing
repeated `/api` proxy errors.

The local Docker database uses host port `55432` so it does not collide with a
native PostgreSQL installation on the standard port `5432`.
Read `OPERATOR_PASSWORD` from `.env`, open `http://127.0.0.1:5173`, and sign
in. ACO Studio starts empty and only shows customers and orders that have been
connected and synchronized.

Use `npm run dev:web` only when an API is already running on port 3001. It
starts Vite by itself, so API requests will otherwise fail with
`ECONNREFUSED 127.0.0.1:3001`.

## Run the live stack with Docker

Create `.env` in the project root. Generate three independent random values in PowerShell:

```powershell
[Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
```

Use one output for `MAILBOX_ENCRYPTION_KEY`, a different output for `SESSION_SECRET`, and a third for `PORTAL_SECRET`:

```dotenv
MAILBOX_ENCRYPTION_KEY=<first generated value>
SESSION_SECRET=<second generated value>
PORTAL_SECRET=<third generated value>
OPERATOR_PASSWORD=<a long unique operator password>
POSTGRES_PASSWORD=<a long local database password>
```

Then start the application and PostgreSQL:

```powershell
docker compose up --build
```

Open `http://localhost:3001` and sign in with `OPERATOR_PASSWORD`. Database migrations run automatically before the web server starts.

Enter the generated beta serial, sign in, and select a customer to copy a static portal link. Render links use the HTTPS `APP_ORIGIN` you configure.

To enable customer fee payments, set `STRIPE_SECRET_KEY` and
`STRIPE_WEBHOOK_SECRET`. The operator creates a service-fee draft from selected
unbilled orders, then chooses **Issue with Stripe**. The hosted Stripe invoice
contains only ACO service fees; purchase totals remain informational. The URL
appears in both Billing and the customer portal. Without those keys, invoice
drafts remain local and no fake payment state is shown.

## Platform subscriptions and node groups

Customer service-fee invoices and ACO platform subscriptions are separate
billing domains. Stripe handles an ACO operator's downstream customer fee
invoices. A future Whop adapter will verify subscription events and provision
one isolated workspace/node group for each subscribed ACO business.

The database includes the provider-neutral workspace, entitlement, membership,
and event-deduplication boundary required for that adapter. No live Whop webhook,
Whop authentication, or subscription checkout is claimed yet. Until that
adapter is implemented, the application continues to start one local workspace
from `WORKSPACE_SLUG` and authenticate it with `OPERATOR_PASSWORD`.

## Run against an existing PostgreSQL database

Copy `.env.example` to `.env`, replace every secret, and set `DATABASE_URL`. Then run:

```powershell
npm run db:migrate
npm run dev:live
```

The Vite client runs at `http://127.0.0.1:5173`; the API runs at `http://127.0.0.1:3001`.

## Gmail connection requirements

The current flow follows the requested Gmail-address + app-password model. Each Google account must have 2-Step Verification enabled before an app password can be created. Enter the generated 16-character app password—not the customer's normal Google password.

For a larger commercial rollout, Google OAuth is the recommended follow-up because customers can grant and revoke access without sharing an app password.

## Deploy on Render

`render.yaml` creates the Node web service and PostgreSQL database. During Blueprint setup:

Docker is not required for this deployment. The Blueprint uses Render's native
Node runtime, which runs the existing `npm run build` and `npm start` commands;
the included `Dockerfile` remains an optional local or reproducible-container
deployment path.

1. Set `SERVICE_SERIAL` and `OPERATOR_PASSWORD` to long unique values.
2. Set `APP_ORIGIN` to the final HTTPS origin, for example `https://aco-studio.onrender.com`.
3. Keep the generated `MAILBOX_ENCRYPTION_KEY`, `SESSION_SECRET`, and `PORTAL_SECRET` permanently. Losing or rotating the mailbox key without a migration makes existing mailbox secrets unreadable; rotating the portal key invalidates existing customer links.
4. Deploy, check `/api/health`, activate the service with `SERVICE_SERIAL`, sign in, set each order's fee percentage in the inspector, and copy a static customer portal link.

SMTP notifications use `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`,
`SMTP_PASSWORD`, and `SMTP_FROM`. Set `NOTIFICATION_SELLER_EMAIL` as a fallback,
then refine the seller recipient per ACO in Settings. Set `VENMO_PAYMENT_URL` as
an optional initial value or configure it per ACO in Settings. Venmo is an
external payment link; it does not mark an invoice paid automatically. Reconcile
Venmo payments manually or through a future provider webhook.

Configure the Stripe webhook endpoint at `/api/stripe/webhook` for invoice
finalization, payment, failure, void, and uncollectible events. The endpoint
verifies Stripe's signature against the raw request body and deduplicates event
IDs before updating local invoice state.

The Blueprint generates the mailbox, session, and portal secrets and wires `DATABASE_URL` from the managed PostgreSQL connection string. No deployment has been performed from this repository yet.

## Verification commands

```powershell
npm run typecheck
npm test
npm run build
```

Parser and encryption unit tests live in `tests/`. The design sources and native-size browser comparison captures live under `design/`.

The implementation contract and future workflow/AI task boundaries are in
[`docs/architecture.md`](docs/architecture.md).

## Current parser boundary

The parser is intentionally deterministic and provider-neutral. It covers common order and carrier formats, but retailer templates change. Add sanitized `.eml` fixtures and parser rules as new formats are encountered. The service stores only normalized facts and limited message metadata, so adding a new rule does not require retaining historical email bodies.
