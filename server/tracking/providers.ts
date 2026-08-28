import { randomUUID } from 'node:crypto';
import type { ParsedOrderStatus } from '../email/parser.js';

export interface TrackingSnapshot {
  carrier: string;
  trackingNumber: string;
  status: ParsedOrderStatus;
  expectedDelivery: Date | null;
  deliveredAt: Date | null;
  trackingUrl: string | null;
}

export interface CarrierTrackingProvider {
  readonly name: string;
  readonly configured: boolean;
  track(trackingNumber: string): Promise<TrackingSnapshot | null>;
}

interface OAuthTokenResponse {
  access_token?: unknown;
  expires_in?: unknown;
}

const REQUEST_TIMEOUT_MS = 8_000;

export class UspsTrackingProvider implements CarrierTrackingProvider {
  readonly name = 'USPS';
  readonly configured: boolean;
  private readonly token = new OAuthTokenCache();

  constructor(
    private readonly clientId: string | null,
    private readonly clientSecret: string | null,
    private readonly baseUrl = 'https://apis.usps.com',
  ) {
    this.configured = Boolean(clientId && clientSecret);
  }

  async track(trackingNumber: string): Promise<TrackingSnapshot | null> {
    if (!this.configured) return null;
    const accessToken = await this.token.get(() => requestOAuthToken(
      `${this.baseUrl}/oauth2/v3/token`,
      this.clientId!,
      this.clientSecret!,
      false,
    ));
    const response = await fetchWithTimeout(
      `${this.baseUrl}/tracking/v3/tracking/${encodeURIComponent(trackingNumber)}?expand=summary`,
      { headers: { accept: 'application/json', authorization: `Bearer ${accessToken}` } },
    );
    const body = await readJson(response);
    const status = normalizeCarrierStatus(firstString(body, [
      ['statusCategory'], ['status'], ['statusSummary'], ['trackingEvents', '0', 'eventType'],
    ]));
    if (!status) return null;
    return {
      carrier: this.name,
      trackingNumber,
      status,
      expectedDelivery: parseDate(firstValue(body, [
        ['deliveryDateExpectation', 'expectedDeliveryDate'], ['expectedDeliveryDate'],
      ])),
      deliveredAt: status === 'delivered' ? parseDate(firstValue(body, [
        ['deliveryDateExpectation', 'actualDeliveryDate'], ['actualDeliveryDate'], ['trackingEvents', '0', 'dateTime'],
      ])) : null,
      trackingUrl: `https://tools.usps.com/go/TrackConfirmAction?tLabels=${encodeURIComponent(trackingNumber)}`,
    };
  }
}

export class UpsTrackingProvider implements CarrierTrackingProvider {
  readonly name = 'UPS';
  readonly configured: boolean;
  private readonly token = new OAuthTokenCache();

  constructor(
    private readonly clientId: string | null,
    private readonly clientSecret: string | null,
    private readonly transactionSource = 'aco-studio',
    private readonly apiBaseUrl = 'https://onlinetools.ups.com',
  ) {
    this.configured = Boolean(clientId && clientSecret);
  }

  async track(trackingNumber: string): Promise<TrackingSnapshot | null> {
    if (!this.configured) return null;
    const accessToken = await this.token.get(() => requestOAuthToken(
      `${this.apiBaseUrl}/security/v1/oauth/token`,
      this.clientId!,
      this.clientSecret!,
      true,
    ));
    const response = await fetchWithTimeout(
      `${this.apiBaseUrl}/api/track/v1/details/${encodeURIComponent(trackingNumber)}?locale=en_US&returnSignature=false`,
      {
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${accessToken}`,
          transId: randomUUID(),
          transactionSrc: this.transactionSource,
        },
      },
    );
    const body = await readJson(response);
    const status = normalizeCarrierStatus(firstString(body, [
      ['trackResponse', 'shipment', '0', 'package', '0', 'currentStatus', 'description'],
      ['trackResponse', 'shipment', '0', 'package', '0', 'currentStatus', 'code'],
      ['shipment', '0', 'package', '0', 'currentStatus', 'description'],
    ]));
    if (!status) return null;
    return {
      carrier: this.name,
      trackingNumber,
      status,
      expectedDelivery: parseDate(firstValue(body, [
        ['trackResponse', 'shipment', '0', 'package', '0', 'deliveryDate', '0', 'date'],
        ['shipment', '0', 'package', '0', 'deliveryDate', '0', 'date'],
      ])),
      deliveredAt: status === 'delivered' ? new Date() : null,
      trackingUrl: `https://www.ups.com/track?tracknum=${encodeURIComponent(trackingNumber)}`,
    };
  }
}

export class FedexTrackingProvider implements CarrierTrackingProvider {
  readonly name = 'FedEx';
  readonly configured: boolean;
  private readonly token = new OAuthTokenCache();

  constructor(
    private readonly apiKey: string | null,
    private readonly secretKey: string | null,
    private readonly accountNumber: string | null = null,
    private readonly baseUrl = 'https://apis.fedex.com',
  ) {
    this.configured = Boolean(apiKey && secretKey);
  }

  async track(trackingNumber: string): Promise<TrackingSnapshot | null> {
    if (!this.configured) return null;
    const accessToken = await this.token.get(() => requestOAuthToken(
      `${this.baseUrl}/oauth/token`,
      this.apiKey!,
      this.secretKey!,
      false,
    ));
    const response = await fetchWithTimeout(`${this.baseUrl}/track/v1/trackingnumbers`, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        includeDetailedScans: true,
        trackingInfo: [{ trackingNumberInfo: { trackingNumber } }],
        ...(this.accountNumber ? { accountNumber: { value: this.accountNumber } } : {}),
      }),
    });
    const body = await readJson(response);
    const status = normalizeCarrierStatus(firstString(body, [
      ['output', 'completeTrackResults', '0', 'trackResults', '0', 'latestStatusDetail', 'description'],
      ['output', 'completeTrackResults', '0', 'trackResults', '0', 'latestStatusDetail', 'statusByLocale'],
      ['output', 'completeTrackResults', '0', 'trackResults', '0', 'latestStatusDetail', 'code'],
    ]));
    if (!status) return null;
    return {
      carrier: this.name,
      trackingNumber,
      status,
      expectedDelivery: parseDate(firstValue(body, [
        ['output', 'completeTrackResults', '0', 'trackResults', '0', 'estimatedDeliveryTimeWindow', 'window', 'begins'],
        ['output', 'completeTrackResults', '0', 'trackResults', '0', 'dateAndTimes', '0', 'dateTime'],
      ])),
      deliveredAt: status === 'delivered' ? parseDate(firstValue(body, [
        ['output', 'completeTrackResults', '0', 'trackResults', '0', 'dateAndTimes', '0', 'dateTime'],
      ])) ?? new Date() : null,
      trackingUrl: `https://www.fedex.com/fedextrack/?trknbr=${encodeURIComponent(trackingNumber)}`,
    };
  }
}

export class CompositeCarrierTrackingProvider {
  readonly name = 'carrier-api';
  private readonly providers: Record<string, CarrierTrackingProvider>;

  constructor(providers: CarrierTrackingProvider[]) {
    this.providers = Object.fromEntries(providers.map((provider) => [provider.name.toLowerCase(), provider]));
  }

  get configured(): boolean {
    return Object.values(this.providers).some((provider) => provider.configured);
  }

  async track(carrier: string | null, trackingNumber: string): Promise<TrackingSnapshot | null> {
    const normalizedCarrier = carrier?.trim().toLowerCase() ?? '';
    const direct = this.providers[normalizedCarrier];
    if (direct?.configured) return direct.track(trackingNumber);
    const inferred = inferCarrier(trackingNumber);
    const provider = inferred ? this.providers[inferred.toLowerCase()] : undefined;
    return provider?.configured ? provider.track(trackingNumber) : null;
  }
}

class OAuthTokenCache {
  private accessToken: string | null = null;
  private expiresAt = 0;

  async get(load: () => Promise<{ token: string; expiresIn: number }>): Promise<string> {
    if (this.accessToken && Date.now() < this.expiresAt) return this.accessToken;
    const next = await load();
    this.accessToken = next.token;
    this.expiresAt = Date.now() + Math.max(30, next.expiresIn - 60) * 1000;
    return next.token;
  }
}

async function requestOAuthToken(
  url: string,
  clientId: string,
  clientSecret: string,
  basicAuth: boolean,
): Promise<{ token: string; expiresIn: number }> {
  const headers: Record<string, string> = { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' };
  const body = new URLSearchParams({ grant_type: 'client_credentials' });
  if (basicAuth) headers.authorization = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`;
  else {
    body.set('client_id', clientId);
    body.set('client_secret', clientSecret);
  }
  const response = await fetchWithTimeout(url, { method: 'POST', headers, body: body.toString() });
  const payload = await readJson(response) as OAuthTokenResponse;
  if (typeof payload.access_token !== 'string' || payload.access_token.length < 10) throw new Error('carrier OAuth returned no access token');
  const expiresIn = typeof payload.expires_in === 'number' ? payload.expires_in : Number(payload.expires_in) || 900;
  return { token: payload.access_token, expiresIn };
}

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!response.ok) throw new Error(`carrier API HTTP ${response.status}`);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error('carrier API returned invalid JSON');
  }
}

function firstValue(value: unknown, paths: string[][]): unknown {
  for (const path of paths) {
    let current: unknown = value;
    for (const segment of path) {
      if (Array.isArray(current)) current = current[Number(segment)];
      else if (current && typeof current === 'object') current = (current as Record<string, unknown>)[segment];
      else { current = undefined; break; }
    }
    if (current !== undefined && current !== null && current !== '') return current;
  }
  return null;
}

function firstString(value: unknown, paths: string[][]): string | null {
  const found = firstValue(value, paths);
  return typeof found === 'string' ? found : null;
}

export function normalizeCarrierStatus(value: string | null): ParsedOrderStatus | null {
  if (!value) return null;
  const normalized = value.toLowerCase();
  if (/exception|failure|failed|held|delay|attempted|address\s+correction/.test(normalized)) return 'processing';
  if (/deliver|picked\s*up\s*by\s*recipient|proof\s+of\s+delivery/.test(normalized)) return 'delivered';
  if (/cancel|void|return(?:ed)?\s+to\s+sender|undeliverable/.test(normalized)) return 'cancelled';
  if (/transit|shipped|out\s+for\s+delivery|tendered|accepted|pickup|label\s+created|manifest/.test(normalized)) return 'shipped';
  if (/pending|pre[- ]?shipment|created|unknown|not\s+yet/.test(normalized)) return 'pending';
  return null;
}

function inferCarrier(trackingNumber: string): string | null {
  if (/^1Z[A-Z0-9]{16}$/i.test(trackingNumber)) return 'UPS';
  if (/^(?:9[2345]\d{18,20}|[A-Z]{2}\d{9}US)$/i.test(trackingNumber)) return 'USPS';
  if (/^\d{12,22}$/.test(trackingNumber)) return 'FedEx';
  return null;
}

function parseDate(value: unknown): Date | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const raw = String(value).trim();
  if (!raw) return null;
  const parsed = /^\d{8}$/.test(raw)
    ? new Date(`${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}T00:00:00Z`)
    : new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
