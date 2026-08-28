import { afterEach, describe, expect, it, vi } from 'vitest';
import { CompositeCarrierTrackingProvider, FedexTrackingProvider, normalizeCarrierStatus, UspsTrackingProvider } from '../server/tracking/providers.js';

afterEach(() => vi.unstubAllGlobals());

describe('carrier tracking adapters', () => {
  it('normalizes carrier status vocabulary without inventing a delivery', () => {
    expect(normalizeCarrierStatus('In Transit')).toBe('shipped');
    expect(normalizeCarrierStatus('Delivery exception')).toBe('processing');
    expect(normalizeCarrierStatus('Delivered')).toBe('delivered');
    expect(normalizeCarrierStatus('some carrier prose')).toBeNull();
  });

  it('uses a cached USPS OAuth token and maps tracking status', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'usps-token', expires_in: 900 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        statusCategory: 'Transit',
        statusSummary: 'In Transit',
        expectedDeliveryDate: '2026-08-30',
      }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const provider = new UspsTrackingProvider('client', 'secret', 'https://usps.test');

    const result = await provider.track('94001112025558883342');
    expect(result).toMatchObject({ carrier: 'USPS', trackingNumber: '94001112025558883342', status: 'shipped' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain('/tracking/v3/tracking/94001112025558883342');
  });

  it('keeps carrier calls disabled when no credentials are configured', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const provider = new CompositeCarrierTrackingProvider([
      new UspsTrackingProvider(null, null),
      new FedexTrackingProvider(null, null),
    ]);
    expect(provider.configured).toBe(false);
    expect(await provider.track('USPS', '94001112025558883342')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
