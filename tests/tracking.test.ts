import { afterEach, describe, expect, it, vi } from 'vitest';
import { CompositeCarrierTrackingProvider, FedexTrackingProvider, normalizeCarrierStatus, UpsTrackingProvider, UspsTrackingProvider } from '../server/tracking/providers.js';

afterEach(() => vi.unstubAllGlobals());

describe('carrier tracking adapters', () => {
  it('normalizes carrier status vocabulary without inventing a delivery', () => {
    expect(normalizeCarrierStatus('In Transit')).toBe('shipped');
    expect(normalizeCarrierStatus('Delivery exception')).toBe('processing');
    expect(normalizeCarrierStatus('Delivered')).toBe('delivered');
    expect(normalizeCarrierStatus('Out for delivery')).toBe('shipped');
    expect(normalizeCarrierStatus('On the Way')).toBe('shipped');
    expect(normalizeCarrierStatus('Undeliverable - return to sender')).toBe('cancelled');
    expect(normalizeCarrierStatus('Label created')).toBe('pending');
    expect(normalizeCarrierStatus('Not delivered')).toBe('processing');
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
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({headers:expect.objectContaining({'content-type':'application/json'}),body:JSON.stringify({grant_type:'client_credentials',client_id:'client',client_secret:'secret'})});
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain('/tracking/v3/tracking/94001112025558883342');
  });

  it('authenticates UPS with Basic credentials and preserves an in-transit delivery estimate', async () => {
    const fetchMock=vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({access_token:'ups-test-token',expires_in:3600})))
      .mockResolvedValueOnce(new Response(JSON.stringify({trackResponse:{shipment:[{package:[{currentStatus:{description:'Out for Delivery'},deliveryDate:[{date:'20260830'}]}]}]}})));
    vi.stubGlobal('fetch',fetchMock);
    const result=await new UpsTrackingProvider('client','secret','solo-app','https://ups.test').track('1Z9999999999999999');
    expect(result).toMatchObject({status:'shipped',deliveredAt:null,expectedDelivery:new Date('2026-08-30T00:00:00Z')});
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({headers:expect.objectContaining({authorization:`Basic ${Buffer.from('client:secret').toString('base64')}`})});
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({headers:expect.objectContaining({transactionSrc:'solo-app',authorization:'Bearer ups-test-token'})});
  });

  it('reads FedEx dates by type instead of treating the first ship date as delivery', async () => {
    const fetchMock=vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({access_token:'fedex-test-token',expires_in:3600})))
      .mockResolvedValueOnce(new Response(JSON.stringify({output:{completeTrackResults:[{trackResults:[{latestStatusDetail:{code:'DL'},dateAndTimes:[{type:'ACTUAL_PICKUP',dateTime:'2026-08-25T12:00:00Z'},{type:'ACTUAL_DELIVERY',dateTime:'2026-08-29T15:00:00Z'}]}]}]}})));
    vi.stubGlobal('fetch',fetchMock);
    const result=await new FedexTrackingProvider('key','secret',null,'https://fedex.test').track('123456789012');
    expect(result).toMatchObject({status:'delivered',deliveredAt:new Date('2026-08-29T15:00:00Z'),expectedDelivery:null});
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe('https://fedex.test/track/v1/trackingnumbers');
  });

  it('does not invent tracking status when carrier permission is denied', async () => {
    vi.stubGlobal('fetch',vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({access_token:'usps-test-token',expires_in:3600}))).mockResolvedValueOnce(new Response('{}',{status:403})));
    await expect(new UspsTrackingProvider('key','secret','https://usps.test').track('94001112025558883342')).rejects.toThrow('HTTP 403');
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
