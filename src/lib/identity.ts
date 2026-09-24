import { request } from './api';
export type IdentityState =
  | {status:'license-verified';product:'solo'|'aco';discordAvailable:boolean}
  | {status:'anonymous';discordAvailable:boolean;message?:string}
  | {status:'unlinked';discordAvailable:boolean;username:string;canContinue:boolean}
  | {status:'linked';discordAvailable:boolean;username:string;path:string};
export const identityApi={
  session:(signal?:AbortSignal)=>request<IdentityState>('/api/auth/session',{signal,cache:'no-store'}),
  license:(input:{product:'solo'|'aco';serial:string})=>request<{path:string}>('/api/auth/license',{method:'POST',body:JSON.stringify(input)}),
  link:(input:{product:'solo'|'aco';serial:string})=>request<{path:string}>('/api/auth/link',{method:'POST',body:JSON.stringify(input)}),
  continue:()=>request<{path:string}>('/api/auth/continue',{method:'POST'}),
  logout:()=>request('/api/auth/signout',{method:'POST'}),
};
