# Carrier tracking setup

The shared tracking service supports UPS, USPS, and FedEx for both ACO and Solo Buyer orders. It reads tracking numbers already found in order emails, requests current carrier status and expected delivery, and records updates in the same order timeline. All credentials stay on the server.

## Credentials

| Carrier | Where to get access | Server environment variables |
| --- | --- | --- |
| UPS | Sign in to the [UPS Developer Portal](https://developer.ups.com/), create an application, and include the Tracking API product. Complete the shipper-account/access requirements shown for your application. | `UPS_CLIENT_ID`, `UPS_CLIENT_SECRET`; optional `UPS_TRANSACTION_SRC=aco-studio` |
| USPS | Create an account/application in the [USPS API Developer Portal](https://developers.usps.com/), enroll through USPS business onboarding, and request tracking permissions appropriate to your business. The app's Consumer Key and Consumer Secret are the OAuth client ID and secret. | `USPS_CLIENT_ID`, `USPS_CLIENT_SECRET` |
| FedEx | In the [FedEx Developer Portal](https://developer.fedex.com/), create an organization/project, include Basic Integrated Visibility (tracking), and complete the production process for your business type. Use API Key and Secret Key from the project credentials. | `FEDEX_API_KEY`, `FEDEX_SECRET_KEY`; optional `FEDEX_ACCOUNT_NUMBER` |

Follow the official [UPS onboarding/support](https://developer.ups.com/support) and [FedEx getting-started instructions](https://developer.fedex.com/api/en-us/get-started.html). This product provides a service for third parties: select the corresponding integrator/service-provider business type and confirm redistribution/use rights rather than claiming to be the shipper for every retail parcel.

### USPS access limitation

USPS changed tracking access on April 1, 2026. Its [current API access policy](https://www.usps.com/business/api-access.htm) distinguishes shippers, platforms/consolidators, and other service providers. Platforms need shipper authorization; reporting/analytics services may need paid access, an IP agreement, and authorization covering specific mailer IDs or tracking numbers. A normal developer key does **not** guarantee permission to track arbitrary retail purchases for recipients.

Request the appropriate USPS access before enabling it for customers. This adapter supports client-credential OAuth and authorized tracking requests; it does not implement USPS Merchant Access Token enrollment or acquire merchant authorization automatically. If USPS requires additional authorization headers/flows for the approved agreement, those must be implemented against the issued agreement before launch. Until then, email-derived USPS shipment updates and official tracking links remain available.

## Environment and verification

```dotenv
TRACKING_ENVIRONMENT=sandbox
USPS_CLIENT_ID=
USPS_CLIENT_SECRET=
UPS_CLIENT_ID=
UPS_CLIENT_SECRET=
UPS_TRANSACTION_SRC=aco-studio
FEDEX_API_KEY=
FEDEX_SECRET_KEY=
FEDEX_ACCOUNT_NUMBER=
TRACKING_SYNC_INTERVAL_MINUTES=30
TRACKING_MAX_SHIPMENTS_PER_SYNC=100
```

Use the test credentials and sample tracking numbers supplied by each provider. The environment switch applies to all carriers. Do not mix test keys with production hosts. Switch to `TRACKING_ENVIRONMENT=production` and production credentials only after access is approved; restart the server after configuration changes.

| Environment | UPS | USPS | FedEx |
| --- | --- | --- | --- |
| Production | `https://onlinetools.ups.com` | `https://apis.usps.com` | `https://apis.fedex.com` |
| Sandbox | `https://wwwcie.ups.com` | `https://apis-tem.usps.com` | `https://apis-sandbox.fedex.com` |

The endpoints used are UPS `/security/v1/oauth/token` and `/api/track/v1/details/{number}`, USPS `/oauth2/v3/token` and `/tracking/v3/tracking/{number}`, and FedEx `/oauth/token` and `/track/v1/trackingnumbers`. USPS OAuth uses JSON; UPS uses Basic authentication with a form grant; FedEx uses form client credentials. Access tokens are cached and concurrent token requests coalesced.

In a Solo Buyer dashboard, **Configured** only means keys are present; it is not a successful-connection guarantee. Choose **Refresh tracking** with a shipment whose tracking number belongs to an authorized test/customer account. The dashboard shows progress, last check, and errors. Sandbox data is clearly labeled. Verify the resulting status, delivery date, and timeline against the carrier's own tracking page before customer rollout.

Requests time out after eight seconds. Manual refreshes have a per-account cooldown of one minute. Scheduled checks default to 30 minutes and 100 active shipments per account. Delivered and cancelled shipments stop polling. Missing credentials, unsupported carriers, or carrier errors preserve existing email-derived order facts and links. API quotas and pricing are governed by each provider agreement, not by these local limits.

No live carrier account was authenticated as part of this change. Adapter tests use mocked official request/response shapes; real credentials and authorized tracking numbers are required for end-to-end verification. Advanced FedEx authenticated-delivery products and carrier webhooks are not implemented.
