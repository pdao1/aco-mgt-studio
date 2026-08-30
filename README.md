# ACO Studio

ACO Studio is a secure customer order, shipment, and billing workspace for ACO operators. Connect one Gmail mailbox per customer, scan order-like messages through read-only IMAP, and turn confirmations and shipping updates into a searchable customer dashboard.

## What is implemented

- Customer-by-customer order dashboards with status totals, search, filters, tracking links, and an event timeline.
- A compact operator surface: Overview, Customers, Billing, and per-ACO Settings. Orders and shipments stay inside a customer view instead of becoming separate navigation tabs.
- Gmail app-password verification before a mailbox is saved.
- AES-256-GCM encryption for app passwords at rest. The API never returns them and logs never include them.
- Read-only Gmail IMAP polling of All Mail (with Inbox fallback), header-first message de-duplication, and a bounded Gmail search for order-like mail. Previously processed Message-IDs are not downloaded again on each refresh.
- Cheap mailbox gates ignore one-time PIN/verification-code mail and oversized non-order messages before MIME parsing; skipped messages are recorded as processed so the same noise is not revisited.
- Generic parsing for order number, merchant, total, pending/confirmed/processing/shipped/delivered/cancelled status, UPS/USPS/FedEx/Amazon tracking, tracking URLs, and estimated delivery dates. Generic acknowledgements stay pending until a matching explicit confirmation email is seen.
- PostgreSQL workspace isolation with forced row-level security on customer, mailbox, order, shipment, event, processed-message, sync-run, invoice, invoice-line, and Stripe-event tables.
- Per-workspace operator passwords stored as salted scrypt hashes, backed by a signed, `HttpOnly`, `SameSite=Strict` session cookie.
- A customer-facing portal at `/portal/:token`, reached through a persistent random link. The token is stored as a hash plus an encrypted recovery value and only returns that customer's normalized orders. Legacy seven-day signed links remain readable during transition.
- Per-order fee percentages (0–100%, stored as integer basis points) calculated from either the checkout purchase total or a custom amount such as expected sale value or profit.
- Draft invoices snapshot selected service fees, preserve the purchase and fee basis as informational references, and lock fee edits after issue. Stripe Invoicing charges only ACO service fees; signed webhooks update paid/open/void states idempotently.
- Manual status overrides are stored separately from parsed email state and are visible in the customer timeline and portal.
- Selecting an order opens an item overview with extracted product names, quantities, and available line prices for both the operator and customer views.
- Mailbox sync scans the bounded customer mailbox window instead of depending on retailer subject keywords. It matches order numbers against the customer's existing orders before applying updates, so different retailer sender addresses do not create duplicate orders or miss cancellations.
- Order identifiers must contain at least one digit. Legacy prose-only parser artifacts are excluded from dashboards and billing without deleting the underlying history.
- A beta serial gate protects the operator surface. The serial is server-side (`SERVICE_SERIAL`) and unlocks a signed, HttpOnly access cookie; it is never shipped to the browser.
- `/` is the public marketing site, `/app/dashboard` is the operator app, and `/app/admin/super` is reserved for the service owner.
- Each workspace can set its ACO Company Name, one of four light or four dark themes, operator password, HTTPS logo, accent color, seller notification email, and Venmo payment URL. Company identity and themes apply to the operator dashboard and customer portal; new Stripe invoices and invoice emails include the company name. Drafts follow name changes; issued invoice names are preserved. SMTP invoice notifications are optional and disabled until configured.
- A versioned `orders.ingestion.v1` workflow seam separates extract, normalize, deterministic parse, optional AI item review/order repair, and load stages. With `OPENAI_KEY`, a bounded GPT-5 nano pass reviews suspicious item rows or repairs an order-like message that deterministic parsing could not normalize. Each message gets at most two structured attempts, and the second attempt receives explicit validation feedback; without it, sync stays deterministic and network-free beyond Gmail.
- Optional server-side USPS, UPS, and FedEx tracking polling updates shipment status and expected delivery without exposing carrier credentials to the browser. Each provider requires its own developer account/keys; the adapters do not call a carrier when credentials are absent.
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
Open `http://127.0.0.1:5173/app`, enter `SERVICE_SERIAL` from `.env`, then choose **New company? Create a workspace**. Choose a unique workspace ID, company name, and password (at least 12 characters). ACO Studio starts empty and only shows customers and orders that have been
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
POSTGRES_PASSWORD=<a long local database password>
```

Then start the application and PostgreSQL:

```powershell
docker compose up --build
```

Open `http://localhost:3001/app`, activate service access, and create or sign in to your company workspace. Database migrations run automatically before the web server starts.

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

Workspace registration is currently protected by the platform service serial, not subscription entitlements. Each company chooses a unique workspace ID and password at `/app`; its stable sign-in link is `/app/workspaces/:slug`. Settings and credentials are tenant-scoped. Mailbox and carrier polling visit active workspaces, and Stripe events route using workspace metadata.

For existing installations only, `OPERATOR_PASSWORD`, `WORKSPACE_SLUG`, and `WORKSPACE_NAME` remain optional bootstrap inputs. The password is imported once as a salted hash. Subsequent restarts never reset a workspace's saved name, password, or status. Remove the legacy password from the environment after migration. Existing installations can sign in using workspace ID `default` (or their configured slug). Company name changes do not change the workspace ID or customer links. Changing the workspace password invalidates other operator sessions. Historical invoices without an issuer snapshot remain unbranded rather than being relabeled retroactively.

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

1. Set `SERVICE_SERIAL` to a long unique value. Each company creates its own workspace password in the app.
2. Set `APP_ORIGIN` to the final HTTPS origin, for example `https://aco-studio.onrender.com`.
3. Keep the generated `MAILBOX_ENCRYPTION_KEY`, `SESSION_SECRET`, and `PORTAL_SECRET` permanently. Losing or rotating the mailbox key without a migration makes existing mailbox secrets unreadable; rotating the portal key invalidates existing customer links.
4. Deploy, check `/api/health`, activate the service with `SERVICE_SERIAL`, sign in, set each order's fee percentage in the inspector, and copy a static customer portal link.
5. Optionally set `OPENAI_KEY` to enable the bounded item-row quality pass. The default `OPENAI_MODEL=gpt-5-nano` and `OPENAI_MAX_REVIEWS_PER_SYNC=25` keep it limited; leave the key blank for deterministic-only operation.
6. Optionally configure carrier developer credentials (`USPS_CLIENT_ID`/`USPS_CLIENT_SECRET`, `UPS_CLIENT_ID`/`UPS_CLIENT_SECRET`, and `FEDEX_API_KEY`/`FEDEX_SECRET_KEY`). The server polls active shipments every `TRACKING_SYNC_INTERVAL_MINUTES` (default 30) and stops polling delivered/cancelled shipments. USPS, UPS, and FedEx each require a registered developer project even where the basic tracking tier is free.

SMTP notifications use `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`,
`SMTP_PASSWORD`, and `SMTP_FROM`. Set seller notification email and Venmo payment URL
per ACO in Settings. Venmo is an
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

Parser, workflow, carrier-adapter, and encryption unit tests live in `tests/`. The design sources and native-size browser comparison captures live under `design/`.

The implementation contract and future workflow/AI task boundaries are in
[`docs/architecture.md`](docs/architecture.md).

## Current parser boundary

The parser is intentionally deterministic and provider-neutral. It covers common
order and carrier formats, requires explicit evidence before accepting an item
row, and rejects common recommendation/category/CSS/link/UI fragments. When
configured, the server can ask the low-cost GPT-5 nano reviewer to clean up
suspicious item lists or repair an order-like message that deterministic parsing
could not normalize. The model receives only a redacted, bounded text excerpt
and strict JSON schema; order-repair responses must contain an order number
copied from the email, and deterministic identity/status remain authoritative
whenever available. Each message has at most two repair attempts and the
per-sync `OPENAI_MAX_REVIEWS_PER_SYNC` budget applies to all attempts. Set
`OPENAI_KEY` and optionally `OPENAI_MODEL` and `OPENAI_MAX_REVIEWS_PER_SYNC` in
the server environment. Add sanitized `.eml` fixtures and parser rules as new
retailer formats are encountered. The service stores only normalized facts and
limited message metadata, so adding a new rule does not require retaining
historical email bodies.
