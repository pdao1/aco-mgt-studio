import { randomBytes } from 'node:crypto';
import { Router, type Request } from 'express';
import { z } from 'zod';
import type { AppConfig } from '../config.js';
import { BillingValidationError, type Repository } from '../database/repository.js';
import { verifyGmailConnection, type MailboxSyncCoordinator } from '../email/imap.js';
import type { SecretBox } from '../security/secret-box.js';
import { loginRateLimit } from '../security/session.js';
import type { CompositeCarrierTrackingProvider } from '../tracking/providers.js';
import type { TrackingSyncCoordinator } from '../tracking/coordinator.js';
import { THEME_IDS } from '../../src/lib/themes.js';
import { SoloRepository, type SoloAccount } from './repository.js';
import { SOLO_COOKIE, clearSoloSession, issueSoloSession, readValue, signValue, type SoloSession } from './session.js';
import { exchangeDiscordCode } from './discord.js';
import { clearDiscordSession } from '../auth/discord.js';

declare global { namespace Express { interface Request { soloAccount?: SoloAccount } } }
interface Dependencies {
  config: AppConfig; repository: Repository; secretBox: SecretBox; trackingProvider: CompositeCarrierTrackingProvider;
  coordinators: (id: string) => {mailbox: MailboxSyncCoordinator; tracking: TrackingSyncCoordinator};
}
interface OAuthState { nonce:string; expiresAt:number; accountId:string|null; version:number|null }
const STATE_COOKIE='solo_discord_state';

export function createSoloRouter({config,repository,secretBox,trackingProvider,coordinators}: Dependencies) {
  const router=Router(), accounts=new SoloRepository(repository), limiter=loginRateLimit();
  const secure=config.nodeEnv==='production';
  const discordReady=Boolean(config.discordClientId && config.discordClientSecret);
  const redirectUri=`${config.appOrigin}/api/solo/auth/discord/callback`;
  async function sessionAccount(request: Request) {
    const session=readValue<SoloSession>(request.cookies?.[SOLO_COOKIE],'solo-session',config.sessionSecret);
    if (!session || typeof session.accountId!=='string' || !z.string().uuid().safeParse(session.accountId).success) return null;
    const account=await accounts.byId(session.accountId);
    return account && account.sessionVersion===session.version ? account : null;
  }
  router.use((_request,response,next)=>{response.setHeader('Cache-Control','private, no-store');next();});
  router.get('/auth/options',(_request,response)=>response.json({discordAvailable:discordReady}));
  router.get('/auth/session',async(request,response,next)=>{
    try {
      const account=await sessionAccount(request);
      if (!account) {
        if (request.cookies?.[SOLO_COOKIE]) clearSoloSession(response,secure);
        response.json({authenticated:false});return;
      }
      response.json({authenticated:true,path:`/customer/${account.handle}`});
    } catch(error){next(error);}
  });
  router.post('/auth/serial',limiter,async(request,response,next)=>{
    const parsed=z.object({serial:z.string().trim().min(20).max(150)}).strict().safeParse(request.body);
    try {
      const account=parsed.success ? await accounts.bySerial(parsed.data.serial) : null;
      if (!account) {response.status(401).json({message:'That Solo Buyer serial is invalid, expired, or suspended.'});return;}
      issueSoloSession(response,account.id,account.sessionVersion,config.sessionSecret,secure,account.accessExpiresAt);
      response.json({path:`/customer/${account.handle}`});
    } catch(error){next(error);}
  });
  router.post('/auth/logout',(_request,response)=>{clearDiscordSession(response,secure);clearSoloSession(response,secure);response.json({ok:true});});
  router.get('/auth/discord',limiter,async(request,response,next)=>{
    if (!discordReady) {response.redirect('/customer?error=discord-unavailable');return;}
    try {
      const account=await sessionAccount(request);
      const state:OAuthState={nonce:randomBytes(32).toString('base64url'),expiresAt:Date.now()+10*60_000,accountId:account?.id??null,version:account?.sessionVersion??null};
      response.cookie(STATE_COOKIE,signValue(state,'discord-state',config.sessionSecret),{httpOnly:true,secure,sameSite:'lax',path:'/api/solo/auth/discord',maxAge:10*60_000});
      const url=new URL('https://discord.com/oauth2/authorize');
      url.search=new URLSearchParams({client_id:config.discordClientId!,response_type:'code',scope:'identify',redirect_uri:redirectUri,state:state.nonce}).toString();
      response.redirect(url.toString());
    } catch(error){next(error);}
  });
  router.get('/auth/discord/callback',async(request,response)=>{
    const state=readValue<OAuthState>(request.cookies?.[STATE_COOKIE],'discord-state',config.sessionSecret);
    response.clearCookie(STATE_COOKIE,{httpOnly:true,secure,sameSite:'lax',path:'/api/solo/auth/discord'});
    if (!discordReady || !state || request.query.state!==state.nonce || typeof request.query.code!=='string') {response.redirect('/customer?error=discord-failed');return;}
    try {
      const user=await exchangeDiscordCode(request.query.code,config.discordClientId!,config.discordClientSecret!,redirectUri);
      let account=await accounts.byDiscord(user.id);
      if (state.accountId) {
        const linking=await accounts.byId(state.accountId);
        if (!linking || linking.sessionVersion!==state.version || (account && account.id!==linking.id)) throw new Error('Account conflict');
        account=await accounts.linkDiscord(linking,user.id,user.username);
      } else if (account) account=await accounts.linkDiscord(account,user.id,user.username);
      if (!account) {response.redirect('/customer?error=solo-access-required');return;}
      issueSoloSession(response,account.id,account.sessionVersion,config.sessionSecret,secure,account.accessExpiresAt);
      response.redirect(`/customer/${account.handle}`);
    } catch {response.redirect('/customer?error=discord-failed');}
  });
  router.use(async(request,response,next)=>{
    try {
      const account=await sessionAccount(request);
      if (!account) {response.status(401).json({message:'Sign in with Discord or your Solo Buyer product serial.'});return;}
      if(request.discordWorkspaceId && request.discordWorkspaceId!==account.workspaceId){response.status(401).json({message:'Sign in again.'});return;}
      request.soloAccount=account;next();
    } catch(error){next(error);}
  });
  router.get('/dashboard',async(request,response,next)=>{
    try {
      const account=request.soloAccount!;
      // Personal spending summaries cover every parsed order in the account.
      const data=await repository.dashboard(account.workspaceId,null);
      response.json({account:{handle:account.handle,displayName:account.displayName,discordLinked:Boolean(account.discordId),discordAvailable:discordReady,accessExpiresAt:account.accessExpiresAt,mailboxLimit:account.mailboxLimit},
        appearance:{theme:data.workspace.settings.theme,accentColor:data.workspace.settings.accentColor},mailboxes:data.customers,
        orders:data.orders.map(({feePercent,feeBasis,customBasisCents,feeBasisCents,feeCents,billingStatus,invoiceId,...order})=>order),
        tracking:{providers:trackingProvider.availability(),environment:config.trackingEnvironment,...coordinators(account.workspaceId).tracking.summary},
      });
    } catch(error){next(error);}
  });
  router.post('/mailboxes',async(request,response,next)=>{
    const parsed=z.object({name:z.string().trim().min(1).max(120),gmailAddress:z.string().trim().toLowerCase().email().endsWith('@gmail.com'),appPassword:z.string().max(100).transform(v=>v.replace(/\s/g,'')).pipe(z.string().length(16)),syncDays:z.number().int().min(30).max(365)}).strict().safeParse(request.body);
    if (!parsed.success) {response.status(400).json({message:'Enter a Gmail address, its 16-character app password, and a mailbox label.'});return;}
    try {
      const account=request.soloAccount!;
      await verifyGmailConnection(parsed.data.gmailAddress,parsed.data.appPassword);
      const mailbox=await repository.createCustomer(account.workspaceId,{...parsed.data,secretCiphertext:secretBox.encrypt(parsed.data.appPassword)},account.mailboxLimit);
      coordinators(account.workspaceId).mailbox.enqueue(mailbox.id);
      response.status(201).json({mailbox});
    } catch(error){
      if (error instanceof BillingValidationError) {response.status(409).json({message:error.message});return;}
      if (error && typeof error==='object' && 'code' in error && error.code==='23505') {response.status(409).json({message:'That mailbox is already connected.'});return;}
      if (error instanceof Error && /Gmail|app password/i.test(error.message)) {response.status(422).json({message:error.message});return;}
      next(error);
    }
  });
  router.post('/mailboxes/:id/sync',async(request,response,next)=>{
    if (!z.string().uuid().safeParse(request.params.id).success) {response.status(404).json({message:'Mailbox not found.'});return;}
    try {
      const id=request.params.id as string, account=request.soloAccount!;
      if (!await repository.getMailbox(account.workspaceId,id)) {response.status(404).json({message:'Mailbox not found.'});return;}
      coordinators(account.workspaceId).mailbox.enqueue(id,{fullHistory:true});response.status(202).json({accepted:true});
    } catch(error){next(error);}
  });
  router.delete('/mailboxes/:id',async(request,response,next)=>{
    if (!z.string().uuid().safeParse(request.params.id).success) {response.status(404).json({message:'Mailbox not found.'});return;}
    try {
      const removed=await repository.removeCustomer(request.soloAccount!.workspaceId,request.params.id);
      if(!removed){response.status(404).json({message:'Mailbox not found.'});return;}
      response.json({ok:true});
    } catch(error){next(error);}
  });
  const archiveSchema=z.object({archived:z.boolean()}).strict();
  router.patch('/orders/:orderId/archive',async(request,response,next)=>{
    const parsed=archiveSchema.safeParse(request.body);
    if(!parsed.success||!z.string().uuid().safeParse(request.params.orderId).success){response.status(400).json({message:'That archive request is invalid.'});return;}
    try {
      const result=await repository.archiveOrder(request.soloAccount!.workspaceId,request.params.orderId,parsed.data.archived);
      if(!result){response.status(404).json({message:'Order not found.'});return;}
      response.json(result);
    } catch(error){next(error);}
  });
  const itemVisibilitySchema=z.object({hidden:z.boolean()}).strict();
  router.patch('/orders/:orderId/items/:itemIndex/visibility',async(request,response,next)=>{
    const parsed=itemVisibilitySchema.safeParse(request.body), itemIndex=Number.parseInt(request.params.itemIndex,10);
    if(!parsed.success||!z.string().uuid().safeParse(request.params.orderId).success||!/^[0-9]+$/.test(request.params.itemIndex)||!Number.isSafeInteger(itemIndex)||itemIndex>49){response.status(400).json({message:'That item visibility request is invalid.'});return;}
    try {
      const result=await repository.hideOrderItem(request.soloAccount!.workspaceId,request.params.orderId,itemIndex,parsed.data.hidden);
      if(!result){response.status(404).json({message:'That order item was not found.'});return;}
      response.json(result);
    } catch(error){next(error);}
  });
  router.post('/tracking/refresh',async(request,response,next)=>{
    try {
      const tracker=coordinators(request.soloAccount!.workspaceId).tracking;
      void tracker.syncAll().catch(()=>console.warn('[solo-tracking] Refresh failed; will retry.'));
      response.status(202).json(tracker.summary);
    } catch(error){next(error);}
  });
  router.patch('/appearance',async(request,response,next)=>{
    const parsed=z.object({theme:z.enum(THEME_IDS),accentColor:z.string().regex(/^#[0-9a-fA-F]{6}$/)}).strict().safeParse(request.body);
    if (!parsed.success) {response.status(400).json({message:'Choose a valid theme.'});return;}
    try {await repository.updateWorkspaceSettings(request.soloAccount!.workspaceId,parsed.data);response.json({ok:true});}catch(error){next(error);}
  });
  // Never fall through into ACO routes or expose fees/invoice/customer-sharing APIs.
  router.use((_request,response)=>response.status(404).json({message:'Solo Buyer endpoint not found.'}));
  return router;
}
