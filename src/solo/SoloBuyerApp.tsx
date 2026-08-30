import { useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent } from 'react';
import { Boxes, CheckCircle2, ExternalLink, Inbox, LogOut, Mail, Package, Plus, RefreshCw, Search, Truck, X } from 'lucide-react';
import { ApiError } from '../lib/api';
import { formatDate, formatDateTime, formatMoney, relativeTime } from '../lib/format';
import { filterOrders, listRetailers, type OrderListStatusFilter } from '../lib/orders';
import { WORKSPACE_THEMES } from '../lib/themes';
import { ConnectCustomerDrawer } from '../components/ConnectCustomerDrawer';
import { StoreMark } from '../components/OrdersTable';
import type { ConnectCustomerInput } from '../types';
import { soloApi } from './api';
import type { SoloDashboard, SoloOrder } from './types';
import { summarizePurchases } from './order-summary';
import './solo.css';

export default function SoloBuyerApp() {
  const requestSequence=useRef(0);
  const [page,setPage]=useState(0);
  const [data,setData]=useState<SoloDashboard|null>(null);
  const [loading,setLoading]=useState(true),[login,setLogin]=useState(false),[error,setError]=useState('');
  const [mailbox,setMailbox]=useState(''),[query,setQuery]=useState(''),[retailer,setRetailer]=useState('');
  const [filter,setFilter]=useState<OrderListStatusFilter>('all'),[selected,setSelected]=useState<string|null>(null);
  const [connecting,setConnecting]=useState(false),[busy,setBusy]=useState(false),[notice,setNotice]=useState('');
  const refresh=async()=>{
    const sequence=++requestSequence.current;
    try {
      const payload=await soloApi.dashboard();if(sequence!==requestSequence.current)return;setData(payload);setLogin(false);setError('');
      const canonical=`/customer/${payload.account.handle}`;
      if(window.location.pathname!==canonical) window.history.replaceState(null,'',canonical);
    } catch(caught){if(sequence!==requestSequence.current)return;if(caught instanceof ApiError && caught.status===401){setLogin(true);setData(null);}else setError(caught instanceof Error?caught.message:'Your orders could not load.');}
    finally{if(sequence===requestSequence.current)setLoading(false);}
  };
  useEffect(()=>{void refresh();},[]);
  useEffect(()=>{
    setMailbox('');setQuery('');setRetailer('');setFilter('all');
    setSelected(null);setConnecting(false);setNotice('');setPage(0);
  },[data?.account.handle]);
  useEffect(()=>{
    if(!data||login)return;
    const timer=window.setInterval(()=>{if(!document.hidden)void refresh();},data.mailboxes.some(m=>m.syncStatus==='syncing')||data.tracking.running?5000:60000);
    return()=>window.clearInterval(timer);
  },[data?.mailboxes.some(m=>m.syncStatus==='syncing'),Boolean(data),data?.tracking.running,login]);
  useEffect(()=>{document.title=data?`${data.account.displayName} | Solo Buyer orders`:'Solo Buyers | Sign in';},[data?.account.displayName]);
  const scoped=useMemo(()=>data?.orders.filter(o=>!mailbox||o.customerId===mailbox)??[],[data,mailbox]);
  const orders=useMemo(()=>filterOrders(scoped,{status:filter,query,retailer}),[scoped,filter,query,retailer]);
  const pageCount=Math.max(1,Math.ceil(orders.length/50));
  const currentPage=Math.min(page,pageCount-1);
  const visibleOrders=orders.slice(currentPage*50,(currentPage+1)*50);
  useEffect(()=>setPage(0),[mailbox,query,retailer,filter]);
  const summary=useMemo(()=>summarizePurchases(scoped),[scoped]);
  const order=orders.find(o=>o.id===selected)??null;
  const act=async(task:()=>Promise<unknown>,message:string)=>{
    setBusy(true);setNotice('');setError('');
    try{await task();await refresh();setNotice(message);}catch(caught){setError(caught instanceof Error?caught.message:'Please try again.');}finally{setBusy(false);}
  };
  const logout=async()=>{
    ++requestSequence.current;setData(null);setLoading(true);
    try{await soloApi.logout();setLogin(true);window.history.replaceState(null,'','/customer');}
    catch{await refresh();setError('Sign out failed. Please try again.');}
    finally{setLoading(false);}
  };
  const connect=async(input:ConnectCustomerInput)=>{await soloApi.connect(input);await refresh();setNotice('Inbox connected. Your first email sync is starting.');};
  if(loading)return <main className="loading-screen">Loading your orders…</main>;
  if(login)return <SoloLogin onSuccess={refresh}/>;
  if(!data)return <main className="loading-screen"><h1>Your orders are unavailable</h1><p>{error}</p><button className="primary-action" onClick={()=>void refresh()}>Try again</button></main>;
  return <div className="solo-shell" data-theme={data.appearance.theme} style={{'--blue':data.appearance.accentColor} as CSSProperties}>
    <header className="solo-header"><a className="solo-brand" href={`/customer/${data.account.handle}`}><Boxes size={24}/><span>Solo Buyers<small>Your personal order center</small></span></a><div className="solo-account"><span>@{data.account.handle}</span>{!data.account.discordLinked&&data.account.discordAvailable&&<a href="/api/solo/auth/discord">Connect Discord</a>}<button aria-label="Sign out" title="Sign out" onClick={()=>void logout()}><LogOut size={18}/></button></div></header>
    <aside className="solo-mailboxes" aria-label="Your mailboxes"><div className="solo-rail-heading"><h2>Your inboxes</h2><span>{data.mailboxes.length}/{data.account.mailboxLimit}</span></div>
      <button className={!mailbox?'solo-mailbox active':'solo-mailbox'} onClick={()=>{setMailbox('');setSelected(null);}}><Inbox size={18}/><span><strong>All inboxes</strong><small>{data.orders.length} orders found</small></span></button>
      {data.mailboxes.map(item=><button key={item.id} className={mailbox===item.id?'solo-mailbox active':'solo-mailbox'} onClick={()=>{setMailbox(item.id);setSelected(null);}}><Mail size={17}/><span><strong>{item.name}</strong><small>{item.emailMasked}</small><small className={item.syncStatus==='error'?'solo-error-copy':''}>{item.syncStatus==='syncing'?'Syncing…':item.syncStatus==='error'?'Sync needs attention':`Synced ${relativeTime(item.lastSyncedAt)}`}</small></span></button>)}
      <button className="secondary-action solo-connect" disabled={data.mailboxes.length>=data.account.mailboxLimit} onClick={()=>setConnecting(true)}><Plus size={16}/> Connect inbox</button>
      <div className="solo-plan"><strong>Solo Buyer access</strong><span>Active through {formatDate(data.account.accessExpiresAt)}</span><p>Only you can access your inboxes and orders.</p></div>
    </aside>
    <main className="solo-main"><div className="solo-heading"><div><h1>Your orders</h1><p>Every purchase, one place. Keep up with your Pokémon orders and other online finds.</p></div><div className="solo-main-actions"><button className="secondary-action" disabled={busy||data.mailboxes.length===0} onClick={()=>void act(async()=>{for(const item of data.mailboxes.filter(m=>!mailbox||m.id===mailbox))await soloApi.sync(item.id);},'Email sync started. New orders will appear automatically.')}><RefreshCw size={15} className={busy?'spin':''}/> Sync emails</button><button className="primary-action" disabled={busy||!data.tracking.providers.some(p=>p.configured)} onClick={()=>void act(()=>soloApi.track(),'Tracking refresh requested. Status appears below.')}><Truck size={16}/> Refresh tracking</button></div></div>
      {(error||notice)&&<p className={error?'solo-alert error':'solo-alert'} role={error?'alert':'status'}>{error||notice}</p>}
      {data.mailboxes.filter(m=>(!mailbox||m.id===mailbox)&&m.syncMessage).map(m=><p key={m.id} className="solo-alert error" role="alert"><strong>{m.name}: </strong>{m.syncMessage}</p>)}
      <section className="solo-summary" aria-label="Purchase summary"><Metric icon={<Package size={20}/>} label="Orders found" value={String(summary.count)}/><Metric icon={<Truck size={20}/>} label="In transit" value={String(summary.inTransit)}/><Metric icon={<CheckCircle2 size={20}/>} label="Delivered" value={String(summary.delivered)}/><Metric label="Purchase total" value={summary.totals.length?summary.totals.map(([currency,total])=>formatMoney(total,currency)).join(' · '):'—'} detail={`Cancelled orders excluded${summary.unknownTotal?` · ${summary.unknownTotal} ${summary.unknownTotal===1?'total':'totals'} pending`:''}`}/></section>
      <section className="solo-tracking" aria-label="Carrier connections"><div>{data.tracking.providers.map(provider=><span key={provider.name}><i className={provider.configured?'connected':''}/>{provider.name}<small>{provider.configured?'Configured':'Not configured'}</small></span>)}</div><p>{data.tracking.environment==='sandbox'?'Sandbox carrier data — not live shipments. ':''}{data.tracking.running?'Checking carrier updates…':data.tracking.message||(!data.tracking.providers.some(p=>p.configured)?'Email shipment updates and carrier links are available.':data.tracking.lastCheckedAt?`Last carrier check ${relativeTime(data.tracking.lastCheckedAt)} · ${data.tracking.updated} updates`:'Carrier APIs ready. Refresh tracking for the latest updates.')}</p></section>
      <section className="solo-orders" aria-label="Your order list"><div className="solo-filters"><label><Search size={16}/><input aria-label="Search orders" placeholder="Search order or tracking number" value={query} onChange={e=>setQuery(e.target.value)}/></label><select aria-label="Order status" value={filter} onChange={e=>setFilter(e.target.value as OrderListStatusFilter)}>{[['all','All statuses'],['pending','Pending'],['confirmed','Confirmed'],['processing','Processing'],['in-transit','In transit'],['delivered','Delivered'],['cancelled','Cancelled']].map(([value,label])=><option key={value} value={value}>{label}</option>)}</select><select aria-label="Retailer" value={retailer} onChange={e=>setRetailer(e.target.value)}><option value="">All retailers</option>{listRetailers(scoped).map(store=><option key={store}>{store}</option>)}</select></div>
        {data.mailboxes.length===0?<div className="solo-empty"><Mail size={32}/><h2>Start with your first inbox</h2><p>Connect a Gmail inbox with an app password. We’ll gather your order confirmations and shipment updates.</p><button className="primary-action" onClick={()=>setConnecting(true)}>Connect your inbox</button></div>:<><div className="solo-table-scroll"><table className="solo-table"><thead><tr><th>Store / order</th><th>Placed</th><th>Mailbox</th><th>Items</th><th>Purchase total</th><th>Status</th><th>Tracking</th></tr></thead><tbody>{visibleOrders.map(item=><tr key={item.id} tabIndex={0} className={selected===item.id?'selected':''} onClick={()=>setSelected(item.id)} onKeyDown={e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();setSelected(item.id);}}}><td><span className="solo-store"><StoreMark store={item.store}/><span><strong>{item.store}</strong><small>{item.orderNumber}</small></span></span></td><td>{formatDate(item.orderedAt)}</td><td>{data.mailboxes.find(m=>m.id===item.customerId)?.name}</td><td>{item.itemCount??'—'}</td><td>{formatMoney(item.totalCents,item.currency)}</td><td><span className={`status-label ${item.status}`}>{statusLabel(item.status)}</span></td><td>{item.trackingUrl?<a href={item.trackingUrl} target="_blank" rel="noreferrer" onClick={e=>e.stopPropagation()}>{item.carrier??'Track'} <ExternalLink size={12}/></a>:item.trackingNumber??(item.status==='cancelled'?'Not applicable':'Awaiting shipment')}{item.expectedDelivery&&<small className="solo-eta">Expected {formatDate(item.expectedDelivery)}</small>}</td></tr>)}</tbody></table></div>{orders.length===0&&<div className="solo-empty"><Package size={30}/><h2>No matching orders yet</h2><p>{data.mailboxes.some(m=>m.syncStatus==='syncing')?'Your email sync is running. This page updates automatically.':'Try a different filter or sync your inboxes.'}</p></div>}<footer className="solo-table-footer"><span>{orders.length?`${currentPage*50+1}–${Math.min((currentPage+1)*50,orders.length)} of ${orders.length} matching orders`:'0 matching orders'} · {scoped.length} in {mailbox?'this inbox':'all inboxes'}</span>{pageCount>1&&<span className="solo-pages"><button className="secondary-action" disabled={currentPage===0} onClick={()=>setPage(currentPage-1)}>Previous</button><span>Page {currentPage+1} of {pageCount}</span><button className="secondary-action" disabled={currentPage+1===pageCount} onClick={()=>setPage(currentPage+1)}>Next</button></span>}</footer></>}
      </section>
      <footer className="solo-footer"><span>Gmail is read-only. App passwords are encrypted.</span><label>Appearance <select aria-label="Appearance" disabled={busy} value={data.appearance.theme} onChange={e=>{const theme=WORKSPACE_THEMES.find(t=>t.id===e.target.value)!;void act(()=>soloApi.appearance({theme:theme.id,accentColor:theme.accent}),'Appearance saved.');}}>{WORKSPACE_THEMES.map(t=><option key={t.id} value={t.id}>{t.name} · {t.mode}</option>)}</select></label></footer>
    </main>
    {order&&<SoloOrderDetail order={order} onClose={()=>setSelected(null)}/>}
    {connecting&&<ConnectCustomerDrawer mode="solo" onClose={()=>setConnecting(false)} onConnect={connect}/>}
  </div>;
}

function Metric({label,value,detail,icon}:{label:string;value:string;detail?:string;icon?:React.ReactNode}) {
  return <div className="solo-metric">{icon}<span><small>{label}</small><strong>{value}</strong>{detail&&<em>{detail}</em>}</span></div>;
}
function statusLabel(status:string){return status==='shipped'?'In transit':status.charAt(0).toUpperCase()+status.slice(1);}

function SoloOrderDetail({order,onClose}:{order:SoloOrder;onClose:()=>void}){
  return <div className="solo-detail-layer"><button className="drawer-scrim" onClick={onClose} aria-label="Close order detail"/><aside className="solo-detail" aria-label={`Order ${order.orderNumber}`}><header><h2>Order details</h2><button className="icon-button bare" onClick={onClose} aria-label="Close details"><X size={20}/></button></header><div className="solo-detail-store"><StoreMark store={order.store}/><div><h3>{order.store}</h3><p>{order.orderNumber}</p></div></div><dl><div><dt>Placed</dt><dd>{formatDateTime(order.orderedAt)}</dd></div><div><dt>Purchase total</dt><dd>{formatMoney(order.totalCents,order.currency)}</dd></div><div><dt>Status</dt><dd><span className={`status-label ${order.status}`}>{statusLabel(order.status)}</span></dd></div>{order.expectedDelivery&&<div><dt>Expected delivery</dt><dd>{formatDate(order.expectedDelivery)}</dd></div>}</dl><h3>Items purchased</h3>{order.items.length?<ul className="solo-item-list">{order.items.map((item,i)=><li key={i}><span><strong>{item.name}</strong><small>Qty {item.quantity}</small></span><b>{formatMoney(item.totalCents??(item.unitPriceCents===null?null:item.unitPriceCents*item.quantity),order.currency)}</b></li>)}</ul>:<p className="solo-muted">The retailer hasn’t supplied item details yet.</p>}<h3>Order timeline</h3>{order.events.length?<ol className="solo-timeline">{order.events.map(event=><li key={event.id}><strong>{event.label}</strong><small>{formatDateTime(event.occurredAt)}</small><p>{event.detail}</p></li>)}</ol>:<p className="solo-muted">Updates will appear as emails and carrier scans arrive.</p>}{order.trackingNumber&&<div className="solo-tracking-detail"><strong>{order.carrier??'Tracking'}</strong><p>{order.trackingNumber}</p>{order.trackingUrl&&<a href={order.trackingUrl} target="_blank" rel="noreferrer">Open carrier tracking <ExternalLink size={14}/></a>}</div>}</aside></div>;
}

function SoloLogin({onSuccess}:{onSuccess:()=>Promise<void>}){
  const [serial,setSerial]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false),[discord,setDiscord]=useState(false);
  useEffect(()=>{void soloApi.options().then(result=>setDiscord(result.discordAvailable)).catch(()=>setError('Sign-in options could not load. Try again.'));const reason=new URLSearchParams(window.location.search).get('error');if(reason)setError(reason==='solo-access-required'?'No active Solo Buyer plan is linked to this Discord account. Sign in with your product serial, then connect Discord.':reason==='discord-unavailable'?'Discord sign-in is not configured yet. Use your Solo Buyer serial.':'Discord sign-in failed or expired. Please try again.');},[]);
  const submit=async(event:FormEvent)=>{event.preventDefault();setBusy(true);setError('');try{const result=await soloApi.login(serial);setSerial('');window.history.replaceState(null,'',result.path);await onSuccess();}catch(caught){setError(caught instanceof Error?caught.message:'Sign in failed.');}finally{setBusy(false);}};
  return <main className="solo-login"><section><a className="solo-brand" href="/"><Boxes size={26}/><span>Solo Buyers<small>Your personal order center</small></span></a><h1>All your orders.<br/>Just for you.</h1><p>Connect your inboxes. Follow your Pokémon purchases and every other online order, from confirmation to your door.</p>{discord?<a className="solo-discord" href="/api/solo/auth/discord">Continue with Discord</a>:<p className="solo-login-note">Discord sign-in will be available when the service connects its Discord app.</p>}<div className="solo-login-divider">or use your product serial</div><form onSubmit={submit}><label>Solo Buyer product serial<input type="password" autoComplete="off" value={serial} onChange={e=>setSerial(e.target.value)} placeholder="solo_…" required maxLength={150}/></label>{error&&<p className="form-error" role="alert">{error}</p>}<button className="primary-action" disabled={busy}>{busy?'Signing in…':'Open my orders'}</button></form><p className="solo-login-note">Your serial is private and gives access to your personal account. An active Solo Buyer plan is required.</p><a className="solo-aco-link" href="/app">Managing orders for clients? ACO sign in <ExternalLink size={13}/></a></section></main>;
}
