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
import { hashPassword } from '../server/security/password.js';
import { WHOP_API_VERSION, WhopService, verifyWhopEvent } from '../server/billing/whop.js';

vi.mock('../server/solo/discord.js',()=>({exchangeDiscordCode:vi.fn()}));
const realFetch=globalThis.fetch;
const config=loadConfig({DATABASE_URL:'postgres://unused/test',MAILBOX_ENCRYPTION_KEY:Buffer.alloc(32,7).toString('base64'),SESSION_SECRET:'identity-test-secret-long-enough',PORTAL_SECRET:'portal-test-secret-long-enough',SERVICE_SERIAL:'service-test-serial',
  APP_ORIGIN:'https://aco-studio.onrender.com',DISCORD_REDIRECT_URI:'https://aco-studio.onrender.com/oauth/discord',DISCORD_CLIENT_ID:'discord-client',DISCORD_CLIENT_SECRET:'discord-secret',
  WHOP_API_KEY:'test-key',WHOP_WEBHOOK_SECRET:'ws_test_signing_secret',WHOP_ACCOUNT_ID:'biz_ours',WHOP_SOLO_PRODUCT_ID:'prod_solo',WHOP_ACO_PRODUCT_ID:'prod_aco'});
function signedEvent(id:string,membership='mem_solo',type='membership.activated') {
  const raw=Buffer.from(JSON.stringify({id,type,account_id:'biz_ours',api_version:'v1',api_version_date:WHOP_API_VERSION,data:{id:membership}}));
  const timestamp=String(Math.floor(Date.now()/1000));
  const signature=createHmac('sha256',config.whopWebhookSecret!).update(`${id}.${timestamp}.`).update(raw).digest('base64');
  return {raw,headers:{'webhook-id':id,'webhook-timestamp':timestamp,'webhook-signature':`v1,${signature}`}};
}

describe('Discord binding and Whop provisioning (embedded PostgreSQL + HTTP)',()=>{
  let db:PGlite,core:Repository,identities:IdentityRepository,solo:SoloRepository,whop:WhopService,server:Server,base:string;
  let testIp=1;
  const buyer={id:'111111111111111111',username:'solo.buyer'},operator={id:'222222222222222222',username:'aco.owner'};
  const whopBuyer={id:'333333333333333333',username:'paid.buyer'},whopOperator={id:'444444444444444444',username:'paid.operator'};
  const membership=(id:string,product:string,user:string,status='active')=>({id,account:{id:'biz_ours'},product_id:product,user_id:user,status,current_period_end:new Date(Date.now()+30*86400000).toISOString()});
  let remoteMemberships:Record<string,ReturnType<typeof membership>>={};
  let remoteDiscord:Record<string,typeof buyer>={};
  const mockWhop=()=>vi.stubGlobal('fetch',vi.fn(async(input:string|URL|Request,init?:RequestInit)=>{
    const url=new URL(String(input));
    expect((init?.headers as Record<string,string>)['Api-Version-Date']).toBe(WHOP_API_VERSION);
    const id=url.pathname.split('/').at(-1)!;
    const data=url.pathname.includes('/memberships/')?remoteMemberships[id]:{id,username:'paid-user',social_accounts:remoteDiscord[id]?[{platform:'discord',external_id:remoteDiscord[id].id,username:remoteDiscord[id].username}]:[]};
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
  async function login(identity:typeof buyer) {
    vi.mocked(exchangeDiscordCode).mockResolvedValue(identity);
    const begin=await request('/api/auth/discord'),url=new URL(begin.headers.get('location')!);
    expect(url.searchParams.get('scope')).toBe('identify');expect(url.searchParams.get('redirect_uri')).toBe(config.discordRedirectUri);
    const callback=await request(`/oauth/discord?code=test-code&state=${url.searchParams.get('state')}`,cookieFrom(begin));
    expect(exchangeDiscordCode).toHaveBeenCalledWith('test-code','discord-client','discord-secret',config.discordRedirectUri);
    return callback;
  }
  it('validates the supplied callback URI and rejects foreign callback origins',()=>{
    expect(config.discordRedirectUri).toBe('https://aco-studio.onrender.com/oauth/discord');
    expect(()=>loadConfig({DATABASE_URL:'x',MAILBOX_ENCRYPTION_KEY:'x',SESSION_SECRET:'x'.repeat(32),PORTAL_SECRET:'x'.repeat(32),SERVICE_SERIAL:'x'.repeat(20),APP_ORIGIN:'https://aco-studio.onrender.com',DISCORD_REDIRECT_URI:'https://attacker.example/callback'})).toThrow('DISCORD_REDIRECT_URI');
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
    const provisioned=await solo.provision({handle:'manual-buyer',displayName:'Buyer',discordId:null,days:30,mailboxLimit:5});
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
  it('requires the workspace password, persists ACO ownership, and rejects a conflicting claim',async()=>{
    await core.createWorkspace('manual-aco','Manual ACO',await hashPassword('correct-workspace-password'));
    await expect(identities.linkWorkspace(operator,'manual-aco','wrong-password')).rejects.toThrow('incorrect');
    await identities.linkWorkspace(operator,'manual-aco','correct-workspace-password');
    await expect(identities.linkWorkspace(buyer,'manual-aco','correct-workspace-password')).rejects.toThrow('already linked');
    const signedIn=await login(operator),cookie=cookieFrom(signedIn);
    expect(signedIn.headers.get('location')).toBe('/app/workspaces/manual-aco');
    expect((await request('/protected/aco',cookie)).status).toBe(200);
    const session=await (await request('/api/auth/session',cookie)).json();expect(session).toMatchObject({status:'linked',path:'/app/workspaces/manual-aco'});
    const logout=await request('/api/auth/signout',cookie,{});
    expect(logout.headers.getSetCookie().some(value=>value.startsWith('discord_session=;'))).toBe(true);
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
  it('automatically creates paid Solo access from the verified membership and Discord connection',async()=>{
    remoteMemberships={mem_solo:membership('mem_solo','prod_solo','user_solo')};remoteDiscord={user_solo:whopBuyer};mockWhop();
    expect(await whop.processOne()).toBe(true);
    const service=await identities.resolve(whopBuyer.id);expect(service?.product).toBe('solo');expect(service?.solo?.mailboxLimit).toBe(5);
    const duplicate=signedEvent('event-2');await whop.receive(duplicate.raw,duplicate.headers);await whop.processOne();
    expect((await db.query('SELECT * FROM solo_accounts WHERE discord_id=$1',[whopBuyer.id])).rows).toHaveLength(1);
    vi.unstubAllGlobals();
    expect((await login(whopBuyer)).headers.get('location')).toBe(service!.path);
  });
  it('uses current Whop state for late events, revokes polling and sessions on cancellation, and restores renewal',async()=>{
    const service=(await identities.resolve(whopBuyer.id))!,cookie=cookieFrom(await login(whopBuyer));
    remoteMemberships.mem_solo.status='canceled';mockWhop();
    const lateActivation=signedEvent('late-activation');await whop.receive(lateActivation.raw,lateActivation.headers);await whop.processOne();
    expect(await identities.resolve(whopBuyer.id)).toBeNull();
    expect(await core.listActiveWorkspaceIds()).not.toContain(service.workspaceId);
    expect((await request('/protected/solo',cookie)).status).toBe(401);
    remoteMemberships.mem_solo.status='active';
    const renewed=signedEvent('renewed');await whop.receive(renewed.raw,renewed.headers);await whop.processOne();
    expect((await identities.resolve(whopBuyer.id))?.workspaceId).toBe(service.workspaceId);
  });
  it('creates ACO access and does not provision unknown products or buyers without a Discord connection',async()=>{
    remoteMemberships.mem_aco=membership('mem_aco','prod_aco','user_aco');remoteDiscord.user_aco=whopOperator;
    remoteMemberships.mem_other=membership('mem_other','prod_unknown','user_other');
    remoteMemberships.mem_missing=membership('mem_missing','prod_solo','user_missing');mockWhop();
    for(const id of ['mem_aco','mem_other','mem_missing']){const event=signedEvent(id,id);await whop.receive(event.raw,event.headers);await whop.processOne();}
    const service=await identities.resolve(whopOperator.id);expect(service?.product).toBe('aco');
    expect((await db.query("SELECT * FROM whop_memberships WHERE id='mem_other'")).rows).toHaveLength(0);
    expect((await db.query("SELECT valid,workspace_id,last_error FROM whop_memberships WHERE id='mem_missing'")).rows[0]).toMatchObject({valid:false,workspace_id:null,last_error:'Buyer must link Discord in Whop'});
  });
  it('fails closed when the verification lease expires without a successful renewal',async()=>{
    await db.query("UPDATE whop_memberships SET access_until=now()-interval '1 second' WHERE id='mem_aco'");
    expect(await identities.resolve(whopOperator.id)).toBeNull();
  });
});
