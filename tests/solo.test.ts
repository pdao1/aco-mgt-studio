import { afterEach, describe, expect, it, vi } from 'vitest';
import { signValue, readValue } from '../server/solo/session.js';
import { serialHash } from '../server/solo/repository.js';
import { exchangeDiscordCode } from '../server/solo/discord.js';
import { summarizePurchases } from '../src/solo/order-summary.js';
import type { SoloOrder } from '../src/solo/types.js';

afterEach(()=>vi.unstubAllGlobals());
describe('Solo Buyer identity and purchase totals',()=>{
  it('rejects tampered, expired, and differently purposed sessions',()=>{
    const secret='test-session-secret', payload={expiresAt:Date.now()+10000,accountId:'test-account'};
    const signed=signValue(payload,'solo-session',secret);
    expect(readValue(signed,'solo-session',secret)).toEqual(payload);
    expect(readValue(signed+'x','solo-session',secret)).toBeNull();
    expect(readValue(signed+'.','solo-session',secret)).toBeNull();
    expect(readValue(signed.split('.')[0]+'.'+'\u00e9'.repeat(43),'solo-session',secret)).toBeNull();
    expect(readValue(signed,'discord-state',secret)).toBeNull();
    expect(readValue(signValue({...payload,expiresAt:1},'solo-session',secret),'solo-session',secret)).toBeNull();
    expect(serialHash('solo-private-token')).not.toContain('solo-private-token');
  });
  it('keeps currencies separate and excludes cancellations and unknown totals from spending',()=>{
    const orders=[{currency:'USD',totalCents:1000,status:'delivered'},{currency:'CAD',totalCents:2500,status:'shipped'},{currency:'USD',totalCents:9000,status:'cancelled'},{currency:'USD',totalCents:null,status:'pending'}] as SoloOrder[];
    expect(summarizePurchases(orders)).toEqual({count:4,inTransit:1,delivered:1,totals:[['USD',1000],['CAD',2500]],unknownTotal:1});
  });
  it('uses the verified Discord user ID and never returns OAuth tokens',async()=>{
    const fetchMock=vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({access_token:'test-token',refresh_token:'test-refresh'})))
      .mockResolvedValueOnce(new Response(JSON.stringify({id:'123456789012345678',username:'buyer.name'})));
    vi.stubGlobal('fetch',fetchMock);
    expect(await exchangeDiscordCode('test-code','client','secret','http://localhost/callback')).toEqual({id:'123456789012345678',username:'buyer.name'});
    expect(String(fetchMock.mock.calls[0]?.[1]?.body)).toContain('grant_type=authorization_code');
    expect(fetchMock.mock.calls[1]?.[0]).toBe('https://discord.com/api/v10/users/@me');
  });
});
