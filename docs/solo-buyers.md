# Individual and ACO customer access

Order Tracker Pro uses a product-specific Whop license followed by Discord
linking. Individuals and ACO operators enter the license for their own product;
password and workspace-name sign-in are not used.
The browser receives a signed, HttpOnly cookie; no serial, password, or Discord
OAuth token is stored in the browser.

## Production setup

Set these Render environment variables:

```text
APP_ORIGIN=https://ordertracker.pro
DISCORD_CLIENT_ID=<Discord application client ID>
DISCORD_CLIENT_SECRET=<Discord application client secret>
DISCORD_REDIRECT_URI=https://ordertracker.pro/oauth/discord
WHOP_API_KEY=<Whop API key>
WHOP_WEBHOOK_SECRET=<Whop webhook signing secret, including the ws_ prefix>
WHOP_ACCOUNT_ID=biz_1HjUYXgisSyf7z
WHOP_SOLO_PRODUCT_ID=prod_3mqbBwetOGv5G
WHOP_ACO_PRODUCT_ID=prod_SiiEh8TDBF2nk
WHOP_SOLO_PLAN_ID=<existing Individuals pricing plan ID, starts with plan_>
WHOP_ACO_PLAN_ID=<existing ACO pricing plan ID, starts with plan_>
```

The account and product IDs are public identifiers and are already in
`render.yaml`. Keep the Discord secret, Whop API key, and webhook secret as
Render secret values. Do not put them in Vite variables or commit them. Plan IDs
are not secrets, but keep them server-side so the configured plans can be
validated against the matching Whop products before checkout.

## Discord Developer Portal

Create or open the Discord application, then add this exact OAuth2 redirect:

```text
https://ordertracker.pro/oauth/discord
https://ordertracker.pro/api/solo/auth/discord/callback
```

Select only the `identify` OAuth scope. This application uses Discord to
verify the user's immutable Discord ID and username. It does not need the
`email`, `guilds`, `guilds.join`, `connections`, `bot`, or
`applications.commands` scopes. A bot user and bot token are not required for
website authentication.

The implementation uses the authorization-code flow, a signed short-lived
state cookie, and a server-side code exchange. See Discord's
[OAuth2 documentation](https://docs.discord.com/developers/topics/oauth2).

## Whop setup

In Whop, configure the webhook endpoint:

```text
https://ordertracker.pro/api/whop/webhook
```

Send the membership and payment events needed for access reconciliation:

- `membership.activated`
- `membership.deactivated`
- `membership.cancel_at_period_end_changed`
- `payment.succeeded`
- `payment.failed`

The server pins the Whop webhook contract to API version `v1` and API version
date `2026-09-15`. It validates the raw-body HMAC signature, checks the Whop
account ID, deduplicates event IDs, and fetches the current membership before
changing access. A `payment.failed` event immediately places the membership on a
durable access hold; the hold clears only after successful payment or a new
activation is verified. `membership.deactivated` and other non-active membership
states also remove access without deleting the workspace or its data.

The server retrieves memberships from Whop with the API key. It checks the exact
license key, product ID, seller account, membership status, and current period
before the buyer can link Discord.

Create a pricing plan for each product in Whop and copy its `plan_...` ID from
**Dashboard → Checkout Links → plan details**. Set the two `WHOP_*_PLAN_ID`
variables above and give the API key the Whop checkout-configuration permissions
shown for `checkout_configuration:create` (including plan and access-pass
permissions required by that endpoint).
The app creates a checkout configuration for that existing plan and embeds the
returned Whop session. Whop remains the payment processor and license issuer;
enable Whop's software license/key generation for each product and test that a
purchased membership includes its license key. The app rejects plans that do
not match the configured Whop company and product IDs.

## What happens after a purchase

1. The user buys through embedded checkout or a Whop-hosted checkout link.
2. Whop creates the membership and product license; the signed webhook is
   durably queued and the worker verifies current membership state.
3. A valid Solo purchase creates a private Solo service, mailbox allowance,
   and default `/customer/...` route. A valid ACO purchase creates a private
   workspace and default `/app/workspaces/...` route.
4. The user enters the key for the matching product and links Discord to open
   the corresponding dashboard.
5. Future visits to `/` detect the signed cookie and forward the user to the
   stored dashboard path.

Whop access is checked again every 15 minutes and uses a one-hour fail-closed
lease. Cancellation, deactivation, or failed payment removes application access
without deleting the user's workspace, mailboxes, or order history. A
failed-payment hold remains until a successful payment or reactivation is
verified. Manual services remain manually controlled until explicitly linked
to a Whop membership.

## Existing services

Existing Individual and ACO customers enter the license key for that product,
then link Discord. ACO workspace name and custom path can be changed later in
workspace settings. Each service is linked to one Discord identity.

Individual Solo serials are still created from the Render service shell:

```text
npm run solo:provision -- --handle buyer.name --name "Buyer Name" --days 30 --mailbox-limit 5
```

The command prints the serial once; only its hash is stored. Rotate a lost
serial with `--rotate`, which invalidates existing Solo sessions. See the
`solo:provision` command help for the remaining owner-only options.

## Security and operating notes

- Cookies are signed with `SESSION_SECRET`, HttpOnly, Secure in production,
  and SameSite Strict. OAuth state uses a separate short-lived SameSite Lax
  cookie for the provider redirect.
- Access is checked server-side on every protected request; changing a URL or
  dashboard path cannot switch tenants.
- The webhook returns a retryable 5xx on database/provider failures and a 4xx
  for malformed or unsigned requests. Whop retries are safe because event IDs
  and membership provisioning are idempotent.
- The current worker processes up to 10 queued/recheck jobs per five seconds.
  Before a large launch, move reconciliation to a dedicated queue/worker or
  increase capacity with metrics and provider quota review.
