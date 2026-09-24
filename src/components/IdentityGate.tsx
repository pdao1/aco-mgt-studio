import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Boxes } from 'lucide-react';
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
  if(children&&product==='solo')return <>{children}</>;
  if(state.status==='linked'&&children)return <>{children}</>;
  return <IdentityLogin state={state} initialProduct={product}/>;
}

function IdentityLogin({state,initialProduct}:{state:IdentityState;initialProduct?:'solo'|'aco'}) {
  const [product,setProduct]=useState<'solo'|'aco'>(initialProduct??(new URLSearchParams(window.location.search).get('product')==='aco'?'aco':'solo'));
  const [serial,setSerial]=useState('');
  const [busy,setBusy]=useState(false),[error,setError]=useState(()=>{
    const reason=new URLSearchParams(window.location.search).get('error');
    return reason==='discord-unavailable'?'Discord sign-in has not been configured yet.':reason?'Discord sign-in failed or expired. Please try again.':state.status==='anonymous'?state.message??'':'';
  });
  const linkedIdentity=state.status==='unlinked';
  const verified=state.status==='license-verified';
  async function submit(event:FormEvent) {
    event.preventDefault();setBusy(true);setError('');
    try {
      const result=await (linkedIdentity?identityApi.link({product,serial}):identityApi.license({product,serial}));
      setSerial('');window.location.replace(result.path);
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
    <div className="identity-steps"><span className={!verified?'current':''}>1 · License key</span><span className={verified?'current':''}>2 · Link Discord</span></div>
    <h1>{verified?'License verified':product==='aco'?'ACO login portal':'Individual login portal'}</h1>
    <p>{verified?'Link your Discord account to finish setup. Next time, Discord will take you directly to your dashboard.':linkedIdentity?`Signed in as @${state.username}. Enter the license key for your service.`:'Enter the license key from your Whop purchase. No workspace name or password is needed.'}</p>
    {verified?<>
      <p>{state.product==='aco'?'ACO License':'Individual License'} · Ready to link</p>
      <a className="identity-discord" href="/api/auth/discord">Link Discord account for login</a>
      <button className="identity-switch" disabled={busy} onClick={()=>void logout()}>Use another license key</button>
    </>:<>
      <div className="identity-products" aria-label="Service type"><button type="button" aria-pressed={product==='solo'} disabled={busy} onClick={()=>{setProduct('solo');setError('');}}>Individuals</button><button type="button" aria-pressed={product==='aco'} disabled={busy} onClick={()=>{setProduct('aco');setError('');}}>ACO Operations</button></div>
      <form onSubmit={submit}>
        <label>{product==='aco'?'ACO':'Individual'} license key<input autoComplete="off" type="password" value={serial} onChange={event=>setSerial(event.target.value)} placeholder="License key from Whop" required minLength={8} maxLength={256}/></label>
        <button className="primary-action" disabled={busy}>{busy?'Verifying…':linkedIdentity?'Link license':'Verify license key'}</button>
      </form>
      {linkedIdentity?<>
        {state.canContinue&&<button className="secondary-action" disabled={busy} onClick={()=>void continuePurchase()}>Open my dashboard</button>}
        <button className="identity-switch" disabled={busy} onClick={()=>void logout()}>Use a different Discord account</button>
      </>:state.discordAvailable?<><div className="identity-divider">Already linked your license?</div><a className="identity-discord" href="/api/auth/discord">Continue with Discord</a></>:<p className="form-error">Discord sign-in is not configured. Contact the service owner.</p>}
    </>}
    {error&&<p className="form-error" role="alert">{error}</p>}
    <p className="identity-note">Discord verifies who you are. Your service or Whop membership determines access.</p>
  </section></main>;
}
