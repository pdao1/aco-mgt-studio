import { randomBytes } from 'node:crypto';
import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import type { AppConfig } from '../config.js';
import type { Repository } from '../database/repository.js';
import { exchangeDiscordCode, type DiscordIdentity } from '../solo/discord.js';
import { clearSoloSession, issueSoloSession, readValue, signValue, SOLO_COOKIE, type SoloSession } from '../solo/session.js';
import { SoloRepository } from '../solo/repository.js';
import { clearSession, issueSession, loginRateLimit } from '../security/session.js';
import { issueServiceAccess } from '../security/access.js';
import { IdentityRepository, LinkError, type LinkedService } from './repository.js';

export const DISCORD_COOKIE = 'discord_session';
const STATE_COOKIE = 'discord_login_state';
const DURATION = 30 * 86400000;
interface IdentitySession { discordId:string; username:string; workspaceId:string|null; version:number|null; expiresAt:number }
const sessionSchema = z.object({discordId:z.string().regex(/^\d{17,20}$/),username:z.string().max(100),workspaceId:z.string().uuid().nullable(),version:z.number().int().nonnegative().nullable(),expiresAt:z.number().finite()});
export function readDiscordSession(request: Request, secret: string): IdentitySession | null {
  const parsed = sessionSchema.safeParse(readValue(request.cookies?.[DISCORD_COOKIE], 'discord-session', secret));
  return parsed.success ? parsed.data : null;
}
export function clearDiscordSession(response: Response, secure: boolean) {
  response.clearCookie(DISCORD_COOKIE,{httpOnly:true,secure,sameSite:'strict',path:'/'});
}

export function createDiscordAuth(config: AppConfig, core: Repository) {
  const router = Router(), accounts = new IdentityRepository(core), soloAccounts = new SoloRepository(core), limiter = loginRateLimit();
  const enabled = Boolean(config.discordClientId && config.discordClientSecret), secure = config.nodeEnv === 'production';
  function issue(response: Response, identity: DiscordIdentity, service: LinkedService | null) {
    const duration = service ? Math.min(DURATION,service.solo ? Date.parse(service.solo.accessExpiresAt)-Date.now() : DURATION) : 15*60000;
    const claims:IdentitySession={discordId:identity.id,username:identity.username,workspaceId:service?.workspaceId??null,version:service?.version??null,expiresAt:Date.now()+duration};
    clearSession(response,secure); clearSoloSession(response,secure);
    response.cookie(DISCORD_COOKIE,signValue(claims,'discord-session',config.sessionSecret),{httpOnly:true,secure,sameSite:'strict',path:'/',maxAge:duration});
    if (service?.solo) issueSoloSession(response,service.solo.id,service.version,config.sessionSecret,secure,service.solo.accessExpiresAt);
    else if (service) {
      issueServiceAccess(response,config.serviceSerial,config.sessionSecret,secure);
      issueSession(response,service.workspaceId,config.sessionSecret,secure,service.version,DURATION);
    }
  }
  async function authenticatedService(request:Request) {
    const identity=readDiscordSession(request,config.sessionSecret);
    if (!identity?.workspaceId) return null;
    const service=await accounts.resolve(identity.discordId,identity.workspaceId);
    return service && service.version===identity.version ? service : null;
  }
  async function authenticatedLegacySolo(request:Request) {
    const session=readValue<SoloSession>(request.cookies?.[SOLO_COOKIE],'solo-session',config.sessionSecret);
    if(!session) return null;
    const account=await soloAccounts.byId(session.accountId);
    return account && account.sessionVersion===session.version ? account : null;
  }
  const begin = (request:Request,response:Response) => {
    if (!enabled) {response.redirect('/login?error=discord-unavailable');return;}
    const state={nonce:randomBytes(32).toString('base64url'),expiresAt:Date.now()+10*60000};
    response.cookie(STATE_COOKIE,signValue(state,'discord-login-state',config.sessionSecret),{httpOnly:true,secure,sameSite:'lax',path:'/',maxAge:10*60000});
    const url=new URL('https://discord.com/oauth2/authorize');
    url.search=new URLSearchParams({client_id:config.discordClientId!,response_type:'code',scope:'identify',redirect_uri:config.discordRedirectUri,state:state.nonce}).toString();
    response.redirect(url.toString());
  };
  const callback = async(request:Request,response:Response) => {
    const state=readValue<{nonce:string;expiresAt:number}>(request.cookies?.[STATE_COOKIE],'discord-login-state',config.sessionSecret);
    response.clearCookie(STATE_COOKIE,{httpOnly:true,secure,sameSite:'lax',path:'/'});
    response.setHeader('Cache-Control','private, no-store');
    if (!enabled || !state || request.query.state!==state.nonce || typeof request.query.code!=='string') {response.redirect('/login?error=discord-failed');return;}
    try {
      const identity=await exchangeDiscordCode(request.query.code,config.discordClientId!,config.discordClientSecret!,config.discordRedirectUri);
      let service=await accounts.resolve(identity.id);
      const legacySolo=await authenticatedLegacySolo(request);
      if(legacySolo && (!service || service.product==='aco')) {
        await accounts.linkExistingSolo(identity,legacySolo.workspaceId);
        service=await accounts.resolve(identity.id,legacySolo.workspaceId);
      }
      issue(response,identity,service);
      response.redirect(service?.path??'/login');
    } catch {response.redirect('/login?error=discord-failed');}
  };
  router.use((_request,response,next)=>{response.setHeader('Cache-Control','private, no-store');next();});
  router.get('/discord',limiter,begin);
  router.get('/session',async(request,response,next)=>{
    try {
      const identity=readDiscordSession(request,config.sessionSecret);
      if (!identity) {response.json({status:'anonymous',discordAvailable:enabled});return;}
      const service=await authenticatedService(request);
      if (service) {response.json({status:'linked',discordAvailable:enabled,username:identity.username,path:service.path});return;}
      if (identity.workspaceId) {clearDiscordSession(response,secure);response.json({status:'anonymous',discordAvailable:enabled,message:'Your session expired or service access changed. Sign in again.'});return;}
      const provisioned=await accounts.resolve(identity.discordId);
      response.json({status:'unlinked',discordAvailable:enabled,username:identity.username,canContinue:Boolean(provisioned)});
    } catch(error){next(error);}
  });
  router.post('/continue',limiter,async(request,response,next)=>{
    try {
      const identity=readDiscordSession(request,config.sessionSecret);
      if (!identity || identity.workspaceId) {response.status(401).json({message:'Sign in with Discord again.'});return;}
      const service=await accounts.resolve(identity.discordId);
      if (!service) {response.status(409).json({message:'No active service is linked yet. Link your existing service or wait for your purchase to activate.'});return;}
      issue(response,{id:identity.discordId,username:identity.username},service);response.json({path:service.path});
    } catch(error){next(error);}
  });
  const linkSchema=z.discriminatedUnion('product',[
    z.object({product:z.literal('solo'),serial:z.string().trim().min(20).max(150)}).strict(),
    z.object({product:z.literal('aco'),workspaceSlug:z.string().trim().toLowerCase().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(80),password:z.string().min(1).max(512)}).strict(),
  ]);
  router.post('/link',limiter,async(request,response,next)=>{
    const identity=readDiscordSession(request,config.sessionSecret), parsed=linkSchema.safeParse(request.body);
    if (!identity) {response.status(401).json({message:'Sign in with Discord before linking a service.'});return;}
    if (!parsed.success) {response.status(400).json({message:'Enter your Solo serial or ACO workspace ID and password.'});return;}
    try {
      if(identity.workspaceId && !await authenticatedService(request)){response.status(401).json({message:'Sign in with Discord again before linking a service.'});return;}
      const discord={id:identity.discordId,username:identity.username};
      if (parsed.data.product==='solo') await accounts.linkSolo(discord,parsed.data.serial);
      else await accounts.linkWorkspace(discord,parsed.data.workspaceSlug,parsed.data.password);
      const service=await accounts.resolve(identity.discordId);
      if (!service) throw new LinkError('Service access is no longer active. Contact the service owner.');
      issue(response,discord,service);response.json({path:service.path});
    } catch(error){
      if(error instanceof LinkError || (error && typeof error==='object' && 'code' in error && error.code==='23505')) {response.status(409).json({message:error instanceof LinkError?error.message:'That service or Discord account is already linked.'});return;}
      next(error);
    }
  });
  router.post('/signout',(_request,response)=>{clearDiscordSession(response,secure);clearSession(response,secure);clearSoloSession(response,secure);response.json({ok:true});});
  function requireProduct(product:'solo'|'aco') {
    return async(request:Request,response:Response,next:NextFunction)=>{
      if(!enabled){next();return;}
      try {
        const service=await authenticatedService(request);
        if(!service||service.product!==product){
          if(product==='solo' && await authenticatedLegacySolo(request)){next();return;}
          response.status(401).json({message:'Sign in with Discord and link the correct service.',error:'DISCORD_AUTH_REQUIRED'});return;
        }
        request.discordWorkspaceId=service.workspaceId;
        next();
      } catch(error){next(error);}
    };
  }
  return {router,callback,begin,enabled,requireProduct};
}
declare global { namespace Express { interface Request { discordWorkspaceId?:string } } }
