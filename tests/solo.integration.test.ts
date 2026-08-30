import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
import cookieParser from 'cookie-parser';
import type { Server } from 'node:http';
import { Repository } from '../server/database/repository.js';
import { runMigrations } from '../server/database/migrate.js';
import { SoloRepository } from '../server/solo/repository.js';
import { createSoloRouter } from '../server/solo/routes.js';
import { loadConfig } from '../server/config.js';
import { SecretBox } from '../server/security/secret-box.js';
import { CompositeCarrierTrackingProvider } from '../server/tracking/providers.js';
import { TrackingSyncCoordinator } from '../server/tracking/coordinator.js';
import { verifyGmailConnection, type MailboxSyncCoordinator } from '../server/email/imap.js';
import type { ParsedOrderEmail } from '../server/email/parser.js';
import type { SoloDashboard } from '../src/solo/types.js';
import { exchangeDiscordCode } from '../server/solo/discord.js';

vi.mock('../server/solo/discord.js',()=>({exchangeDiscordCode:vi.fn()}));

vi.mock('../server/email/imap.js',async(importOriginal)=>({
  ...await importOriginal<typeof import('../server/email/imap.js')>(),
  verifyGmailConnection:vi.fn().mockResolvedValue(undefined),
}));

const url=process.env.ACO_TEST_DATABASE_URL;
describe.skipIf(!url)('Solo Buyer service boundary (PostgreSQL + HTTP)',()=>{
  let core:Repository, accounts:SoloRepository, server:Server, base:string;
  let first:Awaited<ReturnType<SoloRepository['provision']>>, second:typeof first, cookie:string;
  const handle=`solo-${randomUUID()}`;
  const secretBox=new SecretBox(Buffer.alloc(32,7).toString('base64'));
  const suffix=randomUUID().replace(/-/g,'').slice(0,12);
  const enqueue=vi.fn();
  beforeAll(async()=>{
    if(!new URL(url!).pathname.startsWith('/aco_test_'))throw new Error('Use an aco_test_ disposable database.');
    await runMigrations(url!);core=new Repository(url!);accounts=new SoloRepository(core);
    first=await accounts.provision({handle,displayName:'Solo One',discordId:null,days:30,mailboxLimit:1});
    second=await accounts.provision({handle:`other-${suffix}`,displayName:'Solo Two',discordId:null,days:30,mailboxLimit:5});
    const config=loadConfig({DATABASE_URL:url,MAILBOX_ENCRYPTION_KEY:Buffer.alloc(32,7).toString('base64'),SESSION_SECRET:'solo-integration-session-secret',PORTAL_SECRET:'solo-integration-portal-secret',SERVICE_SERIAL:'aco-platform-service-serial',DISCORD_CLIENT_ID:'test-discord-client',DISCORD_CLIENT_SECRET:'test-discord-secret'});
    const provider=new CompositeCarrierTrackingProvider([]);
    const app=express();app.use(express.json(),cookieParser());
    app.use('/api/solo',createSoloRouter({config,repository:core,secretBox,trackingProvider:provider,
      coordinators:id=>({mailbox:{enqueue} as unknown as MailboxSyncCoordinator,tracking:new TrackingSyncCoordinator(core,id,provider)})}));
    server=await new Promise<Server>(resolve=>{const running=app.listen(0,'127.0.0.1',()=>resolve(running));});
    const address=server.address();base=`http://127.0.0.1:${typeof address==='object'&&address?address.port:0}`;
  },15000);
  afterAll(async()=>{if(server)await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));await core?.close();});
  const request=async(path:string,method='GET',body?:unknown,auth=cookie)=>fetch(base+path,{method,headers:{'Content-Type':'application/json',...(auth?{cookie:auth}:{})},body:body===undefined?undefined:JSON.stringify(body),redirect:'manual'});
  it('requires the individual serial and keeps ACO and Solo sessions separate',async()=>{
    expect((await request('/api/solo/dashboard')).status).toBe(401);
    expect((await request('/api/solo/auth/serial','POST',{serial:'aco-platform-service-serial'})).status).toBe(401);
    const login=await request('/api/solo/auth/serial','POST',{serial:first.serial});expect(login.status).toBe(200);
    cookie=login.headers.getSetCookie()[0].split(';')[0];expect(cookie).toMatch(/^solo_session=/);
    expect(await login.json()).toEqual({path:`/customer/${handle}`});
    const account=await accounts.byId(first.id);expect(await core.getCredentials(account!.workspaceId)).toBeNull();
    expect((await request('/api/solo/invoices','POST',{})).status).toBe(404);
  });
  it('returns only personal orders and mailboxes, with no fees or invoices',async()=>{
    const account=await accounts.byId(first.id),other=await accounts.byId(second.id);
    const connected=await request('/api/solo/mailboxes','POST',{name:'My inbox',gmailAddress:`buyer-${suffix}@gmail.com`,syncDays:30,appPassword:'abcd efgh ijkl mnop'});
    expect(connected.status).toBe(201);
    const {mailbox}=await connected.json() as {mailbox:{id:string}};
    expect(verifyGmailConnection).toHaveBeenCalledWith(`buyer-${suffix}@gmail.com`,'abcdefghijklmnop');
    expect(enqueue).toHaveBeenCalledWith(mailbox.id);
    const stored=(await core.getMailbox(account!.workspaceId,mailbox.id))!;
    expect(stored.secretCiphertext).not.toContain('abcdefghijklmnop');
    expect(secretBox.decrypt(stored.secretCiphertext)).toBe('abcdefghijklmnop');
    const otherMailbox=await core.createCustomer(other!.workspaceId,{name:'Other inbox',gmailAddress:`other-${suffix}@gmail.com`,syncDays:30,secretCiphertext:secretBox.encrypt('qrstuvwxyzabcdef')},5);
    const parsed:ParsedOrderEmail={messageKey:randomUUID(),merchant:'Pokemon Center',orderNumber:'MY-ORDER-1001',status:'shipped',totalCents:5999,currency:'USD',trackingNumber:'1Z9999999999999999',carrier:'UPS',trackingUrl:'https://www.ups.com/track?tracknum=1Z9999999999999999',expectedDelivery:null,orderedAt:new Date(),itemCount:1,items:[{name:'Elite Trainer Box',quantity:1,unitPriceCents:5999,totalCents:5999}]};
    const meta={messageKey:parsed.messageKey,fromAddress:'orders@example.com',subject:'Order shipped',receivedAt:parsed.orderedAt};
    await core.recordMessage(account!.workspaceId,mailbox.id,meta,parsed);
    await core.recordMessage(other!.workspaceId,otherMailbox.id,meta,{...parsed,orderNumber:'PRIVATE-ORDER-2002',status:'delivered'});
    const response=await request('/api/solo/dashboard');const payload=await response.json() as SoloDashboard;
    expect(payload.mailboxes).toHaveLength(1);expect(payload.mailboxes[0].name).toBe('My inbox');
    expect(payload.orders).toHaveLength(1);expect(payload.orders[0]).toMatchObject({orderNumber:'MY-ORDER-1001',status:'shipped',trackingNumber:parsed.trackingNumber});
    for(const field of ['feePercent','feeBasis','customBasisCents','feeBasisCents','feeCents','billingStatus','invoiceId']) expect(payload.orders[0]).not.toHaveProperty(field);
    expect(JSON.stringify(payload)).not.toContain('PRIVATE-ORDER-2002');
    expect(payload).not.toHaveProperty('invoices');expect(payload).not.toHaveProperty('workspace');
    expect(JSON.stringify(payload)).not.toContain('ciphertext');expect(JSON.stringify(payload)).not.toContain('serial_hash');
    expect((await request(`/api/solo/mailboxes/${otherMailbox.id}/sync`,'POST')).status).toBe(404);
    await expect(core.createCustomer(account!.workspaceId,{name:'Excess',gmailAddress:`excess-${suffix}@gmail.com`,syncDays:30,secretCiphertext:'encrypted'},1)).rejects.toMatchObject({code:'MAILBOX_LIMIT'});
  });
  it('rejects invalid OAuth state before contacting Discord',async()=>{
    const response=await request('/api/solo/auth/discord/callback?state=forged&code=anything');
    expect(response.status).toBe(302);expect(response.headers.get('location')).toBe('/customer?error=discord-failed');
    expect(exchangeDiscordCode).not.toHaveBeenCalled();
  });
  it('links through signed OAuth state and allows subsequent Discord-only login',async()=>{
    const discordId=String(200000000000000000n+BigInt(`0x${suffix}`));
    const username=`discord.${suffix}`;
    vi.mocked(exchangeDiscordCode).mockResolvedValue({id:discordId,username});
    for(const auth of [cookie,'']) {
      const begin=await request('/api/solo/auth/discord','GET',undefined,auth);
      const location=new URL(begin.headers.get('location')!);
      expect(location.origin).toBe('https://discord.com');expect(location.searchParams.get('scope')).toBe('identify');
      const stateCookie=begin.headers.getSetCookie()[0].split(';')[0];
      const callback=await request(`/api/solo/auth/discord/callback?state=${location.searchParams.get('state')}&code=test-code`,'GET',undefined,[auth,stateCookie].filter(Boolean).join('; '));
      expect(callback.status).toBe(302);expect(callback.headers.get('location')).toBe(`/customer/${username}`);
      expect(callback.headers.getSetCookie().some(value=>value.startsWith('solo_session='))).toBe(true);
    }
    expect((await accounts.byDiscord(discordId))?.id).toBe(first.id);
  });
  it('does not give free access to an unprovisioned Discord identity',async()=>{
    vi.mocked(exchangeDiscordCode).mockResolvedValue({id:'888888888888888888',username:'unprovisioned-buyer'});
    const begin=await request('/api/solo/auth/discord','GET',undefined,'');
    const location=new URL(begin.headers.get('location')!);
    const stateCookie=begin.headers.getSetCookie()[0].split(';')[0];
    const callback=await request(`/api/solo/auth/discord/callback?state=${location.searchParams.get('state')}&code=test-code`,'GET',undefined,stateCookie);
    expect(callback.headers.get('location')).toBe('/customer?error=solo-access-required');
    expect(callback.headers.getSetCookie().some(value=>value.startsWith('solo_session='))).toBe(false);
  });
  it('includes personal history beyond the ACO dashboard limit',async()=>{
    const account=(await accounts.byId(first.id))!;
    const mailbox=(await core.listCustomerIds(account.workspaceId))[0];
    const client=await core.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.workspace_id',$1,true)",[account.workspaceId]);
      await client.query(`INSERT INTO orders(id,workspace_id,customer_id,merchant,order_number,ordered_at,total_cents,status,source_message_key)
        SELECT gen_random_uuid(),$1,$2,'History retailer','HISTORY-'||n,now(),100,'confirmed','history-'||n FROM generate_series(1,2001) n`,[account.workspaceId,mailbox]);
      await client.query('COMMIT');
    } finally {client.release();}
    const response=await request('/api/solo/dashboard');
    const payload=await response.json() as SoloDashboard;
    expect(payload.orders).toHaveLength(2002);
    expect(payload.orders.some(order=>order.orderNumber==='MY-ORDER-1001')).toBe(true);
  });
  it('links verified Discord IDs without merging accounts or transferring identity',async()=>{
    const discordId=String(100000000000000000n+BigInt(`0x${suffix}`));
    const account=(await accounts.byId(second.id))!;
    const linked=await accounts.linkDiscord(account,discordId,`verified.${suffix}`);
    expect(linked?.handle).toBe(`verified.${suffix}`);
    expect((await accounts.byDiscord(discordId))?.id).toBe(second.id);
    await expect(accounts.linkDiscord(linked!,'999999999999999999','another-buyer')).rejects.toThrow();
    await expect(accounts.linkDiscord((await accounts.byId(first.id))!,discordId,`verified.${suffix}`)).rejects.toThrow();
    expect((await accounts.byDiscord(discordId))?.id).toBe(second.id);
  });
  it('revokes old serials and sessions, and excludes expired accounts from polling',async()=>{
    const replacement=await accounts.rotateSerial((await accounts.byId(first.id))!.handle);
    expect(await accounts.bySerial(first.serial)).toBeNull();expect(await accounts.bySerial(replacement)).not.toBeNull();
    expect((await request('/api/solo/dashboard')).status).toBe(401);
    const secondAccount=(await accounts.byId(second.id))!;
    await core.pool.query("UPDATE solo_accounts SET access_expires_at=now()-interval '1 day' WHERE id=$1",[second.id]);
    expect(await accounts.bySerial(second.serial)).toBeNull();
    expect(await core.listActiveWorkspaceIds()).not.toContain(secondAccount.workspaceId);
    const expiry=await accounts.renewAccess(secondAccount.handle,30);
    expect(Date.parse(expiry)).toBeGreaterThan(Date.now()+29*86400000);
    expect(await accounts.bySerial(second.serial)).not.toBeNull();
    await core.pool.query("UPDATE workspaces SET status='suspended' WHERE id=$1",[secondAccount.workspaceId]);
    await accounts.renewAccess(secondAccount.handle,30);
    expect(await accounts.bySerial(second.serial)).toBeNull();
    expect(await core.listActiveWorkspaceIds()).not.toContain(secondAccount.workspaceId);
  });
});
