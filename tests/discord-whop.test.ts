import { createHmac } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import express from 'express';
import cookieParser from 'cookie-parser';
import type { Server } from 'node:http';
import { Repository } from '../server/database/repository.js';
import { SoloRepository } from '../server/solo/repository.js';
import { IdentityRepository } from '../server/auth/repository.js';
import { createDiscordAuth } from '../server/auth/discord.js';
import { exchangeDiscordCode } from '../server/solo/discord.js';
import { loadConfig } from '../server/config.js';
import { WHOP_API_VERSION, WhopService, verifyWhopEvent } from '../server/billing/whop.js';

vi.mock('../server/solo/discord.js',()=>({exchangeDiscordCode:vi.fn()}));
const realFetch=globalThis.fetch;
const config=loadConfig({DATABASE_URL:'postgres://unused/test',MAILBOX_ENCRYPTION_KEY:Buffer.alloc(32,7).toString('base64'),SESSION_SECRET:'identity-test-secret-long-enough',PORTAL_SECRET:'portal-test-secret-long-enough',SERVICE_SERIAL:'service-test-serial',
  APP_ORIGIN:'https://ordertracker.pro',DISCORD_REDIRECT_URI:'https://ordertracker.pro/oauth/discord',DISCORD_CLIENT_ID:'discord-client',DISCORD_CLIENT_SECRET:'discord-secret',
  WHOP_API_KEY:'test-key',WHOP_WEBHOOK_SECRET:'ws_test_signing_secret',WHOP_ACCOUNT_ID:'biz_ours',WHOP_SOLO_PRODUCT_ID:'prod_solo',WHOP_ACO_PRODUCT_ID:'prod_aco',WHOP_SOLO_PLAN_ID:'plan_solo',WHOP_ACO_PLAN_ID:'plan_aco'});
function signedEvent(id:string,membership='mem_solo',type='membership.activated') {
  const data=type.startsWith('membership.')?{id:membership}:{id:`pay_${id}`,member:{id:membership}};
  const raw=Buffer.from(JSON.stringify({id,type,account_id:'biz_ours',api_version:'v1',api_version_date:WHOP_API_VERSION,data}));
  const timestamp=String(Math.floor(Date.now()/1000));
  const signature=createHmac('sha256',config.whopWebhookSecret!).update(`${id}.${timestamp}.`).update(raw).digest('base64');
  return {raw,headers:{'webhook-id':id,'webhook-timestamp':timestamp,'webhook-signature':`v1,${signature}`}};
}

describe('Discord binding and Whop provisioning (embedded PostgreSQL + HTTP)',()=>{
  let db:PGlite,core:Repository,identities:IdentityRepository,solo:SoloRepository,whop:WhopService,server:Server,base:string;
  let testIp=1;
  const buyer={id:'111111111111111111',username:'solo.buyer'},operator={id:'222222222222222222',username:'aco.owner'};
  const whopBuyer={id:'333333333333333333',username:'paid.buyer'},whopOperator={id:'444444444444444444',username:'paid.operator'};
  const membership=(id:string,product:string,user:string,status='active')=>({id,account:{id:'biz_ours'},product_id:product,user_id:user,status,license_key:`KEY-${id}-123456789`,current_period_end:new Date(Date.now()+30*86400000).toISOString()});
  let remoteMemberships:Record<string,ReturnType<typeof membership>>={};
  let remoteDiscord:Record<string,typeof buyer>={};
  const mockWhop=()=>vi.stubGlobal('fetch',vi.fn(async(input:string|URL|Request,init?:RequestInit)=>{
    const url=new URL(String(input));
    expect((init?.headers as Record<string,string>)['Api-Version-Date']).toBe(WHOP_API_VERSION);
    const id=url.pathname.split('/').at(-1)!;
    if(url.pathname.endsWith('/checkout_configurations')){
      const requestBody=JSON.parse(String(init?.body)) as {plan_id:string};
      return new Response(JSON.stringify({id:'ch_checkout_session',plan:{id:requestBody.plan_id}}));
    }
    if(url.pathname.includes('/plans/'))return new Response(JSON.stringify({id,company:{id:'biz_ours'},product:{id:id==='plan_solo'?'prod_solo':'prod_aco'}}));
    const data=url.pathname.includes('/memberships/')?(remoteMemberships[id]??Object.values(remoteMemberships).find(m=>m.license_key===decodeURIComponent(id))):{id,username:'paid-user',social_accounts:remoteDiscord[id]?[{platform:'discord',external_id:remoteDiscord[id].id,username:remoteDiscord[id].username}]:[]};
    return new Response(JSON.stringify(data??{}),{status:data?200:404});
  }));
  beforeAll(async()=>{
    db=new PGlite();
    const directory=new URL('../server/database/migrations/',import.meta.url);
    for(const file of (await readdir(directory)).filter(name=>name.endsWith('.sql')).sort())await db.exec(await readFile(new URL(file,directory),'utf8'));
    core=new Repository(config.databaseUrl);
    const query=async(text:string,values?:unknown[])=>{const result=await db.query(text,values);return {rows:result.rows,rowCount:result.affectedRows||result.rows.length};};
    Object.assign(core,{pool:{query,connect:async()=>({query,release:()=>{}}),end:async()=>{}}});
    identities=new IdentityRepository(core);solo=new SoloRepository(core);whop=new WhopService(config,core);
    const auth=createDiscordAuth(config,core),app=express();app.set('trust proxy',1);app.use(express.json(),cookieParser());
    app.get('/oauth/discord',auth.callback);app.use('/api/auth',auth.router);
    app.get('/protected/aco',auth.requireProduct('aco'),(request,response)=>response.json({workspaceId:request.discordWorkspaceId}));
    app.get('/protected/solo',auth.requireProduct('solo'),(request,response)=>response.json({workspaceId:request.discordWorkspaceId}));
    server=await new Promise<Server>(resolve=>{const current=app.listen(0,'127.0.0.1',()=>resolve(current));});
    const address=server.address();if(!address||typeof address==='string')throw new Error('Missing server');base=`http://127.0.0.1:${address.port}`;
  },30000);
  afterEach(()=>{vi.unstubAllGlobals();vi.clearAllMocks();testIp++;});
  afterAll(async()=>{if(server)await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));await db?.close();});
  const request=(path:string,cookie='',body?:unknown)=>realFetch(base+path,{method:body===undefined?'GET':'POST',headers:{cookie,'Content-Type':'application/json','X-Forwarded-For':`192.0.2.${testIp}`},body:body===undefined?undefined:JSON.stringify(body),redirect:'manual'});
  const cookieFrom=(response:Response)=>response.headers.getSetCookie().filter(value=>!value.includes('Expires=Thu, 01 Jan 1970')).map(value=>value.split(';')[0]).join('; ');
  async function login(identity:typeof buyer,pendingCookie='') {
    vi.mocked(exchangeDiscordCode).mockResolvedValue(identity);
    const begin=await request('/api/auth/discord',pendingCookie),url=new URL(begin.headers.get('location')!);
    expect(url.searchParams.get('scope')).toBe('identify');expect(url.searchParams.get('redirect_uri')).toBe(config.discordRedirectUri);
    const callback=await request(`/oauth/discord?code=test-code&state=${url.searchParams.get('state')}`,cookieFrom(begin));
    expect(exchangeDiscordCode).toHaveBeenCalledWith('test-code','discord-client','discord-secret',config.discordRedirectUri);
    return callback;
  }
  it('validates the supplied callback URI and rejects foreign callback origins',()=>{
    expect(config.discordRedirectUri).toBe('https://ordertracker.pro/oauth/discord');
    expect(()=>loadConfig({DATABASE_URL:'x',MAILBOX_ENCRYPTION_KEY:'x',SESSION_SECRET:'x'.repeat(32),PORTAL_SECRET:'x'.repeat(32),SERVICE_SERIAL:'x'.repeat(20),APP_ORIGIN:'https://ordertracker.pro',DISCORD_REDIRECT_URI:'https://attacker.example/callback'})).toThrow('DISCORD_REDIRECT_URI');
  });
  it('requires verified Discord state before linking, with no free service for new identities',async()=>{
    expect((await request('/api/auth/link','',{product:'solo',serial:'solo_unverified_token'})).status).toBe(401);
    const invalid=await request('/oauth/discord?code=test-code&state=invalid');
    expect(invalid.headers.get('location')).toBe('/login?error=discord-failed');expect(exchangeDiscordCode).not.toHaveBeenCalled();
    const signedIn=await login(buyer);expect(signedIn.headers.get('location')).toBe('/login');
    expect(await (await request('/api/auth/session',cookieFrom(signedIn))).json()).toMatchObject({status:'unlinked',canContinue:false,username:buyer.username});
    expect((await request('/protected/solo',cookieFrom(signedIn))).status).toBe(401);
  });
  it('binds a Solo serial once, remembers the destination, and prevents another Discord account claiming it',async()=>{
    const provisioned=await solo.provision({handle:'manual-buyer',displayName:'Buyer',discordId:null,days:30,mailboxLimit:2});
    const pending=cookieFrom(await login(buyer));
    const linked=await request('/api/auth/link',pending,{product:'solo',serial:provisioned.serial});
    expect(linked.status).toBe(200);expect(await linked.json()).toEqual({path:'/customer/manual-buyer'});
    const cookie=cookieFrom(linked);
    expect((await request('/protected/solo',cookie)).status).toBe(200);
    expect((await request('/protected/aco',cookie)).status).toBe(401);
    expect((await login(buyer)).headers.get('location')).toBe('/customer/manual-buyer');
    await expect(identities.linkSolo(operator,provisioned.serial)).rejects.toThrow('already linked');
    await solo.rotateSerial('manual-buyer');
    expect((await request('/protected/solo',cookie)).status).toBe(401);
    expect(await (await request('/api/auth/session',cookie)).json()).toMatchObject({status:'anonymous'});
    expect((await request('/api/auth/continue',cookie,{})).status).toBe(401);
    expect((await login(buyer)).headers.get('location')).toBe('/customer/manual-buyer');
  });
  it('rejects the old ACO workspace/password linking payload',async()=>{
    const cookie=cookieFrom(await login(operator));
    expect((await request('/api/auth/link',cookie,{product:'aco',workspaceSlug:'manual-aco',password:'password'})).status).toBe(400);
    expect((await request('/protected/aco',cookie)).status).toBe(401);
  });
  it('rejects unsigned, tampered and old webhooks; queues signed deliveries only once',async()=>{
    const event=signedEvent('event-1');
    expect(verifyWhopEvent(event.raw,event.headers,config.whopWebhookSecret!).id).toBe('event-1');
    expect(()=>verifyWhopEvent(event.raw,{...event.headers,'webhook-signature':'v1,forged'},config.whopWebhookSecret!)).toThrow();
    expect(()=>verifyWhopEvent(Buffer.from('{}'),event.headers,config.whopWebhookSecret!)).toThrow();
    expect(()=>verifyWhopEvent(event.raw,event.headers,config.whopWebhookSecret!,Date.now()+600000)).toThrow();
    await whop.receive(event.raw,event.headers);await whop.receive(event.raw,event.headers);
    expect((await db.query('SELECT * FROM whop_jobs')).rows).toHaveLength(1);
  });
  it('creates an embedded checkout session from the server-configured matching Whop plan',async()=>{
    mockWhop();
    await expect(whop.createCheckout('solo')).resolves.toEqual({sessionId:'ch_checkout_session',planId:'plan_solo',returnUrl:'https://ordertracker.pro/checkout/complete?product=solo'});
    const calls=vi.mocked(fetch).mock.calls;
    expect(String(calls[0][0])).toContain('/plans/plan_solo');
    expect(String(calls[1][0])).toContain('/checkout_configurations');
    expect(String(calls[1][1]?.body)).toContain('plan_solo');
    await expect(whop.createCheckout('aco')).resolves.toMatchObject({planId:'plan_aco'});
  });
  it('imports the paid Solo key without requiring Whop Discord, then binds explicitly',async()=>{
    remoteMemberships={mem_solo:membership('mem_solo','prod_solo','user_solo')};remoteDiscord={user_solo:whopBuyer};mockWhop();
    expect(await whop.processOne()).toBe(true);
    expect(await identities.resolve(whopBuyer.id)).toBeNull();
    await identities.linkLicense(whopBuyer,await whop.verifyLicense(remoteMemberships.mem_solo.license_key,'solo'));
    const service=await identities.resolve(whopBuyer.id);expect(service?.product).toBe('solo');expect(service?.solo?.mailboxLimit).toBe(2);
    const duplicate=signedEvent('event-2');await whop.receive(duplicate.raw,duplicate.headers);await whop.processOne();
    expect((await db.query('SELECT * FROM solo_accounts WHERE discord_id=$1',[whopBuyer.id])).rows).toHaveLength(1);
    vi.unstubAllGlobals();
    expect((await login(whopBuyer)).headers.get('location')).toBe(service!.path);
  });
  it('preserves workspaces while suspending on cancellation or failed payment, then restores on paid renewal',async()=>{
    const service=(await identities.resolve(whopBuyer.id))!,cookie=cookieFrom(await login(whopBuyer));
    remoteMemberships.mem_solo.status='canceled';mockWhop();
    const lateActivation=signedEvent('late-activation');await whop.receive(lateActivation.raw,lateActivation.headers);await whop.processOne();
    expect(await identities.resolve(whopBuyer.id)).toBeNull();
    expect(await core.listActiveWorkspaceIds()).not.toContain(service.workspaceId);
    expect((await request('/protected/solo',cookie)).status).toBe(401);
    remoteMemberships.mem_solo.status='active';
    const renewed=signedEvent('renewed');await whop.receive(renewed.raw,renewed.headers);await whop.processOne();
    expect((await identities.resolve(whopBuyer.id))?.workspaceId).toBe(service.workspaceId);
    const failed=signedEvent('failed-payment','mem_solo','payment.failed');await whop.receive(failed.raw,failed.headers);
    expect((await db.query<{valid:boolean;access_suspended:boolean}>("SELECT valid,access_suspended FROM whop_memberships WHERE id='mem_solo'")).rows[0]).toEqual({valid:false,access_suspended:true});
    expect(await identities.resolve(whopBuyer.id)).toBeNull();expect((await db.query('SELECT id FROM workspaces WHERE id=$1',[service.workspaceId])).rows).toHaveLength(1);
    await whop.processOne();expect(await identities.resolve(whopBuyer.id)).toBeNull();
    const paid=signedEvent('successful-payment','mem_solo','payment.succeeded');await whop.receive(paid.raw,paid.headers);await whop.processOne();
    expect((await identities.resolve(whopBuyer.id))?.workspaceId).toBe(service.workspaceId);
    const deactivated=signedEvent('deactivated','mem_solo','membership.deactivated');await whop.receive(deactivated.raw,deactivated.headers);
    expect(await identities.resolve(whopBuyer.id)).toBeNull();
    await whop.processOne();expect(await identities.resolve(whopBuyer.id)).toBeNull();
    const activated=signedEvent('reactivated','mem_solo','membership.activated');await whop.receive(activated.raw,activated.headers);await whop.processOne();
    expect((await identities.resolve(whopBuyer.id))?.workspaceId).toBe(service.workspaceId);
  });
  it('creates separate ACO access and supports buyers without a Discord connection in Whop',async()=>{
    remoteMemberships.mem_aco=membership('mem_aco','prod_aco','user_aco');remoteDiscord.user_aco=whopOperator;
    remoteMemberships.mem_other=membership('mem_other','prod_unknown','user_other');
    remoteMemberships.mem_missing=membership('mem_missing','prod_solo','user_missing');mockWhop();
    for(const id of ['mem_aco','mem_other','mem_missing']){const event=signedEvent(id,id);await whop.receive(event.raw,event.headers);await whop.processOne();}
    expect(await identities.resolve(whopOperator.id)).toBeNull();
    await identities.linkLicense(whopOperator,await whop.verifyLicense(remoteMemberships.mem_aco.license_key,'aco'));
    const service=await identities.resolve(whopOperator.id);expect(service?.product).toBe('aco');
    expect((await db.query("SELECT * FROM whop_memberships WHERE id='mem_other'")).rows).toHaveLength(0);
    expect((await db.query("SELECT valid,workspace_id,last_error FROM whop_memberships WHERE id='mem_missing'")).rows[0]).toMatchObject({valid:true,workspace_id:expect.any(String),last_error:null});
  });
  it('uses serial-first ACO OAuth, stores only a hash, and rejects cross-product/public-ID credentials',async()=>{
    remoteMemberships.mem_serial=membership('mem_serial','prod_aco','user_serial');mockWhop();
    const key=remoteMemberships.mem_serial.license_key;
    await expect(whop.verifyLicense(key,'solo')).rejects.toThrow('does not belong');
    await expect(whop.verifyLicense('mem_serial','aco')).rejects.toThrow('does not belong');
    const license=await request('/api/auth/license','',{product:'aco',serial:key});
    expect(license.status).toBe(200);
    const pending=cookieFrom(license);
    expect(pending).not.toContain(key);
    expect(await (await request('/api/auth/session',pending)).json()).toMatchObject({status:'license-verified',product:'aco'});
    expect((await request('/protected/aco',pending)).status).toBe(401);
    const identity={id:'555555555555555555',username:'serial.owner'};
    const signedIn=await login(identity,pending);
    expect(signedIn.headers.get('location')).toMatch(/^\/app\/workspaces\/aco-/);
    expect((await request('/protected/aco',cookieFrom(signedIn))).status).toBe(200);
    const stored=(await db.query<{license_hash:string;product_id:string;user_id:string}>("SELECT license_hash,product_id,user_id FROM whop_memberships WHERE id='mem_serial'")).rows[0];
    expect(stored).toMatchObject({product_id:'prod_aco',user_id:'user_serial'});
    expect(stored.license_hash).toMatch(/^[a-f0-9]{64}$/);
    const verified=await whop.verifyLicense(key,'aco');
    await expect(identities.linkLicense(operator,verified)).rejects.toThrow('already linked');
    const changed=await core.updateWorkspaceSettings(verified.workspaceId,{displayName:'My renamed ACO',workspaceSlug:'custom-aco-path'});
    expect(changed.displayName).toBe('My renamed ACO');
    expect((await login(identity)).headers.get('location')).toBe('/app/workspaces/custom-aco-path');
    remoteMemberships.mem_serial.status='canceled';
    await expect(whop.verifyLicense(key,'aco')).rejects.toThrow('expired');
    expect((await request('/protected/aco',cookieFrom(signedIn))).status).toBe(401);
    await expect(identities.linkLicense(identity,verified)).rejects.toThrow('expired');
  });
  it('rejects foreign companies and key rotation invalidates pending claims',async()=>{
    remoteMemberships.mem_rotation=membership('mem_rotation','prod_aco','user_rotation');mockWhop();
    const key=remoteMemberships.mem_rotation.license_key;
    remoteMemberships.mem_rotation.account.id='biz_other';
    await expect(whop.verifyLicense(key,'aco')).rejects.toThrow('does not belong');
    remoteMemberships.mem_rotation.account.id='biz_ours';
    const old=await whop.verifyLicense(key,'aco');
    remoteMemberships.mem_rotation.license_key='ROTATED-KEY-123456';
    const next=await whop.verifyLicense(remoteMemberships.mem_rotation.license_key,'aco');
    expect(next.workspaceId).toBe(old.workspaceId);
    await expect(identities.linkLicense(operator,old)).rejects.toThrow('changed');
    await expect(whop.verifyLicense(key,'aco')).rejects.toThrow();
    remoteMemberships.mem_rotation.user_id='user_new_owner';
    expect((await whop.verifyLicense(remoteMemberships.mem_rotation.license_key,'aco')).workspaceId).not.toBe(old.workspaceId);
    expect(await core.getCredentials(old.workspaceId)).toBeNull();
  });
  it('accepts the documented nested membership API shape and detects slug conflicts atomically',async()=>{
    const data={id:'mem_documented',company:{id:'biz_ours'},product:{id:'prod_aco'},user:{id:'user_docs',username:'docs-buyer'},
      license_key:'DOCS-LICENSE-KEY-123',status:'active',renewal_period_end:null};
    vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify(data))));
    const license=await whop.verifyLicense(data.license_key,'aco');
    await expect(core.updateWorkspaceSettings(license.workspaceId,{displayName:'Should roll back',workspaceSlug:'custom-aco-path'})).rejects.toThrow();
    expect((await core.getWorkspaceSettings(license.workspaceId)).displayName).toBe('My ACO workspace');
    expect((await db.query<{whop_username:string}>("SELECT whop_username FROM whop_memberships WHERE id='mem_documented'")).rows[0].whop_username).toBe('docs-buyer');
  });
  it('fails closed when the verification lease expires without a successful renewal',async()=>{
    await db.query("UPDATE whop_memberships SET access_until=now()-interval '1 second' WHERE id='mem_aco'");
    expect(await identities.resolve(whopOperator.id)).toBeNull();
  });
});
