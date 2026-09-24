import { createHmac, timingSafeEqual, randomBytes, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import type { AppConfig } from '../config.js';
import type { Repository } from '../database/repository.js';
import { serialHash } from '../solo/repository.js';
import { membershipSchema, LicenseError, type Membership, type VerifiedLicense } from './whop-membership.js';

// Both REST and webhook payloads must be pinned to this contract.
export const WHOP_API_VERSION = '2026-09-15';
const eventSchema=z.object({id:z.string(),type:z.string(),api_version:z.literal('v1'),api_version_date:z.literal(WHOP_API_VERSION).nullable(),
  account_id:z.string().optional(),company_id:z.string().nullable().optional(),
  data:z.object({id:z.string(),membership_id:z.string().nullable().optional(),membership:z.object({id:z.string()}).nullable().optional(),member:z.object({id:z.string()}).nullable().optional()})});
const supportedEvents=new Set(['membership.activated','membership.deactivated','membership.cancel_at_period_end_changed','payment.succeeded','payment.failed']);
export class WhopWebhookError extends Error {}
export class WhopCheckoutError extends Error {}

export function verifyWhopEvent(raw:Buffer, headers:Record<string,string|undefined>, secret:string, now=Date.now()) {
  const id=headers['webhook-id'], timestamp=headers['webhook-timestamp'], signature=headers['webhook-signature'];
  if(!id||!timestamp||!/^\d+$/.test(timestamp)||!signature||Math.abs(now/1000-Number(timestamp))>300)throw new Error('Invalid webhook signature.');
  // Current Whop ws_ secrets are literal HMAC keys, not base64 whsec_ keys.
  const expected=createHmac('sha256',secret).update(`${id}.${timestamp}.`).update(raw).digest();
  const matches=signature.split(/\s+/).some(part=>{
    const [version,value]=part.split(',');if(version!=='v1'||!value)return false;
    const candidate=Buffer.from(value,'base64');return candidate.length===expected.length&&timingSafeEqual(candidate,expected);
  });
  if(!matches)throw new Error('Invalid webhook signature.');
  const event=eventSchema.parse(JSON.parse(raw.toString('utf8')));
  if(event.id!==id)throw new Error('Webhook ID does not match.');
  return event;
}

export function whopAccessUntil(membership:Membership,now=Date.now()) {
  if(!['active','trialing','completed'].includes(membership.status))return new Date(now);
  // Recheck every 15 minutes; fail closed after one hour without verification.
  return new Date(Math.min(now+3600000,membership.current_period_end ? Date.parse(membership.current_period_end) : now+3600000));
}

export class WhopService {
  private timer:NodeJS.Timeout|null=null;
  private running=false;
  readonly configured:boolean;
  constructor(private readonly config:AppConfig,private readonly core:Repository) {
    this.configured=Boolean(config.whopApiKey&&config.whopWebhookSecret&&config.whopAccountId&&(config.whopSoloProductId||config.whopAcoProductId));
  }
  async receive(raw:Buffer,headers:Record<string,string|undefined>) {
    if(!this.configured)throw new Error('Whop is not configured.');
    let event:ReturnType<typeof verifyWhopEvent>;
    try {event=verifyWhopEvent(raw,headers,this.config.whopWebhookSecret!);}
    catch {throw new WhopWebhookError('Invalid webhook.');}
    if((event.account_id??event.company_id)!==this.config.whopAccountId)throw new WhopWebhookError('Unexpected Whop account.');
    if(!supportedEvents.has(event.type))return;
    const membershipId=event.type.startsWith('membership.')?event.data.id:event.data.membership_id??event.data.membership?.id??event.data.member?.id;
    if(!membershipId?.startsWith('mem_'))return;
    // Acknowledge only after durable insertion; no raw customer payload retained.
    // Failed renewals suspend access immediately and remain blocked until a later
    // successful payment/activation is confirmed by Whop.
    const client=await this.core.pool.connect();
    try {
      await client.query('BEGIN');
      const inserted=await client.query(`INSERT INTO whop_jobs(id,membership_id,event_type) VALUES($1,$2,$3) ON CONFLICT(id) DO NOTHING RETURNING id`,[event.id,membershipId,event.type]);
      if(inserted.rowCount&&['payment.failed','membership.deactivated'].includes(event.type))await client.query(`UPDATE whop_memberships SET access_suspended=true,valid=false,access_until=now(),checked_at=now(),last_error=$2 WHERE id=$1`,[membershipId,event.type==='payment.failed'?'Whop payment failed':'Whop membership deactivated']);
      await client.query('COMMIT');
    } catch(error) {await client.query('ROLLBACK');throw error;}
    finally {client.release();}
  }
  start() {
    if(!this.configured||this.timer)return;
    this.timer=setInterval(()=>void this.tick(),5000);this.timer.unref();void this.tick();
  }
  stop(){if(this.timer)clearInterval(this.timer);this.timer=null;}
  async verifyLicense(serial:string,product:'solo'|'aco'):Promise<VerifiedLicense> {
    if(!this.config.whopApiKey||!this.config.whopAccountId)throw new LicenseError('License verification is not configured. Contact the service owner.');
    const productId=product==='solo'?this.config.whopSoloProductId:this.config.whopAcoProductId;
    if(!productId)throw new LicenseError('This product is not configured. Contact the service owner.');
    const client=await this.core.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(731240191)');
      // Official retrieve-membership endpoint accepts a license key as its ID.
      // Require an exact key match too: a public mem_ ID must never log in.
      const m=membershipSchema.parse(await this.get(`/memberships/${encodeURIComponent(serial.trim())}`));
      if(m.account.id!==this.config.whopAccountId||m.product_id!==productId||!m.license_key||serialHash(m.license_key)!==serialHash(serial)) {
        throw new LicenseError('That license key does not belong to this product.');
      }
      await this.applyMembership(client,m,product);
      const result=await client.query<{workspace_id:string}>(`SELECT workspace_id FROM whop_memberships
        WHERE id=$1 AND valid AND NOT access_suspended AND access_until>now() AND workspace_has_access(workspace_id)`,[m.id]);
      await client.query('COMMIT');
      if(!result.rows[0])throw new LicenseError('That license is expired, inactive, or suspended.');
      return {membershipId:m.id,workspaceId:result.rows[0].workspace_id,product,licenseHash:serialHash(serial)};
    } catch(error) {
      await client.query('ROLLBACK');
      if(error instanceof LicenseError)throw error;
      throw new LicenseError('The license could not be verified. Check the key and try again shortly.');
    } finally {client.release();}
  }
  async createCheckout(product:'solo'|'aco') {
    const planId=product==='solo'?this.config.whopSoloPlanId:this.config.whopAcoPlanId;
    const productId=product==='solo'?this.config.whopSoloProductId:this.config.whopAcoProductId;
    if(!this.config.whopApiKey||!this.config.whopWebhookSecret||!this.config.whopAccountId||!planId||!productId)throw new WhopCheckoutError('Checkout and paid-access verification are not configured for this product yet.');
    try {
      const plan=z.object({id:z.string(),product:z.object({id:z.string()}).optional(),company:z.object({id:z.string()}).optional(),account:z.object({id:z.string()}).optional()})
        .parse(await this.get(`/plans/${encodeURIComponent(planId)}`));
      if(plan.id!==planId||plan.product?.id!==productId||(plan.company?.id??plan.account?.id)!==this.config.whopAccountId)throw new WhopCheckoutError('The configured Whop plan does not match this product.');
      const returnUrl=new URL('/checkout/complete',this.config.appOrigin);returnUrl.searchParams.set('product',product);
      const response=await fetch('https://api.whop.com/api/v1/checkout_configurations',{method:'POST',headers:{Authorization:`Bearer ${this.config.whopApiKey}`,'Api-Version-Date':WHOP_API_VERSION,'Content-Type':'application/json','Idempotency-Key':randomUUID()},body:JSON.stringify({account_id:this.config.whopAccountId,plan_id:planId,mode:'payment',redirect_url:returnUrl.toString(),metadata:{source:'ordertracker-pro',product_type:product}}),signal:AbortSignal.timeout(10000)});
      if(!response.ok)throw new Error('Whop checkout configuration failed');
      const checkout=z.object({id:z.string().regex(/^ch_/),plan:z.object({id:z.string()}).optional()}).parse(await response.json());
      if(checkout.plan?.id&&checkout.plan.id!==planId)throw new Error('Whop returned a different plan');
      return {sessionId:checkout.id,planId,returnUrl:returnUrl.toString()};
    } catch(error) {if(error instanceof WhopCheckoutError)throw error;throw new WhopCheckoutError('Whop could not prepare checkout. Verify the plan ID and API permissions.');}
  }
  async tick() {
    if(this.running||!this.configured)return;this.running=true;
    try { for(let n=0;n<10;n++){if(!await this.processOne())break;} }
    catch {console.warn('[whop] Membership reconciliation failed; queued work will retry.');}
    finally {this.running=false;}
  }
  async processOne():Promise<boolean> {
    const client=await this.core.pool.connect();
    let jobId:string|null=null,membershipId:string|null=null,eventType:string|null=null;
    try {
      await client.query('BEGIN');
      const lock=await client.query<{locked:boolean}>('SELECT pg_try_advisory_xact_lock(731240191) AS locked');
      if(!lock.rows[0].locked){await client.query('ROLLBACK');return false;}
      const jobs=await client.query<{id:string;membership_id:string;event_type:string}>(`SELECT id,membership_id,event_type FROM whop_jobs
        WHERE processed_at IS NULL AND next_attempt_at<=now() ORDER BY received_at LIMIT 1 FOR UPDATE SKIP LOCKED`);
      jobId=jobs.rows[0]?.id??null;membershipId=jobs.rows[0]?.membership_id??null;eventType=jobs.rows[0]?.event_type??null;
      if(!membershipId){
        const due=await client.query<{id:string}>('SELECT id FROM whop_memberships WHERE next_check_at<=now() ORDER BY next_check_at LIMIT 1 FOR UPDATE SKIP LOCKED');
        membershipId=due.rows[0]?.id??null;
      }
      if(!membershipId){await client.query('COMMIT');return false;}
      const membership=membershipSchema.parse(await this.get(`/memberships/${encodeURIComponent(membershipId)}`));
      if(membership.id!==membershipId)throw new Error('Membership mismatch');
      const product=membership.account.id!==this.config.whopAccountId?null:membership.product_id===this.config.whopSoloProductId?'solo':membership.product_id===this.config.whopAcoProductId?'aco':null;
      if(product)await this.applyMembership(client,membership,product,eventType);
      else await client.query("UPDATE whop_memberships SET valid=false,access_suspended=true,access_until=now(),next_check_at=now()+interval '15 minutes',last_error='Product or account is no longer allowed' WHERE id=$1",[membershipId]);
      if(jobId)await client.query('UPDATE whop_jobs SET processed_at=now(),last_error=NULL WHERE id=$1',[jobId]);
      await client.query('COMMIT');return true;
    } catch {
      await client.query('ROLLBACK');
      if(jobId)await this.core.pool.query(`UPDATE whop_jobs SET attempts=attempts+1,last_error='Membership verification failed',
        next_attempt_at=now()+LEAST(3600,30*power(2,LEAST(attempts,7)))*interval '1 second' WHERE id=$1`,[jobId]);
      else if(membershipId)await this.core.pool.query(`UPDATE whop_memberships SET last_error='Membership verification failed',next_check_at=now()+interval '5 minutes' WHERE id=$1`,[membershipId]);
      console.warn('[whop] Verification deferred; existing access leases are not extended.');
      return false;
    } finally {client.release();}
  }
  private async get(path:string):Promise<unknown> {
    const response=await fetch(`https://api.whop.com/api/v1${path}`,{headers:{Authorization:`Bearer ${this.config.whopApiKey}`,'Api-Version-Date':WHOP_API_VERSION},signal:AbortSignal.timeout(10000)});
    if(!response.ok)throw new Error('Whop verification unavailable');
    return response.json();
  }
  private async applyMembership(client:PoolClient,membership:Membership,product:'solo'|'aco',eventType:string|null=null) {
    const until=whopAccessUntil(membership);
    const previous=await client.query<{workspace_id:string|null;discord_id:string|null;user_id:string|null;product_type:string;license_hash:string|null;access_suspended:boolean}>(
      'SELECT workspace_id,discord_id,user_id,product_type,license_hash,access_suspended FROM whop_memberships WHERE id=$1 FOR UPDATE',[membership.id]);
    const prior=previous.rows[0];
    const accessSuspended=['payment.failed','membership.deactivated'].includes(eventType??'')?true:eventType==='payment.succeeded'||eventType==='membership.activated'?false:(prior?.access_suspended??false);
    const valid=until.getTime()>Date.now()&&Boolean(membership.user_id)&&!accessSuspended;
    // Identity comes from our explicit serial -> OAuth claim, never from a
    // mutable Whop social-account field. Transfers get a new empty workspace.
    const sameOwner=prior&&prior.user_id===membership.user_id&&prior.product_type===product;
    let workspaceId=sameOwner?prior.workspace_id:null;
    let discordId=sameOwner?prior.discord_id:null;
    const username=membership.username??'Whop buyer';
    const licenseHash=membership.license_key?serialHash(membership.license_key):null;
    if(valid&&!workspaceId){
      workspaceId=randomUUID();const slug=`${product}-${randomUUID()}`;
      const name=product==='aco'?'My ACO workspace':username;
      await client.query("SELECT set_config('app.workspace_id',$1,true)",[workspaceId]);
      await client.query(`INSERT INTO workspaces(id,slug,name,node_group_key,status,product_type,access_source)
        VALUES($1,$2,$3,$2,'active',$4,'whop')`,[workspaceId,slug,name,product]);
      await client.query('INSERT INTO workspace_settings(workspace_id,display_name) VALUES($1,$2)',[workspaceId,name]);
      if(product==='solo'){
        await client.query(`INSERT INTO solo_accounts(id,workspace_id,handle,display_name,serial_hash,access_expires_at,mailbox_limit)
          VALUES($1,$2,$3,$4,$5,$6,$7)`,[randomUUID(),workspaceId,`buyer-${randomUUID()}`,username,
          serialHash(randomBytes(32).toString('base64url')),'9999-12-31T00:00:00Z',this.config.whopSoloMailboxLimit]);
      }else{
        // Retained only for session versioning; no password login endpoint exists.
        await client.query('INSERT INTO workspace_credentials(workspace_id,password_hash) VALUES($1,$2)',[workspaceId,'!license-only']);
      }
    }
    if(workspaceId){
      await client.query("SELECT set_config('app.workspace_id',$1,true)",[workspaceId]);
      const binding=await client.query<{discord_id:string}>('SELECT discord_id FROM discord_bindings WHERE workspace_id=$1',[workspaceId]);
      discordId=binding.rows[0]?.discord_id??discordId;
    }
    await client.query(`INSERT INTO whop_memberships(id,user_id,discord_id,product_type,workspace_id,valid,access_until,next_check_at,last_error,company_id,product_id,license_hash,whop_username,access_suspended)
      VALUES($1,$2,$3,$4,$5,$6,$7,now()+interval '15 minutes',$8,$9,$10,$11,$12,$13)
      ON CONFLICT(id) DO UPDATE SET user_id=EXCLUDED.user_id,discord_id=EXCLUDED.discord_id,product_type=EXCLUDED.product_type,
      workspace_id=EXCLUDED.workspace_id,valid=EXCLUDED.valid,access_until=EXCLUDED.access_until,checked_at=now(),next_check_at=EXCLUDED.next_check_at,last_error=EXCLUDED.last_error,
      company_id=EXCLUDED.company_id,product_id=EXCLUDED.product_id,license_hash=EXCLUDED.license_hash,whop_username=EXCLUDED.whop_username,access_suspended=EXCLUDED.access_suspended`,
    [membership.id,membership.user_id,discordId,product,workspaceId,valid,until,accessSuspended?(eventType==='membership.deactivated'?'Whop membership deactivated':'Whop payment failed'):null,membership.account.id,membership.product_id,licenseHash,username,accessSuspended]);
  }
}
