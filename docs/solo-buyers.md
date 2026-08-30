# Solo Buyer service

Solo Buyers and ACO companies use separate sign-in flows, sessions, and APIs. Solo Buyers connect their own Gmail inboxes and see combined or per-inbox orders, purchase totals by currency, items, tracking, and delivery timelines. There are no invoices, service-fee controls, customer management, or sharing links in this product.

## Issue individual access

After deploying/migrating, run this command from the application directory with the server environment configured:

```powershell
npm run solo:provision -- --handle buyer.name --name "Buyer Name" --days 30 --mailbox-limit 5
```

The command prints `/customer/buyer.name` and a unique `solo_…` serial once. Deliver it privately to that buyer: it is a login credential. Only its SHA-256 hash is stored. The existing ACO `SERVICE_SERIAL` never unlocks Solo Buyer accounts. This command is service-owner tooling, not a public signup endpoint.

Open `/customer`, enter the individual serial, and connect Gmail inboxes. Each inbox requires its own Gmail app password, with the existing read-only IMAP verification and encryption. The first sync starts automatically. Current mailbox support is Gmail; Discord sign-in does not grant email access.

`--days` sets the access duration and `--mailbox-limit` sets a separate account limit. Expired or suspended accounts cannot sign in, call personal APIs, or enter scheduled polling. All personal data is retained on expiry. There is no automatic paid checkout or subscription webhook yet; connect a verified billing entitlement flow to provisioning before offering unattended paid signup.

Replace a lost or compromised serial:

```powershell
npm run solo:provision -- --handle buyer.name --rotate
```

This invalidates the previous serial and all existing Solo sessions. Use the current handle after Discord linking.

Extend purchased access with `npm run solo:provision -- --handle buyer.name --renew --days 30`. This adds days to active access or starts from now for expired access; it does not change the serial or override a suspended tenant.

## Discord sign-in

1. Create an application in the [Discord Developer Portal](https://discord.com/developers/applications).
2. In OAuth2, obtain the application's client ID and client secret. Set `DISCORD_CLIENT_ID` and `DISCORD_CLIENT_SECRET` on the server, never in frontend/Vite variables. A bot token is not used.
3. Add an exact OAuth2 redirect URL: `https://YOUR-DOMAIN/api/solo/auth/discord/callback`. It must match `APP_ORIGIN` plus this path. Local development uses `http://127.0.0.1:5173/api/solo/auth/discord/callback`.
4. Restart the server. Buyers can sign in with their serial, choose **Connect Discord**, and authorize the basic `identify` scope. Future visits can use **Continue with Discord** without the serial.

Alternatively, pre-link a paid buyer at provisioning by appending `--discord-id 123456789012345678` using their verified Discord user ID. Discord login alone never creates an unentitled account.

The route follows the verified Discord username, such as `/customer/buyer.name`. Before linking, it uses the reserved handle supplied by the service owner. If a username is already reserved by another personal account, the existing handle is retained. Authorization always uses the immutable account ID and verified Discord ID, never the username in the URL. Visiting another handle cannot expose that person's data: a signed-in user returns to their own dashboard.

The implementation follows Discord's [authorization code flow](https://docs.discord.com/developers/topics/oauth2), validates a short-lived signed state cookie, and discards OAuth tokens after fetching the verified user identity. Serial and Discord login both require active personal access.

## Shared core, separate product boundaries

- A Solo account owns an internal tenant record marked `product_type='solo'`; the UI and API do not expose workspace routes or ACO branding/settings. This preserves the existing PostgreSQL row-level isolation without copying the ingestion system.
- `/api/solo/*` uses `solo_session`; ACO sessions and credentials cannot access it. Solo tenants are excluded from ACO password lookup. All personal mailbox/order queries use the account from the session, not a client-supplied tenant ID.
- Personal dashboard responses omit fee amounts, fee rules, invoice IDs, and billing status. Currency totals never combine different currencies or treat unknown totals as zero purchases. Summaries and filters include all parsed personal orders; the table shows 50 matching orders per page, without the ACO dashboard's 2,000-order cutoff.
- Mailbox caps are checked while holding the tenant row lock, preventing simultaneous connections from exceeding the account limit.
- Gmail and carrier jobs reuse the existing parsing, deterministic order updates, encrypted credential storage, and shipment history.
- Carrier keys are service-level secrets shared by the trusted server. See [tracking setup](tracking-setup.md) for approvals, test environments, and current limitations.

Migration `010_solo_buyers` adds personal accounts and defaults all existing tenants to the ACO product. The trusted server must exclusively hold database credentials; the account/tenant authentication directory is not a browser-accessible database API. Production scaling still requires measured queue capacity and provider quotas, rather than assuming hundreds of simultaneous inbox jobs are safe.
