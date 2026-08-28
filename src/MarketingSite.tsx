import { ArrowRight, Boxes, CheckCircle2, Mail, ShieldCheck, Sparkles } from 'lucide-react';

export default function MarketingSite() {
  return (
    <main className="marketing-shell">
      <header className="marketing-header">
        <a className="marketing-brand" href="/"><span className="brand-mark"><Boxes size={19} /></span> ACO Studio</a>
        <a className="marketing-login" href="/app/dashboard">Operator sign in <ArrowRight size={15} /></a>
      </header>
      <section className="marketing-hero">
        <span className="marketing-kicker"><Sparkles size={15} /> Order operations for ACO teams</span>
        <h1>One clear view of every customer order.</h1>
        <p>Connect customer Gmail inboxes, track retailer shipments, and bill service fees without asking customers to hand over their purchase cards.</p>
        <div className="marketing-actions"><a className="primary-action" href="/app/dashboard">Open your workspace <ArrowRight size={16} /></a><a className="marketing-secondary" href="#how-it-works">See how it works</a></div>
      </section>
      <section className="marketing-grid" id="how-it-works">
        <article><Mail size={20} /><h2>Mailbox to dashboard</h2><p>Orders and shipment updates are parsed from each customer’s Gmail inbox.</p></article>
        <article><CheckCircle2 size={20} /><h2>Exceptions at a glance</h2><p>See completed, stuck, cancelled, and in-transit orders without opening every account.</p></article>
        <article><ShieldCheck size={20} /><h2>Service-fee billing</h2><p>Invoice only your configured checkout fees, with Stripe and optional Venmo payment links.</p></article>
      </section>
      <footer className="marketing-footer">Private customer links · Workspace-level isolation · Built for ACO operators</footer>
    </main>
  );
}
