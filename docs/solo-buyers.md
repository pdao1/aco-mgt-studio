# Customer access and Solo Buyer service

ACO Studio uses one Discord-first identity flow for both products. A user signs
in with Discord, then either links an existing Solo serial or ACO workspace
credentials, or lets a verified Whop purchase provision access automatically.
The browser receives a signed, HttpOnly cookie; no serial, password, or Discord
OAuth token is stored in the browser.

## Production setup

Set these Render environment variables:

```text
APP_ORIGIN=https://aco-studio.onrender.com
DISCORD_CLIENT_ID=<Discord application client ID>
DISCORD_CLIENT_SECRET=<Discord application client secret>
DISCORD_REDIRECT_URI=https://aco-studio.onrender.com/oauth/discord
WHOP_API_KEY=<Whop API key>
WHOP_WEBHOOK_SECRET=<Whop webhook signing secret, including the ws_ prefix>
WHOP_ACCOUNT_ID=biz_1HjUYXgisSyf7z
WHOP_SOLO_PRODUCT_ID=prod_3mqbBwetOGv5G
WHOP_ACO_PRODUCT_ID=prod_SiiEh8TDBF2nk
```

The account and product IDs are public identifiers and are already in
`render.yaml`. Keep the Discord secret, Whop API key, and webhook secret as
Render secret values. Do not put them in Vite variables or commit them.

## Discord Developer Portal

Create or open the Discord application, then add this exact OAuth2 redirect:

```text
https://aco-studio.onrender.com/oauth/discord
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
https://aco-studio.onrender.com/api/whop/webhook
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
changing access. Configure Whop's Connected Accounts so buyers can link Discord
to their Whop account. A purchase without a linked Discord account is recorded
but does not grant an application login.

The server retrieves current memberships and user profiles from Whop with the
API key. It checks product ID, seller account, membership status, current
period, and the buyer's primary Discord connection before granting access.

## What happens after a purchase

1. The user signs in at `/` or `/login` with Discord.
2. The webhook is durably queued and the worker verifies the current Whop
   membership.
3. A valid Solo purchase creates a private Solo service, mailbox allowance,
   and default `/customer/...` route. A valid ACO purchase creates a private
   workspace and default `/app/workspaces/...` route.
4. The user chooses **Check purchase access**. The browser remembers the linked
   Discord identity for up to 30 days, capped by Solo access expiry.
5. Future visits to `/` detect the signed cookie and forward the user to the
   stored dashboard path.

Whop access is checked again every 15 minutes and uses a one-hour fail-closed
lease. Cancellation or failed reconciliation therefore removes application
access without deleting the user's mailbox or order history. Manual services
remain manually controlled until they are explicitly linked to a Whop
membership.

## Existing services

An existing Solo customer selects **Solo Buyer** and enters the serial once.
An existing ACO operator selects **ACO workspace** and enters the workspace ID
and password once. The service is then bound to that Discord ID. A service can
only be linked to one Discord identity, while a Discord identity can own both a
Solo service and an ACO workspace.

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
