import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Boxes, ShieldCheck } from 'lucide-react';
import { identityApi, type IdentityState } from '../lib/identity';
import './identity.css';

export default function IdentityGate({children,product}:{children?:ReactNode;product?:'solo'|'aco'}) {
  const [state,setState]=useState<IdentityState|null>(null);
  const [error,setError]=useState('');
  const [attempt,setAttempt]=useState(0);
  useEffect(()=>{
    let active=true;const controller=new AbortController();
    const timeout=window.setTimeout(()=>controller.abort(),10000);
    void identityApi.session(controller.signal).then(result=>{
      if(!active)return;
      if(result.status==='linked') {
        const correctProduct=product==='solo'?result.path.startsWith('/customer/'):product==='aco'?result.path.startsWith('/app/'):false;
        const wrongWorkspace=product==='aco'&&window.location.pathname.startsWith('/app/workspaces/')&&window.location.pathname!==result.path;
        if(!correctProduct||wrongWorkspace||['/app','/app/dashboard','/customer'].includes(window.location.pathname)){window.location.replace(result.path);return;}
      }
      setState(result);
    }).catch(()=>{if(active)setError('Sign-in could not load. Please try again.');}).finally(()=>window.clearTimeout(timeout));
    return()=>{active=false;controller.abort();window.clearTimeout(timeout);};
  },[product,attempt]);
  if(error)return <main className="loading-screen"><p role="alert">{error}</p><button className="primary-action" onClick={()=>{setError('');setAttempt(value=>value+1);}}>Try again</button></main>;
  if(!state)return <main className="loading-screen">Checking your sign-in…</main>;
  // Keep the serial-first Solo flow available so an existing buyer can link
  // Discord from the authenticated dashboard afterward.
  if(children&&(product==='solo'||!state.discordAvailable))return <>{children}</>;
  if(state.status==='linked'&&children)return <>{children}</>;
  return <IdentityLogin state={state}/>;
}

function IdentityLogin({state}:{state:IdentityState}) {
  const [product,setProduct]=useState<'solo'|'aco'>('solo');
  const [serial,setSerial]=useState(''),[workspaceSlug,setWorkspaceSlug]=useState(''),[password,setPassword]=useState('');
  const [busy,setBusy]=useState(false),[error,setError]=useState(()=>{
    const reason=new URLSearchParams(window.location.search).get('error');
    return reason==='discord-unavailable'?'Discord sign-in has not been configured yet.':reason?'Discord sign-in failed or expired. Please try again.':state.status==='anonymous'?state.message??'':'';
  });
  const linkedIdentity=state.status==='unlinked';
  async function submit(event:FormEvent) {
    event.preventDefault();setBusy(true);setError('');
    try {
      const result=await identityApi.link(product==='solo'?{product,serial}:{product,workspaceSlug,password});
      setSerial('');setPassword('');window.location.replace(result.path);
    }catch(caught){setError(caught instanceof Error?caught.message:'Your service could not be linked.');setBusy(false);}
  }
  async function continuePurchase() {
    setBusy(true);setError('');
    try {const result=await identityApi.continue();window.location.replace(result.path);}
    catch(caught){setError(caught instanceof Error?caught.message:'Your purchase could not be checked.');setBusy(false);}
  }
  async function logout() {
    setBusy(true);setError('');
    try {await identityApi.logout();window.location.replace('/login');}
    catch {setError('Sign out failed. Please try again.');setBusy(false);}
  }
  return <main className="identity-screen"><section className="identity-panel">
    <a href="/" className="identity-brand"><Boxes size={23}/> Order Tracker Pro</a>
    <div className="identity-steps"><span className={!linkedIdentity?'current':''}>1 · Discord</span><span className={linkedIdentity?'current':''}>2 · Your service</span></div>
    <h1>{linkedIdentity?'Connect your service':'Welcome back.'}</h1>
    <p>{linkedIdentity?`Signed in as @${state.username}. Link your existing service once, or continue after your Whop purchase.`:'Sign in with Discord to open your personal orders or ACO workspace.'}</p>
    {!linkedIdentity ? <>
      {state.discordAvailable?<a className="identity-discord" href="/api/auth/discord">Continue with Discord</a>:<p className="form-error">Discord sign-in is not configured. Contact the service owner.</p>}
      <p className="identity-note">On your first visit, you’ll connect a Solo Buyer serial or your ACO workspace. We’ll remember this browser for up to 30 days.</p>
    </> : <>
      <div className="identity-purchase"><ShieldCheck size={20}/><div><strong>{state.canContinue?'Your service is ready':'Purchased through Whop?'}</strong><p>Use the same Discord account linked in Whop. Activation may take a moment.</p></div></div>
      <button className="primary-action" disabled={busy} onClick={()=>void continuePurchase()}>{state.canContinue?'Open my dashboard':'Check purchase access'}</button>
      <div className="identity-divider">or link an existing service</div>
      <div className="identity-products" aria-label="Service type"><button type="button" aria-pressed={product==='solo'} disabled={busy} onClick={()=>{setProduct('solo');setError('');}}>Solo Buyer</button><button type="button" aria-pressed={product==='aco'} disabled={busy} onClick={()=>{setProduct('aco');setError('');}}>ACO workspace</button></div>
      <form onSubmit={submit}>
        {product==='solo'?<label>Product serial<input autoComplete="off" type="password" value={serial} onChange={event=>setSerial(event.target.value)} placeholder="solo_…" required minLength={20} maxLength={150}/></label>:<>
          <label>Workspace ID<input autoComplete="username" value={workspaceSlug} onChange={event=>setWorkspaceSlug(event.target.value.toLowerCase())} placeholder="your-company" required maxLength={80}/></label>
          <label>Workspace password<input autoComplete="current-password" type="password" value={password} onChange={event=>setPassword(event.target.value)} required maxLength={512}/></label>
        </>}
        <button className="primary-action" disabled={busy}>{busy?'Please wait…':`Link ${product==='solo'?'Solo Buyer':'workspace'}`}</button>
      </form>
      <button className="identity-switch" disabled={busy} onClick={()=>void logout()}>Use a different Discord account</button>
    </>}
    {error&&<p className="form-error" role="alert">{error}</p>}
    <p className="identity-note">Discord verifies who you are. Your service or Whop membership determines access.</p>
  </section></main>;
}
