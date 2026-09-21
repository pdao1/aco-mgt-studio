import { request } from './api';
export type IdentityState =
  | {status:'anonymous';discordAvailable:boolean;message?:string}
  | {status:'unlinked';discordAvailable:boolean;username:string;canContinue:boolean}
  | {status:'linked';discordAvailable:boolean;username:string;path:string};
export const identityApi={
  session:(signal?:AbortSignal)=>request<IdentityState>('/api/auth/session',{signal,cache:'no-store'}),
  link:(input:{product:'solo';serial:string}|{product:'aco';workspaceSlug:string;password:string})=>request<{path:string}>('/api/auth/link',{method:'POST',body:JSON.stringify(input)}),
  continue:()=>request<{path:string}>('/api/auth/continue',{method:'POST'}),
  logout:()=>request('/api/auth/signout',{method:'POST'}),
};
