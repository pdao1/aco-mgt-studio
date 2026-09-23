import { request } from '../lib/api';
import type { ConnectCustomerInput } from '../types';
import type { SoloDashboard, TrackingSummary } from './types';
export const soloApi = {
  session:(signal?:AbortSignal)=>request<{authenticated:false}|{authenticated:true;path:string}>('/api/solo/auth/session',{signal,cache:'no-store'}),
  options:()=>request<{discordAvailable:boolean}>('/api/solo/auth/options'),
  login:(serial:string)=>request<{path:string}>('/api/solo/auth/serial',{method:'POST',body:JSON.stringify({serial})}),
  logout:()=>request('/api/solo/auth/logout',{method:'POST'}),
  dashboard:()=>request<SoloDashboard>('/api/solo/dashboard'),
  connect:(input:ConnectCustomerInput)=>request('/api/solo/mailboxes',{method:'POST',body:JSON.stringify(input)}),
  sync:(id:string)=>request(`/api/solo/mailboxes/${id}/sync`,{method:'POST'}),
  removeMailbox:(id:string)=>request(`/api/solo/mailboxes/${id}`,{method:'DELETE'}),
  track:()=>request<TrackingSummary>('/api/solo/tracking/refresh',{method:'POST'}),
  archiveOrder:(id:string,archived:boolean)=>request(`/api/solo/orders/${id}/archive`,{method:'PATCH',body:JSON.stringify({archived})}),
  hideOrderItem:(orderId:string,itemIndex:number,hidden:boolean)=>request(`/api/solo/orders/${orderId}/items/${itemIndex}/visibility`,{method:'PATCH',body:JSON.stringify({hidden})}),
  appearance:(input:SoloDashboard['appearance'])=>request('/api/solo/appearance',{method:'PATCH',body:JSON.stringify(input)}),
};
