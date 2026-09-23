import { useEffect, useState } from 'react';
import { ArrowRight, Boxes, CheckCircle2, Mail, ReceiptText, ShieldCheck, Sparkles } from 'lucide-react';
import { soloApi } from './solo/api';
import { identityApi } from './lib/identity';
import './products.css';

export default function MarketingSite() {
  const [checkingSession, setCheckingSession] = useState(window.location.pathname === '/');
  useEffect(() => {
    if (window.location.pathname !== '/') return;
    let active = true;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 5_000);
    void identityApi.session(controller.signal).then(async(session) => {
      if (!active) return;
      if (session.status==='linked') window.location.replace(session.path);
      else if(session.status==='unlinked') window.location.replace('/login');
      else if(!session.discordAvailable){
        const legacy=await soloApi.session(controller.signal);
        if(active&&legacy.authenticated)window.location.replace(legacy.path);
      }
    }).catch(() => {
      // Keep the public homepage available if the session check fails.
    }).finally(() => {
      window.clearTimeout(timeout);
      if (active) setCheckingSession(false);
    });
    return () => { active = false; window.clearTimeout(timeout); controller.abort(); };
  }, []);
  if (checkingSession) return <main className="loading-screen">Checking your sign-in…</main>;
  return (
    <main className="marketing-shell">
      <header className="marketing-header">
        <a className="marketing-brand" href="/"><span className="brand-mark"><Boxes size={19} /></span> Order Tracker Pro</a>
        <a className="marketing-login" href="/app/dashboard">Operator sign in <ArrowRight size={15} /></a>
      </header>
      <section className="marketing-hero">
        <span className="marketing-kicker"><Sparkles size={15} /> Two product offerings, one reliable data extraction engine.</span>
        <h1>Every order, tracked, for everyone.</h1>
        <p>Whether you&apos;re an individual shoppaholic wanting to track all of your orders in a single place or an ACO operation needing to manage their customers&apos; orders and handle their billing, Order Tracker Pro has the solution for you.</p>
      </section>
      <section className="product-offerings" aria-label="Login portals">
        <article>
          <span className="product-portal-label">Login portal</span>
          <h2>Individuals</h2>
          <p>Buy Pokémon online? Connect your own inboxes and follow all your purchases, items, and shipments in a private personal dashboard.</p>
          <a className="primary-action" href="/customer">Login Portal for Individuals <ArrowRight size={16}/></a>
        </article>
        <article>
          <span className="product-portal-label">Login portal</span>
          <h2>ACO Operations</h2>
          <p>Manage your customers, share a private order view with each of them, and invoice your service fees from your company workspace.</p>
          <a className="secondary-action" href="/app">Login Portal for ACOs <ArrowRight size={16}/></a>
        </article>
      </section>
      <h2 className="marketing-section-heading">Features</h2>
      <section className="marketing-grid" id="how-it-works">
        <article><Mail size={20} /><h2>Mailbox to dashboard</h2><p>Order confirmations and shipment updates from connected Gmail inboxes, organized automatically.</p></article>
        <article><CheckCircle2 size={20} /><h2>Order activity at a glance</h2><p>See completed, processing, cancelled, and in-transit orders without opening every account.</p></article>
        <article><ShieldCheck size={20} /><h2>Private by design</h2><p>Encrypted mailbox credentials and isolated accounts keep personal purchases and customer orders private.</p></article>
        <article><ReceiptText size={20} /><h2>Customer invoicing &amp; billing</h2><p>Create invoices from tracked orders, apply service fees, and monitor customer balances and payment status.</p></article>
      </section>
      <footer className="marketing-footer">Personal dashboards for Individuals · Company workspaces for ACO Operations</footer>
    </main>
  );
}
