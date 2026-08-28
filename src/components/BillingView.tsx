import { Check, CircleDollarSign, FilePlus2, ExternalLink, LockKeyhole } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { calculateInvoiceTotals, isBillableOrder } from '../lib/billing';
import { formatDate, formatMoney, formatPercent } from '../lib/format';
import type { Customer, Invoice, Order } from '../types';

interface BillingViewProps {
  customer: Customer | null;
  orders: Order[];
  invoices: Invoice[];
  onCreateInvoice: (customerId: string, orderIds: string[]) => Promise<void>;
  onIssueInvoice: (invoiceId: string) => Promise<void>;
}

export function BillingView({ customer, orders, invoices, onCreateInvoice, onIssueInvoice }: BillingViewProps) {
  const billableOrders = useMemo(() => orders.filter(isBillableOrder), [orders]);
  const customerInvoices = useMemo(() => customer ? invoices.filter((invoice) => invoice.customerId === customer.id) : [], [customer, invoices]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [creating, setCreating] = useState(false);
  const [issuingId, setIssuingId] = useState<string | null>(null);
  const [actionError, setActionError] = useState('');

  useEffect(() => {
    setSelectedIds(billableOrders.map((order) => order.id));
    setActionError('');
  }, [customer?.id, billableOrders]);

  const selectedOrders = billableOrders.filter((order) => selectedIds.includes(order.id));
  const preview = calculateInvoiceTotals(selectedOrders);
  const outstanding = customerInvoices
    .filter((invoice) => invoice.status === 'open' || invoice.status === 'uncollectible')
    .reduce((sum, invoice) => sum + invoice.totalCents, 0);
  const currency = preview?.currency ?? customerInvoices[0]?.currency ?? 'USD';

  const createInvoice = async () => {
    if (!customer || selectedIds.length === 0 || creating) return;
    setCreating(true);
    setActionError('');
    try {
      await onCreateInvoice(customer.id, selectedIds);
      setSelectedIds([]);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Could not create the invoice.');
    } finally {
      setCreating(false);
    }
  };

  const issueInvoice = async (invoiceId: string) => {
    if (issuingId) return;
    setIssuingId(invoiceId);
    setActionError('');
    try {
      await onIssueInvoice(invoiceId);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Could not connect this invoice to Stripe.');
    } finally {
      setIssuingId(null);
    }
  };

  if (!customer) {
    return <section className="billing-view billing-empty"><CircleDollarSign size={28} /><h1>Billing</h1><p>Connect a customer to create and track invoices.</p></section>;
  }

  return (
    <section className="billing-view" aria-label="Billing">
      <header className="billing-header">
        <div><h1>Billing</h1><p>Review {customer.name}&apos;s order charges and issue one clear invoice.</p></div>
        <span className="billing-customer-label"><span className="sync-dot synced" /> {customer.name}</span>
      </header>

      <section className="billing-metrics" aria-label="Billing totals">
        <BillingMetric label="Unbilled orders" value={selectedIds.length.toString()} detail={`${billableOrders.length} available`} />
        <BillingMetric label="Selected fees" value={formatMoney(preview?.totalCents ?? 0, currency)} detail={`${formatMoney(preview?.subtotalCents ?? 0, currency)} in customer-paid purchases`} />
        <BillingMetric label="Outstanding" value={formatMoney(outstanding, currency)} detail="Issued invoices" tone="amber" />
      </section>

      <section className="billing-panel" aria-labelledby="invoice-builder-title">
        <div className="billing-panel-heading"><div><h2 id="invoice-builder-title">Create invoice</h2><p>Only service fees are invoiced. Fee calculations are locked after issue.</p></div><LockKeyhole size={18} /></div>
        {billableOrders.length === 0 ? (
          <div className="billing-empty-row"><Check size={20} /><strong>Everything is accounted for</strong><span>There are no unbilled orders with a billable fee basis for this customer.</span></div>
        ) : (
          <>
            <div className="billing-select-row"><label><input type="checkbox" checked={selectedIds.length === billableOrders.length} onChange={(event) => setSelectedIds(event.target.checked ? billableOrders.map((order) => order.id) : [])} /> <span>Select all unbilled orders</span></label><span>{formatMoney(preview?.feeCents ?? 0, currency)} service fees</span></div>
            <div className="billing-order-list">
              {billableOrders.map((order) => (
                <label className="billing-order-row" key={order.id}>
                  <input type="checkbox" checked={selectedIds.includes(order.id)} onChange={(event) => setSelectedIds((current) => event.target.checked ? [...current, order.id] : current.filter((id) => id !== order.id))} />
                  <span className="billing-order-name"><strong>{order.store} · {order.orderNumber}</strong><small>{formatPercent(order.feePercent)} of {formatMoney(order.feeBasisCents, order.currency)} {order.feeBasis === 'custom_amount' ? 'custom basis' : 'purchase total'}</small></span>
                  <span>{formatMoney(order.feeCents, order.currency)}</span>
                </label>
              ))}
            </div>
            <div className="billing-create-row"><span>Service fees due <strong>{formatMoney(preview?.totalCents ?? 0, currency)}</strong></span><button className="primary-action" onClick={() => void createInvoice()} disabled={selectedIds.length === 0 || creating}><FilePlus2 size={16} /> {creating ? 'Creating…' : 'Create draft invoice'}</button></div>
          </>
        )}
      </section>

      <section className="billing-panel" aria-labelledby="invoice-list-title">
        <div className="billing-panel-heading"><div><h2 id="invoice-list-title">Invoices</h2><p>Issue a draft to create a hosted Stripe payment page.</p></div></div>
        {customerInvoices.length === 0 ? <div className="billing-empty-row"><CircleDollarSign size={20} /><strong>No invoices yet</strong><span>Create a draft above after the next mailbox sync.</span></div> : (
          <div className="invoice-table-wrap"><table className="invoice-table"><thead><tr><th>Invoice</th><th>Created</th><th>Orders</th><th>Total</th><th>Status</th><th>Payment</th></tr></thead><tbody>{customerInvoices.map((invoice) => <tr key={invoice.id}><td className="invoice-number">{invoice.invoiceNumber}</td><td>{formatDate(invoice.createdAt)}</td><td>{invoice.lines.length}</td><td className="invoice-total">{formatMoney(invoice.totalCents, invoice.currency)}</td><td><span className={`invoice-status ${invoice.status}`}>{invoice.status}</span></td><td>{invoice.paymentUrl ? <a className="invoice-pay-link" href={invoice.paymentUrl} target="_blank" rel="noreferrer">Pay invoice <ExternalLink size={13} /></a> : invoice.status === 'draft' ? <button className="secondary-action invoice-issue-button" onClick={() => void issueInvoice(invoice.id)} disabled={issuingId === invoice.id}>{issuingId === invoice.id ? 'Connecting…' : 'Issue with Stripe'}</button> : '—'}</td></tr>)}</tbody></table></div>)}
      </section>
      {actionError && <p className="billing-error" role="alert">{actionError}</p>}
    </section>
  );
}

function BillingMetric({ label, value, detail, tone = 'blue' }: { label: string; value: string; detail: string; tone?: 'blue' | 'amber' }) {
  return <div className="billing-metric"><span className={`billing-metric-icon ${tone}`}><CircleDollarSign size={17} /></span><span><small>{label}</small><strong>{value}</strong><em>{detail}</em></span></div>;
}
