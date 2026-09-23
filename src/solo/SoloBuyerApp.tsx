import { useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent } from 'react';
import { Archive, Boxes, CheckCircle2, Eye, EyeOff, ExternalLink, Inbox, LogOut, Mail, Moon, Package, Plus, RefreshCw, Search, Settings, Sun, Trash2, Truck, X } from 'lucide-react';
import { ApiError } from '../lib/api';
import { formatDate, formatDateTime, formatMoney, relativeTime } from '../lib/format';
import { filterOrders, listRetailers, type OrderListStatusFilter } from '../lib/orders';
import { PRIMARY_PALETTES, WORKSPACE_THEMES } from '../lib/themes';
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
  const [filter,setFilter]=useState<OrderListStatusFilter>('all'),[selected,setSelected]=useState<string|null>(null),[showArchived,setShowArchived]=useState(false),[settingsOpen,setSettingsOpen]=useState(false);
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
    setSelected(null);setConnecting(false);setNotice('');setPage(0);setShowArchived(false);setSettingsOpen(false);
  },[data?.account.handle]);
  useEffect(()=>{
    if(!data||login)return;
    const timer=window.setInterval(()=>{if(!document.hidden)void refresh();},data.mailboxes.some(m=>m.syncStatus==='syncing')||data.tracking.running?5000:60000);
    return()=>window.clearInterval(timer);
  },[data?.mailboxes.some(m=>m.syncStatus==='syncing'),Boolean(data),data?.tracking.running,login]);
  useEffect(()=>{document.title=data?`${data.account.displayName} | Order Tracker Pro`:'Order Tracker Pro | Sign in';},[data?.account.displayName]);
  const scoped=useMemo(()=>data?.orders.filter(o=>!mailbox||o.customerId===mailbox)??[],[data,mailbox]);
  const activeScoped=useMemo(()=>scoped.filter(o=>!o.isArchived),[scoped]);
  const orderScope=useMemo(()=>scoped.filter(o=>showArchived||!o.isArchived),[scoped,showArchived]);
  const orders=useMemo(()=>filterOrders(orderScope,{status:filter,query,retailer}),[orderScope,filter,query,retailer]);
  const pageCount=Math.max(1,Math.ceil(orders.length/50));
  const currentPage=Math.min(page,pageCount-1);
  const visibleOrders=orders.slice(currentPage*50,(currentPage+1)*50);
  useEffect(()=>setPage(0),[mailbox,query,retailer,filter,showArchived]);
  const summary=useMemo(()=>summarizePurchases(activeScoped),[activeScoped]);
  const order=orders.find(o=>o.id===selected)??null;
  const act=async(task:()=>Promise<unknown>,message:string)=>{
    setBusy(true);setNotice('');setError('');
    try{await task();await refresh();setNotice(message);}catch(caught){setError(caught instanceof Error?caught.message:'Please try again.');}finally{setBusy(false);}
  };
  const logout=async()=>{
    ++requestSequence.current;setData(null);setLoading(true);
    try{await soloApi.logout();window.location.replace('/customer');}
    catch{await refresh();setError('Sign out failed. Please try again.');}
    finally{setLoading(false);}
  };
  const connect=async(input:ConnectCustomerInput)=>{await soloApi.connect(input);await refresh();setNotice('Inbox connected. Your first email sync is starting.');};
  const archiveOrder=async(item:SoloOrder)=>{await act(()=>soloApi.archiveOrder(item.id,!item.isArchived),item.isArchived?'Order restored to active calculations.':'Order archived from active calculations.');if(!item.isArchived)setSelected(null);};
  const hideItem=async(item:SoloOrder,index:number,hidden:boolean)=>{await act(()=>soloApi.hideOrderItem(item.id,index,hidden),hidden?'Item hidden from calculations and sent to parser feedback.':'Item restored to this order.');};
  if(loading)return <main className="loading-screen">Loading your orders…</main>;
  if(login)return <SoloLogin onSuccess={refresh}/>;
  if(!data)return <main className="loading-screen"><h1>Your orders are unavailable</h1><p>{error}</p><button className="primary-action" onClick={()=>void refresh()}>Try again</button></main>;
  return <div className="solo-shell" data-theme={data.appearance.theme} style={{'--blue':data.appearance.accentColor} as CSSProperties}>
    <header className="solo-header"><a className="solo-brand" href={`/customer/${data.account.handle}`}><Boxes size={24}/><span>{data.account.displayName}<small>Individual License</small></span></a><div className="solo-account"><span>@{data.account.handle}</span>{!data.account.discordLinked&&data.account.discordAvailable&&<><span className="discord-link-prompt">Link Discord account for login:</span><a className="solo-discord-link" href="/api/solo/auth/discord">Link Discord</a></>}<button aria-label="Sign out" title="Sign out" onClick={()=>void logout()}><LogOut size={18}/></button></div></header>
    <aside className="solo-mailboxes" aria-label="Your mailboxes"><button className="secondary-action solo-settings-trigger" onClick={()=>setSettingsOpen(true)}><Settings size={15}/> Settings</button><div className="solo-rail-heading"><h2>Your inboxes</h2><span>{data.mailboxes.length}/{data.account.mailboxLimit}</span></div>
      <button className={!mailbox?'solo-mailbox active':'solo-mailbox'} onClick={()=>{setMailbox('');setSelected(null);}}><Inbox size={18}/><span><strong>All inboxes</strong><small>{activeScoped.length} orders found</small></span></button>
      {data.mailboxes.map(item=><button key={item.id} className={mailbox===item.id?'solo-mailbox active':'solo-mailbox'} onClick={()=>{setMailbox(item.id);setSelected(null);}}><Mail size={17}/><span><strong>{item.name}</strong><small>{item.emailMasked}</small><small className={item.syncStatus==='error'?'solo-error-copy':''}>{item.syncStatus==='syncing'?'Syncing…':item.syncStatus==='error'?'Sync needs attention':`Synced ${relativeTime(item.lastSyncedAt)}`}</small></span></button>)}
      <button className="secondary-action solo-connect" disabled={data.mailboxes.length>=data.account.mailboxLimit} onClick={()=>setConnecting(true)}><Plus size={16}/> Connect inbox</button>
      <div className="solo-plan"><strong>Solo Buyer access</strong><span>Active through {formatDate(data.account.accessExpiresAt)}</span><p>Manage your inboxes, order history, and display preferences.</p></div>
    </aside>
    <main className="solo-main"><div className="solo-heading"><div><h1>Your orders</h1><p>Every purchase, one place. Keep up with your Pokémon orders and other online finds.</p></div><div className="solo-main-actions"><button className="secondary-action" disabled={busy||data.mailboxes.length===0} onClick={()=>void act(async()=>{for(const item of data.mailboxes.filter(m=>!mailbox||m.id===mailbox))await soloApi.sync(item.id);await soloApi.track();},'Sync started. Tracking will refresh when processing completes.')}><RefreshCw size={15} className={busy?'spin':''}/> Sync</button></div></div>
      {(error||notice)&&<p className={error?'solo-alert error':'solo-alert'} role={error?'alert':'status'}>{error||notice}</p>}
      {data.mailboxes.filter(m=>(!mailbox||m.id===mailbox)&&m.syncMessage).map(m=><p key={m.id} className="solo-alert error" role="alert"><strong>{m.name}: </strong>{m.syncMessage}</p>)}
      <section className="solo-summary" aria-label="Purchase summary"><Metric icon={<Package size={20}/>} label="Total orders" value={String(summary.count)}/><Metric label="Total spent" value={summary.totals.length?summary.totals.map(([currency,total])=>formatMoney(total,currency)).join(' · '):'—'} detail="Cancelled orders excluded"/><Metric icon={<CheckCircle2 size={20}/>} label="Stick rate" value={summary.stickRate===null?'—':`${summary.stickRate}%`} detail={`${summary.count-summary.cancelled} kept`}/><Metric label="Cancel rate" value={summary.cancelRate===null?'—':`${summary.cancelRate}%`} detail={`${summary.cancelled} total cancelled`}/></section>
      <section className="solo-orders" aria-label="Your order list"><div className="solo-filters"><label><Search size={16}/><input aria-label="Search orders" placeholder="Search order or tracking number" value={query} onChange={e=>setQuery(e.target.value)}/></label><select aria-label="Order status" value={filter} onChange={e=>setFilter(e.target.value as OrderListStatusFilter)}>{[['all','All statuses'],['pending','Pending'],['confirmed','Confirmed'],['processing','Processing'],['in-transit','In transit'],['delivered','Delivered'],['cancelled','Cancelled']].map(([value,label])=><option key={value} value={value}>{label}</option>)}</select><select aria-label="Retailer" value={retailer} onChange={e=>setRetailer(e.target.value)}><option value="">All retailers</option>{listRetailers(scoped).map(store=><option key={store}>{store}</option>)}</select><label className="solo-check"><input type="checkbox" checked={showArchived} onChange={e=>setShowArchived(e.target.checked)}/> Show archived</label></div>
        {data.mailboxes.length===0?<div className="solo-empty"><Mail size={32}/><h2>Start with your first inbox</h2><p>Connect a Gmail inbox with an app password. We’ll gather your order confirmations and shipment updates.</p><button className="primary-action" onClick={()=>setConnecting(true)}>Connect your inbox</button></div>:<><div className="solo-table-scroll"><table className="solo-table"><thead><tr><th>Store / order</th><th>Placed</th><th>Mailbox</th><th>Items</th><th>Purchase total</th><th>Status</th><th>Tracking</th><th>Order</th></tr></thead><tbody>{visibleOrders.map(item=><tr key={item.id} tabIndex={0} className={`${selected===item.id?'selected ':''}${item.isArchived?'archived':''}`} onClick={()=>setSelected(item.id)} onKeyDown={e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();setSelected(item.id);}}}><td><span className="solo-store"><StoreMark store={item.store}/><span><strong>{item.store}</strong><small>{item.orderNumber}{item.isArchived&&' · Archived'}</small></span></span></td><td>{formatDate(item.orderedAt)}</td><td>{data.mailboxes.find(m=>m.id===item.customerId)?.name}</td><td>{item.itemCount??'—'}</td><td>{formatMoney(item.totalCents,item.currency)}</td><td><span className={`status-label ${item.status}`}>{statusLabel(item.status)}</span></td><td>{item.trackingUrl?<a href={item.trackingUrl} target="_blank" rel="noreferrer" onClick={e=>e.stopPropagation()}>{item.carrier??'Track'} <ExternalLink size={12}/></a>:item.trackingNumber??(item.status==='cancelled'?'Not applicable':'Awaiting shipment')}{item.expectedDelivery&&<small className="solo-eta">Expected {formatDate(item.expectedDelivery)}</small>}</td><td><button className="solo-row-action" onClick={e=>{e.stopPropagation();void archiveOrder(item);}}>{item.isArchived?'Restore':'Archive'}</button></td></tr>)}</tbody></table></div>{orders.length===0&&<div className="solo-empty"><Package size={30}/><h2>No matching orders yet</h2><p>{data.mailboxes.some(m=>m.syncStatus==='syncing')?'Your email sync is running. This page updates automatically.':'Try a different filter or sync your inboxes.'}</p></div>}<footer className="solo-table-footer"><span>{orders.length?`${currentPage*50+1}–${Math.min((currentPage+1)*50,orders.length)} of ${orders.length} matching orders`:'0 matching orders'} · {activeScoped.length} active in {mailbox?'this inbox':'all inboxes'}</span>{pageCount>1&&<span className="solo-pages"><button className="secondary-action" disabled={currentPage===0} onClick={()=>setPage(currentPage-1)}>Previous</button><span>Page {currentPage+1} of {pageCount}</span><button className="secondary-action" disabled={currentPage+1===pageCount} onClick={()=>setPage(currentPage+1)}>Next</button></span>}</footer></>}
      </section>
      <footer className="solo-footer"><span>Gmail is read-only. App passwords are encrypted.</span><span>Order Tracker Pro · ordertracker.pro</span></footer>
    </main>
    {order&&<SoloOrderDetail order={order} busy={busy} onClose={()=>setSelected(null)} onArchive={()=>void archiveOrder(order)} onHideItem={(index,hidden)=>void hideItem(order,index,hidden)}/>}
    {settingsOpen&&<SoloSettings data={data} busy={busy} onClose={()=>setSettingsOpen(false)} onSaveAppearance={(input)=>void act(()=>soloApi.appearance(input),'Appearance saved.')} onRemoveMailbox={(id)=>{if(mailbox===id)setMailbox('');void act(()=>soloApi.removeMailbox(id),'Inbox removed.');}}/>}
    {connecting&&<ConnectCustomerDrawer mode="solo" onClose={()=>setConnecting(false)} onConnect={connect}/>}
  </div>;
}

function Metric({label,value,detail,icon}:{label:string;value:string;detail?:string;icon?:React.ReactNode}) {
  return <div className="solo-metric">{icon}<span><small>{label}</small><strong>{value}</strong>{detail&&<em>{detail}</em>}</span></div>;
}
function statusLabel(status:string){return status==='shipped'?'In transit':status.charAt(0).toUpperCase()+status.slice(1);}

function SoloOrderDetail({order,busy,onClose,onArchive,onHideItem}:{order:SoloOrder;busy:boolean;onClose:()=>void;onArchive:()=>void;onHideItem:(index:number,hidden:boolean)=>void}){
  const visibleItems=order.items.filter(item=>!item.hidden);
  const hiddenItems=order.items.filter(item=>item.hidden);
  return <div className="solo-detail-layer"><button className="drawer-scrim" onClick={onClose} aria-label="Close order detail"/><aside className="solo-detail" aria-label={`Order ${order.orderNumber}`}><header><h2>Order details</h2><button className="icon-button bare" onClick={onClose} aria-label="Close details"><X size={20}/></button></header><div className="solo-detail-store"><StoreMark store={order.store}/><div><h3>{order.store}</h3><p>{order.orderNumber}{order.isArchived?' · Archived':''}</p></div></div><div className="solo-detail-actions"><button className="secondary-action" disabled={busy} onClick={onArchive}>{order.isArchived?<><RefreshCw size={14}/> Restore order</>:<><Archive size={14}/> Archive order</>}</button></div><dl><div><dt>Placed</dt><dd>{formatDateTime(order.orderedAt)}</dd></div><div><dt>Purchase total</dt><dd>{formatMoney(order.totalCents,order.currency)}</dd></div><div><dt>Status</dt><dd><span className={`status-label ${order.status}`}>{statusLabel(order.status)}</span></dd></div>{order.expectedDelivery&&<div><dt>Expected delivery</dt><dd>{formatDate(order.expectedDelivery)}</dd></div>}</dl><h3>Items purchased</h3>{visibleItems.length?<ul className="solo-item-list">{order.items.map((item,i)=>item.hidden?null:<li key={i}><span><strong>{item.name}</strong><small>Qty {item.quantity}</small></span><span className="solo-item-controls"><b>{formatMoney(item.totalCents??(item.unitPriceCents===null?null:item.unitPriceCents*item.quantity),order.currency)}</b><button className="icon-button bare" disabled={busy} title="Hide incorrect item" aria-label={`Hide ${item.name}`} onClick={()=>onHideItem(i,true)}><EyeOff size={15}/></button></span></li>)}</ul>:<p className="solo-muted">All extracted items are hidden from your calculations.</p>}{hiddenItems.length>0&&<><h3>Hidden items</h3><ul className="solo-item-list hidden-items">{order.items.map((item,i)=>item.hidden?<li key={i}><span><strong>{item.name}</strong><small>Excluded from order calculations</small></span><button className="icon-button bare" disabled={busy} title="Restore item" aria-label={`Restore ${item.name}`} onClick={()=>onHideItem(i,false)}><Eye size={15}/></button></li>:null)}</ul><p className="solo-feedback-note">Your corrections help improve future parsing for matching generic email-template noise.</p></>}<h3>Order timeline</h3>{order.events.length?<ol className="solo-timeline">{order.events.map(event=><li key={event.id}><strong>{event.label}</strong><small>{formatDateTime(event.occurredAt)}</small><p>{event.detail}</p></li>)}</ol>:<p className="solo-muted">Updates will appear as emails and carrier scans arrive.</p>}{order.trackingNumber&&<div className="solo-tracking-detail"><strong>{order.carrier??'Tracking'}</strong><p>{order.trackingNumber}</p>{order.trackingUrl&&<a href={order.trackingUrl} target="_blank" rel="noreferrer">Open carrier tracking <ExternalLink size={14}/></a>}</div>}</aside></div>;
}

function SoloSettings({data,busy,onClose,onSaveAppearance,onRemoveMailbox}:{data:SoloDashboard;busy:boolean;onClose:()=>void;onSaveAppearance:(input:SoloDashboard['appearance'])=>void;onRemoveMailbox:(id:string)=>void}){
  const currentTheme=WORKSPACE_THEMES.find(theme=>theme.id===data.appearance.theme)??WORKSPACE_THEMES[0];
  const currentPalette=PRIMARY_PALETTES.find(palette=>palette.light.toLowerCase()===data.appearance.accentColor.toLowerCase()||palette.dark.toLowerCase()===data.appearance.accentColor.toLowerCase())??PRIMARY_PALETTES[0];
  const saveMode=(mode:'light'|'dark')=>{const theme=WORKSPACE_THEMES.find(candidate=>candidate.mode===mode&&candidate.id===(mode==='light'?'classic-light':'midnight-dark'))??currentTheme;onSaveAppearance({theme:theme.id,accentColor:mode==='dark'?currentPalette.dark:currentPalette.light});};
  const savePalette=(palette:typeof PRIMARY_PALETTES[number])=>onSaveAppearance({theme:data.appearance.theme,accentColor:currentTheme.mode==='dark'?palette.dark:palette.light});
  return <div className="solo-modal-layer"><button className="drawer-scrim" onClick={onClose} aria-label="Close settings"/><aside className="solo-settings" aria-label="Settings"><header><div><h2>Settings</h2><p>Manage your inboxes and dashboard appearance.</p></div><button className="icon-button bare" onClick={onClose} aria-label="Close settings"><X size={20}/></button></header><section><h3>Appearance</h3><div className="solo-mode-options" role="group" aria-label="Color mode"><button className={currentTheme.mode==='light'?'selected':''} disabled={busy} onClick={()=>saveMode('light')}><Sun size={16}/> Light</button><button className={currentTheme.mode==='dark'?'selected':''} disabled={busy} onClick={()=>saveMode('dark')}><Moon size={16}/> Dark</button></div><p className="solo-settings-label">Primary color</p><div className="solo-palette-options" role="group" aria-label="Primary color palette">{PRIMARY_PALETTES.map(palette=><button key={palette.id} className={currentPalette.id===palette.id?'selected':''} disabled={busy} onClick={()=>savePalette(palette)}><i style={{background:currentTheme.mode==='dark'?palette.dark:palette.light}}/><span>{palette.name}</span></button>)}</div></section><section><div className="solo-settings-section-heading"><div><h3>Connected inboxes</h3><p>{data.mailboxes.length} of {data.account.mailboxLimit} used · maximum 2 for Solo Buyers</p></div></div>{data.mailboxes.length===0?<p className="solo-muted">No inboxes connected.</p>:<ul className="solo-connected-list">{data.mailboxes.map(mailbox=><li key={mailbox.id}><span><strong>{mailbox.name}</strong><small>{mailbox.emailMasked}</small></span><button className="secondary-action" disabled={busy} onClick={()=>{if(window.confirm(`Remove ${mailbox.name}? Its stored mailbox credential and imported orders will be removed.`))onRemoveMailbox(mailbox.id);}}><Trash2 size={14}/> Remove</button></li>)}</ul>}</section><p className="solo-settings-footnote">Removing an inbox deletes its imported order history from this Solo Buyer account. This cannot be undone.</p></aside></div>;
}

function SoloLogin({onSuccess}:{onSuccess:()=>Promise<void>}){
  const [serial,setSerial]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false),[discord,setDiscord]=useState(false);
  useEffect(()=>{void soloApi.options().then(result=>setDiscord(result.discordAvailable)).catch(()=>setError('Sign-in options could not load. Try again.'));const reason=new URLSearchParams(window.location.search).get('error');if(reason)setError(reason==='solo-access-required'?'No active Solo Buyer plan is linked to this Discord account. Sign in with your product serial, then connect Discord.':reason==='discord-unavailable'?'Discord sign-in is not configured yet. Use your Solo Buyer serial.':'Discord sign-in failed or expired. Please try again.');},[]);
  const submit=async(event:FormEvent)=>{event.preventDefault();setBusy(true);setError('');try{const result=await soloApi.login(serial);setSerial('');window.history.replaceState(null,'',result.path);await onSuccess();}catch(caught){setError(caught instanceof Error?caught.message:'Sign in failed.');}finally{setBusy(false);}};
  return <main className="solo-login"><section><a className="solo-brand" href="/"><Boxes size={26}/><span>Order Tracker Pro<small>Personal order center</small></span></a><h1>All your orders.<br/>Just for you.</h1><p>Connect your inboxes. Follow your Pokémon purchases and every other online order, from confirmation to your door.</p>{discord?<a className="solo-discord" href="/api/solo/auth/discord">Continue with Discord</a>:<p className="solo-login-note">Discord sign-in will be available when the service connects its Discord app.</p>}<div className="solo-login-divider">or use your product serial</div><form onSubmit={submit}><label>Solo Buyer product serial<input type="password" autoComplete="off" value={serial} onChange={e=>setSerial(e.target.value)} placeholder="solo_…" required maxLength={150}/></label>{error&&<p className="form-error" role="alert">{error}</p>}<button className="primary-action" disabled={busy}>{busy?'Signing in…':'Open my orders'}</button></form><p className="solo-login-note">Your serial is private and gives access to your personal account. An active Solo Buyer plan is required.</p><a className="solo-aco-link" href="/app">Managing customer orders? Operator sign in <ExternalLink size={13}/></a></section></main>;
}
