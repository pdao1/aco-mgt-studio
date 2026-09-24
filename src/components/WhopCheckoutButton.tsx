import { useState } from 'react';
import { WhopCheckoutEmbed } from '@whop/checkout/react';
import { api } from '../lib/api';

export default function WhopCheckoutButton({product,label}:{product:'solo'|'aco';label:string}) {
  const [checkout,setCheckout]=useState<{sessionId:string;planId:string;returnUrl:string}|null>(null);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  async function startCheckout() {
    setBusy(true);setError('');
    try {setCheckout(await api.createWhopCheckout(product));}
    catch(caught) {setError(caught instanceof Error?caught.message:'Whop checkout could not be opened. Please try again.');}
    finally {setBusy(false);}
  }
  return <div className="whop-checkout-launch">
    <button className="whop-checkout-button" type="button" disabled={busy||Boolean(checkout)} aria-expanded={Boolean(checkout)} onClick={()=>void startCheckout()}>
      {busy?'Opening secure checkout…':label}
    </button>
    {error&&<p className="whop-checkout-error" role="alert">{error}</p>}
    {checkout&&<div className="whop-checkout-embed" aria-label={`${label} checkout`}>
      <button className="whop-checkout-close" type="button" onClick={()=>setCheckout(null)}>Close checkout</button>
      <WhopCheckoutEmbed sessionId={checkout.sessionId} returnUrl={checkout.returnUrl} theme="system" themeOptions={{accentColor:'#2165d2',borderRadius:8}} />
    </div>}
  </div>;
}
