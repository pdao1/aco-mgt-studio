import { ArrowRight, Boxes, CheckCircle2, Mail, ShieldCheck, Sparkles } from 'lucide-react';
import './products.css';

export default function MarketingSite() {
  return (
    <main className="marketing-shell">
      <header className="marketing-header">
        <a className="marketing-brand" href="/"><span className="brand-mark"><Boxes size={19} /></span> ACO Studio</a>
        <a className="marketing-login" href="/app/dashboard">Operator sign in <ArrowRight size={15} /></a>
      </header>
      <section className="marketing-hero">
        <span className="marketing-kicker"><Sparkles size={15} /> Two products. One reliable order engine.</span>
        <h1>Every order, all in one place.</h1>
        <p>Personal purchases or customer operations. Choose the order dashboard built for you.</p>
      </section>
      <section className="product-offerings" aria-label="Choose your product"><article><h2>For Solo Buyers</h2><p>Buy Pokémon online? Connect your own inboxes and follow all your purchases, items, and shipments in a private personal dashboard.</p><a className="primary-action" href="/customer">Track my orders <ArrowRight size={16}/></a></article><article><h2>For ACOs</h2><p>Manage your customers, share a private order view with each of them, and invoice your service fees from your company workspace.</p><a className="secondary-action" href="/app">Open ACO workspace <ArrowRight size={16}/></a></article></section>
      <section className="marketing-grid" id="how-it-works">
        <article><Mail size={20} /><h2>Mailbox to dashboard</h2><p>Order confirmations and shipment updates from connected Gmail inboxes, organized automatically.</p></article>
        <article><CheckCircle2 size={20} /><h2>Order activity at a glance</h2><p>See completed, processing, cancelled, and in-transit orders without opening every account.</p></article>
        <article><ShieldCheck size={20} /><h2>Private by design</h2><p>Encrypted mailbox credentials and isolated accounts keep personal purchases and customer orders private.</p></article>
      </section>
      <footer className="marketing-footer">Personal dashboards for Solo Buyers · Company workspaces for ACOs</footer>
    </main>
  );
}
