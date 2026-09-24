import { ArrowRight, Boxes } from 'lucide-react';

export default function CheckoutComplete() {
  const params=new URLSearchParams(window.location.search);
  const status=params.get('status');
  const product=params.get('product')==='aco'?'aco':'solo';
  const failed=status==='error';
  const productName=product==='aco'?'ACO Operations':'Individuals';
  return <main className="checkout-complete">
    <a href="/" className="identity-brand"><Boxes size={23}/> Order Tracker Pro</a>
    <section className="checkout-complete-panel">
      <h1>{failed?'Checkout wasn’t completed':'Thanks for your order'}</h1>
      <p>{failed?'No payment was completed. You can return to the product page and try again.':'Your payment is being confirmed by Whop. After Whop issues the product license key, use it to activate your '+productName+' access and link Discord.'}</p>
      <a className="primary-action" href={failed?'/':`/login?product=${product}`}>{failed?'Return to products':`Continue to ${productName} login`} <ArrowRight size={16}/></a>
    </section>
  </main>;
}
