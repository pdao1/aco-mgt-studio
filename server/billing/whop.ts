import { createHmac, timingSafeEqual, randomBytes, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import type { AppConfig } from '../config.js';
import type { Repository } from '../database/repository.js';
import { bindDiscord } from '../auth/repository.js';
import { serialHash } from '../solo/repository.js';
import { hashPassword } from '../security/password.js';

// Both REST and webhook payloads must be pinned to this contract.
export const WHOP_API_VERSION = '2026-09-15';
const membershipSchema=z.object({id:z.string().regex(/^mem_/),account:z.object({id:z.string()}),product_id:z.string(),
  user_id:z.string().nullable(),status:z.string(),current_period_end:z.string().datetime({offset:true}).nullable()});
type Membership=z.infer<typeof membershipSchema>;
const eventSchema=z.object({id:z.string(),type:z.string(),api_version:z.literal('v1'),api_version_date:z.literal(WHOP_API_VERSION),account_id:z.string(),data:z.object({id:z.string(),membership_id:z.string().nullable().optional()})});
const supportedEvents=new Set(['membership.activated','membership.deactivated','membership.cancel_at_period_end_changed','payment.succeeded','payment.failed']);
export class WhopWebhookError extends Error {}

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
    if(event.account_id!==this.config.whopAccountId)throw new WhopWebhookError('Unexpected Whop account.');
    if(!supportedEvents.has(event.type))return;
    const membershipId=event.type.startsWith('membership.')?event.data.id:event.data.membership_id;
    if(!membershipId?.startsWith('mem_'))return;
    // Acknowledge only after durable insertion; no raw customer payload retained.
    await this.core.pool.query(`INSERT INTO whop_jobs(id,membership_id) VALUES($1,$2) ON CONFLICT(id) DO NOTHING`,[event.id,membershipId]);
  }
  start() {
    if(!this.configured||this.timer)return;
    this.timer=setInterval(()=>void this.tick(),5000);this.timer.unref();void this.tick();
  }
  stop(){if(this.timer)clearInterval(this.timer);this.timer=null;}
  async tick() {
    if(this.running||!this.configured)return;this.running=true;
    try { for(let n=0;n<10;n++){if(!await this.processOne())break;} }
    catch {console.warn('[whop] Membership reconciliation failed; queued work will retry.');}
    finally {this.running=false;}
  }
  async processOne():Promise<boolean> {
    const client=await this.core.pool.connect();
    let jobId:string|null=null,membershipId:string|null=null;
    try {
      await client.query('BEGIN');
      const lock=await client.query<{locked:boolean}>('SELECT pg_try_advisory_xact_lock(731240191) AS locked');
      if(!lock.rows[0].locked){await client.query('ROLLBACK');return false;}
      const jobs=await client.query<{id:string;membership_id:string}>(`SELECT id,membership_id FROM whop_jobs
        WHERE processed_at IS NULL AND next_attempt_at<=now() ORDER BY received_at LIMIT 1 FOR UPDATE SKIP LOCKED`);
      jobId=jobs.rows[0]?.id??null;membershipId=jobs.rows[0]?.membership_id??null;
      if(!membershipId){
        const due=await client.query<{id:string}>('SELECT id FROM whop_memberships WHERE next_check_at<=now() ORDER BY next_check_at LIMIT 1 FOR UPDATE SKIP LOCKED');
        membershipId=due.rows[0]?.id??null;
      }
      if(!membershipId){await client.query('COMMIT');return false;}
      const membership=membershipSchema.parse(await this.get(`/memberships/${encodeURIComponent(membershipId)}`));
      if(membership.id!==membershipId)throw new Error('Membership mismatch');
      const product=membership.account.id!==this.config.whopAccountId?null:membership.product_id===this.config.whopSoloProductId?'solo':membership.product_id===this.config.whopAcoProductId?'aco':null;
      if(product)await this.applyMembership(client,membership,product);
      else await client.query("UPDATE whop_memberships SET valid=false,access_until=now(),next_check_at=now()+interval '15 minutes',last_error='Product or account is no longer allowed' WHERE id=$1",[membershipId]);
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
  private async applyMembership(client:PoolClient,membership:Membership,product:'solo'|'aco') {
    const until=whopAccessUntil(membership), valid=until.getTime()>Date.now();
    const previous=await client.query<{workspace_id:string|null;discord_id:string|null;user_id:string|null}>('SELECT workspace_id,discord_id,user_id FROM whop_memberships WHERE id=$1 FOR UPDATE',[membership.id]);
    let discordId:string|null=null,username='Whop buyer',workspaceId:string|null=null;
    if(valid&&membership.user_id){
      const user=z.object({id:z.string(),username:z.string(),social_accounts:z.array(z.object({platform:z.string(),external_id:z.string().nullable(),username:z.string().nullable()}))}).parse(await this.get(`/users/${encodeURIComponent(membership.user_id)}`));
      if(user.id!==membership.user_id)throw new Error('Whop identity mismatch');
      const discord=user.social_accounts.find(s=>s.platform==='discord'&&s.external_id&&/^\d{17,20}$/.test(s.external_id));
      discordId=discord?.external_id??null;username=discord?.username??user.username;
    }
    // Transfers never move the previous customer's data to the new purchaser.
    const prior=previous.rows[0];
    if(valid&&discordId){
      const identity={id:discordId,username};
      await client.query(`INSERT INTO discord_identities(discord_id,username) VALUES($1,$2)
        ON CONFLICT(discord_id) DO UPDATE SET username=EXCLUDED.username`,[discordId,username]);
      const existing=await client.query<{id:string}>(`SELECT w.id FROM discord_bindings b JOIN workspaces w ON w.id=b.workspace_id
        WHERE b.discord_id=$1 AND w.product_type=$2 ORDER BY b.created_at LIMIT 1`,[discordId,product]);
      workspaceId=existing.rows[0]?.id??null;
      if(!workspaceId){
        workspaceId=randomUUID();const slug=`${product}-${randomUUID()}`;
        await client.query("SELECT set_config('app.workspace_id',$1,true)",[workspaceId]);
        await client.query(`INSERT INTO workspaces(id,slug,name,node_group_key,status,product_type,access_source)
          VALUES($1,$2,$3,$2,'active',$4,'whop')`,[workspaceId,slug,`${username}'s ${product==='solo'?'purchases':'workspace'}`,product]);
        await client.query('INSERT INTO workspace_settings(workspace_id,display_name) VALUES($1,$2)',[workspaceId,`${username}'s ${product==='solo'?'purchases':'workspace'}`]);
        if(product==='solo'){
          // Generated credential is intentionally undisclosed; login is via Discord.
          await client.query(`INSERT INTO solo_accounts(id,workspace_id,handle,discord_id,display_name,serial_hash,access_expires_at,mailbox_limit)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[randomUUID(),workspaceId,`buyer-${discordId}`,discordId,username,serialHash(`solo_${randomBytes(32).toString('base64url')}`),'9999-12-31T00:00:00Z',this.config.whopSoloMailboxLimit]);
        }else{
          await client.query('INSERT INTO workspace_credentials(workspace_id,password_hash) VALUES($1,$2)',[workspaceId,await hashPassword(randomBytes(32).toString('base64url'))]);
        }
      }
      await bindDiscord(client,identity,workspaceId,false);
      // A verified purchase makes Whop authoritative for this product's access.
      await client.query("UPDATE workspaces SET access_source='whop' WHERE id=$1",[workspaceId]);
      if(product==='solo')await client.query("UPDATE solo_accounts SET access_expires_at='9999-12-31T00:00:00Z' WHERE workspace_id=$1",[workspaceId]);
    }else if(!valid&&prior&&prior.user_id===membership.user_id){workspaceId=prior.workspace_id;discordId=prior.discord_id;}
    await client.query(`INSERT INTO whop_memberships(id,user_id,discord_id,product_type,workspace_id,valid,access_until,next_check_at,last_error)
      VALUES($1,$2,$3,$4,$5,$6,$7,now()+interval '15 minutes',$8)
      ON CONFLICT(id) DO UPDATE SET user_id=EXCLUDED.user_id,discord_id=EXCLUDED.discord_id,product_type=EXCLUDED.product_type,
      workspace_id=EXCLUDED.workspace_id,valid=EXCLUDED.valid,access_until=EXCLUDED.access_until,checked_at=now(),next_check_at=EXCLUDED.next_check_at,last_error=EXCLUDED.last_error`,
    [membership.id,membership.user_id,discordId,product,workspaceId,valid&&Boolean(discordId),until,valid&&!discordId?'Buyer must link Discord in Whop':null]);
  }
}
