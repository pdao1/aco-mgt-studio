import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
import cookieParser from 'cookie-parser';
import type { Server } from 'node:http';
import type { Repository } from '../server/database/repository.js';
import { SoloRepository, type SoloAccount } from '../server/solo/repository.js';
import { createSoloRouter } from '../server/solo/routes.js';
import { loadConfig } from '../server/config.js';
import { SecretBox } from '../server/security/secret-box.js';
import { CompositeCarrierTrackingProvider } from '../server/tracking/providers.js';
import { signValue } from '../server/solo/session.js';
import { exchangeDiscordCode } from '../server/solo/discord.js';

vi.mock('../server/solo/discord.js',()=>({exchangeDiscordCode:vi.fn()}));

describe('remembered Solo sessions (HTTP with mocked account storage)',()=>{
  let server:Server, base:string;
  const secret='solo-session-test-secret-long-enough';
  const account:SoloAccount={id:'11111111-1111-4111-8111-111111111111',workspaceId:'22222222-2222-4222-8222-222222222222',
    handle:'returning-buyer',discordId:null,displayName:'Buyer',accessExpiresAt:new Date(Date.now()+90*86400000).toISOString(),mailboxLimit:5,sessionVersion:3};
  const cookie=(version=3,expiresAt=Date.now()+86400000)=>`solo_session=${signValue({accountId:account.id,version,expiresAt},'solo-session',secret)}`;
  const request=(path:string,auth='')=>fetch(base+path,{headers:auth?{cookie:auth}:{},redirect:'manual'});
  beforeAll(async()=>{
    const config=loadConfig({DATABASE_URL:'postgres://unused/test',MAILBOX_ENCRYPTION_KEY:Buffer.alloc(32,7).toString('base64'),
      SESSION_SECRET:secret,PORTAL_SECRET:'solo-portal-test-secret-long-enough',SERVICE_SERIAL:'aco-service-serial',
      NODE_ENV:'production',APP_ORIGIN:'https://example.test',DISCORD_CLIENT_ID:'test-client',DISCORD_CLIENT_SECRET:'test-secret'});
    const app=express();app.use(express.json(),cookieParser());
    app.use('/api/solo',createSoloRouter({config,repository:{} as Repository,secretBox:new SecretBox(config.mailboxEncryptionKey),
      trackingProvider:new CompositeCarrierTrackingProvider([]),coordinators:()=>{throw new Error('Session checks must not load dashboard jobs.');}}));
    server=await new Promise<Server>(resolve=>{const running=app.listen(0,'127.0.0.1',()=>resolve(running));});
    const address=server.address();
    if(!address||typeof address==='string')throw new Error('Test server did not bind');
    base=`http://127.0.0.1:${address.port}`;
  });
  afterEach(()=>vi.restoreAllMocks());
  afterAll(async()=>{if(server)await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));});

  it('leaves anonymous visitors on the public site without looking up an account',async()=>{
    const lookup=vi.spyOn(SoloRepository.prototype,'byId');
    const response=await request('/api/solo/auth/session');
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(await response.json()).toEqual({authenticated:false});
    expect(lookup).not.toHaveBeenCalled();
  });
  it('returns the current account dashboard, even when the handle has changed',async()=>{
    vi.spyOn(SoloRepository.prototype,'byId').mockResolvedValue({...account,handle:'linked.discord'});
    const response=await request('/api/solo/auth/session',cookie());
    expect(await response.json()).toEqual({authenticated:true,path:'/customer/linked.discord'});
    // Checking or polling does not roll the fixed expiry forward.
    expect(response.headers.getSetCookie()).toHaveLength(0);
  });
  it.each(['tampered','expired','rotated','inactive'] as const)('rejects a %s session and clears its cookie',async(kind)=>{
    const lookup=vi.spyOn(SoloRepository.prototype,'byId').mockResolvedValue(kind==='inactive'?null:account);
    const auth=kind==='tampered'?cookie()+'x':kind==='expired'?cookie(3,1):kind==='rotated'?cookie(2):cookie();
    const response=await request('/api/solo/auth/session',auth);
    expect(await response.json()).toEqual({authenticated:false});
    expect(response.headers.getSetCookie()[0]).toContain('Expires=Thu, 01 Jan 1970');
    if(kind==='tampered'||kind==='expired')expect(lookup).not.toHaveBeenCalled();
  });
  it('issues a persistent protected cookie after serial entry and clears it on logout',async()=>{
    vi.spyOn(SoloRepository.prototype,'bySerial').mockResolvedValue(account);
    const response=await fetch(base+'/api/solo/auth/serial',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({serial:'solo-test-private-serial-value'})});
    expect(await response.json()).toEqual({path:'/customer/returning-buyer'});
    const header=response.headers.getSetCookie()[0];
    expect(header).toContain('Max-Age=2592000');
    for(const flag of ['HttpOnly','Secure','SameSite=Strict'])expect(header).toContain(flag);
    expect(header).not.toContain('solo-test-private-serial-value');
    const logout=await fetch(base+'/api/solo/auth/logout',{method:'POST',headers:{cookie:header.split(';')[0]}});
    expect(logout.status).toBe(200);
    expect(logout.headers.getSetCookie()[0]).toContain('Expires=Thu, 01 Jan 1970');
  });
  it('issues the same remembered cookie after a verified Discord login',async()=>{
    vi.mocked(exchangeDiscordCode).mockResolvedValue({id:'123456789012345678',username:account.handle});
    vi.spyOn(SoloRepository.prototype,'byDiscord').mockResolvedValue(account);
    vi.spyOn(SoloRepository.prototype,'linkDiscord').mockResolvedValue(account);
    const start=await request('/api/solo/auth/discord');
    const location=new URL(start.headers.get('location')!);
    const stateCookie=start.headers.getSetCookie()[0].split(';')[0];
    const callback=await request(`/api/solo/auth/discord/callback?state=${location.searchParams.get('state')}&code=test-code`,stateCookie);
    expect(callback.headers.get('location')).toBe('/customer/returning-buyer');
    const session=callback.headers.getSetCookie().find(value=>value.startsWith('solo_session='));
    expect(session).toContain('Max-Age=2592000');
    expect(session).toContain('HttpOnly');
    expect(session).toContain('Secure');
  });
});
