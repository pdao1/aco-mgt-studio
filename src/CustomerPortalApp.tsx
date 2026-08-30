import { ExternalLink, PackageCheck, ShieldCheck, ShoppingBag, Truck, X } from 'lucide-react';
import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { api, ApiError } from './lib/api';
import { formatDate, formatDateTime, formatMoney, formatPercent, maskTracking } from './lib/format';
import { filterOrders, listRetailers } from './lib/orders';
import { StoreMark } from './components/OrdersTable';
import type { Order, OrderStatus, PortalPayload } from './types';

interface CustomerPortalAppProps {
  token: string;
}

export default function CustomerPortalApp({ token }: CustomerPortalAppProps) {
  const [payload, setPayload] = useState<PortalPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selectedOrderId, setSelectedOrderId] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void api.customerPortal(token)
      .then((nextPayload) => {
        if (!active) return;
        setPayload(nextPayload);
        setSelectedOrderId(nextPayload.orders[0]?.id ?? null);
      })
      .catch((caught: unknown) => {
        if (!active) return;
        setError(caught instanceof ApiError ? caught.message : 'This customer link could not be loaded.');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, [token]);

  useEffect(() => {
    if (payload && selectedOrderId === null) setSelectedOrderId(payload.orders[0]?.id ?? null);
  }, [payload]);

  useEffect(() => {
    document.title = payload ? `${payload.workspace.settings.displayName} | Customer portal` : 'Customer portal';
  }, [payload?.workspace.settings.displayName]);

  if (loading) return <PortalState title="Loading your orders" detail="Securely fetching the latest order activity." loading />;
  if (error || !payload) return <PortalState title="Customer link unavailable" detail={error || 'This customer link is invalid or has expired.'} />;

  const selectedOrder = payload.orders.find((order) => order.id === selectedOrderId) ?? null;
  return <PortalView payload={payload} selectedOrder={selectedOrder} onSelect={setSelectedOrderId} />;
}

function PortalView({
  payload,
  selectedOrder,
  onSelect,
}: {
  payload: PortalPayload;
  selectedOrder: Order | null;
  onSelect: (orderId: string | null) => void;
}) {
  const [filter, setFilter] = useState<'all' | 'in-transit' | 'delivered' | 'processing' | 'cancelled' | 'pending'>('all');
  const [search, setSearch] = useState('');
  const [retailer, setRetailer] = useState('');
  const retailers = useMemo(() => listRetailers(payload.orders), [payload.orders]);
  const retailerOrders = useMemo(() => filterOrders(payload.orders, { retailer }), [payload.orders, retailer]);
  const filteredOrders = useMemo(
    () => filterOrders(payload.orders, { status: filter, query: search, retailer }),
    [filter, payload.orders, retailer, search],
  );

  useEffect(() => {
    if (selectedOrder && !filteredOrders.some((order) => order.id === selectedOrder.id)) {
      onSelect(filteredOrders[0]?.id ?? null);
    }
  }, [filteredOrders, onSelect, selectedOrder]);

  const deliveredCount = payload.orders.filter((order) => order.status === 'delivered').length;
  const inTransitCount = payload.orders.filter((order) => order.status === 'shipped').length;
  const chargeableOrders = payload.orders.filter((order) => order.status !== 'cancelled');
  const feeCurrencies = new Set(chargeableOrders.map((order) => order.currency));
  const feeTotalCents = chargeableOrders.reduce((sum, order) => sum + (order.feeCents ?? 0), 0);
  const feeCurrency = chargeableOrders[0]?.currency ?? 'USD';
  const feeTotalLabel = feeCurrencies.size > 1 ? 'Multiple' : formatMoney(feeTotalCents, feeCurrency);
  const brandName = payload.workspace.settings.displayName || payload.workspace.name;
  const initials = payload.customer.name.split(/\s+/).map((part) => part[0]).join('').slice(0, 2).toUpperCase();

  return (
    <div className="portal-shell" data-theme={payload.workspace.settings.theme} style={{ '--blue': payload.workspace.settings.accentColor } as CSSProperties}>
      <header className="portal-header">
        <div className="portal-brand">{payload.workspace.settings.logoUrl ? <img src={payload.workspace.settings.logoUrl} alt="" /> : null}{brandName}</div>
        <div className="portal-header-divider" />
        <div className="portal-link-status"><ShieldCheck size={16} /> Secure customer link</div>
        <div className="portal-customer-chip">
          <span className="portal-avatar">{initials}</span>
          <span>{payload.customer.name}</span>
        </div>
      </header>

      <main className="portal-main">
        <section className="portal-intro">
          <span className="portal-eyebrow">Customer order center</span>
          <h1>Your orders</h1>
        <p>Track and review your order activity with {brandName}.</p>
        </section>

        <section className="portal-summary" aria-label="Order summary">
          <PortalSummaryItem icon={<ShoppingBag size={21} />} label="Orders" value={payload.orders.length.toString()} detail="All time" />
          <PortalSummaryItem icon={<Truck size={21} />} label="In transit" value={inTransitCount.toString()} detail={percentOf(inTransitCount, payload.orders.length)} />
          <PortalSummaryItem icon={<PackageCheck size={21} />} label="Delivered" value={deliveredCount.toString()} detail={percentOf(deliveredCount, payload.orders.length)} />
          <PortalSummaryItem icon={<span className="portal-currency-icon">$</span>} label="Service fees" value={feeTotalLabel} detail={feeCurrencies.size > 1 ? 'Multiple currencies' : 'All time total'} />
        </section>

        <section className="portal-content-grid">
          <section className="portal-orders-card" aria-label="Orders">
            <div className="portal-orders-toolbar">
              <div className="portal-filter-tabs" role="tablist" aria-label="Filter orders">
                {([
                  ['all', 'All'],
                  ['in-transit', 'In transit'],
                  ['delivered', 'Completed'],
                  ['pending', 'Pending'],
                  ['processing', 'Processing'],
                  ['cancelled', 'Cancelled'],
                ] as const).map(([id, label]) => (
                  <button key={id} className={filter === id ? 'portal-filter active' : 'portal-filter'} onClick={() => setFilter(id)} role="tab" aria-selected={filter === id}>
                    {label} <span>{countPortalOrders(retailerOrders, id)}</span>
                  </button>
                ))}
              </div>
              <div className="portal-table-tools">
                <label className="portal-retailer-filter">
                  <span>Retailer</span>
                  <select value={retailer} onChange={(event) => setRetailer(event.target.value)}>
                    <option value="">All retailers</option>
                    {retailers.map((name) => <option key={name.toLowerCase()} value={name}>{name}</option>)}
                  </select>
                </label>
                <label className="portal-search">
                  <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search orders" aria-label="Search orders" />
                </label>
              </div>
            </div>

            <div className="portal-table-wrap">
              <table className="portal-table">
                <thead>
                  <tr><th>Store</th><th>Order</th><th>Placed</th><th>Purchase total</th><th>Fee basis</th><th>Service fee</th><th>Status</th><th>Tracking</th><th aria-label="Open order" /></tr>
                </thead>
                <tbody>
                  {filteredOrders.map((order) => (
                    <tr key={order.id} className={selectedOrder?.id === order.id ? 'selected' : ''} onClick={() => onSelect(order.id)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') onSelect(order.id); }} tabIndex={0}>
                      <td><span className="portal-store-cell"><StoreMark store={order.store} /><span>{order.store}</span></span></td>
                      <td className="portal-order-number"><span>{order.orderNumber}</span>{order.trackingNumber && <small className="portal-order-tracking-inline">{order.carrier ?? 'Tracking'} · {maskTracking(order.trackingNumber)}</small>}</td>
                      <td>{formatDate(order.orderedAt)}</td>
                      <td>{formatMoney(order.totalCents, order.currency)}</td>
                      <td><span className="portal-fee-cell">{formatMoney(order.feeBasisCents, order.currency)} <small>{order.feeBasis === 'checkout_total' ? 'Checkout total' : 'Custom amount'}</small></span></td>
                      <td><span className="portal-fee-cell">{formatMoney(order.feeCents, order.currency)} <small>({formatPercent(order.feePercent)})</small></span></td>
                      <td><span className={`portal-status ${order.status}`}>{portalStatusLabel(order.status)}</span></td>
                      <td>{order.trackingNumber ? order.trackingUrl ? <a href={order.trackingUrl} target="_blank" rel="noreferrer" onClick={(event) => event.stopPropagation()}>{maskTracking(order.trackingNumber)}</a> : maskTracking(order.trackingNumber) : '—'}</td>
                      <td className="portal-row-chevron">›</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {filteredOrders.length === 0 && <div className="portal-empty"><strong>No matching orders</strong><span>Try another filter or search term.</span></div>}
            </div>
            <footer className="portal-table-footer">Showing {filteredOrders.length} of {payload.orders.length} orders</footer>
          </section>

          {selectedOrder && <PortalOrderDetail order={selectedOrder} onClose={() => onSelect(null)} />}
        </section>
        <PortalInvoices invoices={payload.invoices} venmoPaymentUrl={payload.workspace.settings.venmoPaymentUrl} />
      </main>
    </div>
  );
}

function PortalInvoices({ invoices, venmoPaymentUrl }: { invoices: PortalPayload['invoices']; venmoPaymentUrl: string | null }) {
  return (
    <section className="portal-invoices-card" aria-labelledby="portal-invoices-title">
      <div className="portal-invoices-heading"><div><h2 id="portal-invoices-title">Invoices</h2><p>Review your service fees and pay securely through Stripe or Venmo.</p></div><ShieldCheck size={18} /></div>
      {invoices.length === 0 ? <div className="portal-invoice-empty">Invoices will appear here after your account manager issues one.</div> : <div className="portal-invoice-list">{invoices.map((invoice) => <div className="portal-invoice-row" key={invoice.id}><span><strong>{invoice.invoiceNumber}</strong><small>{invoice.companyName && <>{invoice.companyName} · </>}{formatDate(invoice.createdAt)} · {invoice.lines.length} orders</small></span><strong>{formatMoney(invoice.totalCents, invoice.currency)}</strong><span className={`portal-status ${invoice.status}`}>{invoice.status}</span><span className="portal-payment-actions">{invoice.paymentUrl ? <a className="portal-pay-link" href={invoice.paymentUrl} target="_blank" rel="noreferrer">Pay with Stripe <ExternalLink size={14} /></a> : invoice.status === 'draft' ? <span className="portal-invoice-note">Being prepared</span> : <span className="portal-invoice-note">Stripe unavailable</span>}{venmoPaymentUrl && invoice.status !== 'paid' ? <a className="portal-venmo-link" href={venmoPaymentUrl} target="_blank" rel="noreferrer">Pay with Venmo <ExternalLink size={14} /></a> : null}</span></div>)}</div>}
    </section>
  );
}

function PortalSummaryItem({ icon, label, value, detail }: { icon: ReactNode; label: string; value: string; detail: string }) {
  return <div className="portal-summary-item"><span className="portal-summary-icon">{icon}</span><span className="portal-summary-copy"><span>{label}</span><strong>{value}</strong><small>{detail}</small></span></div>;
}

function PortalOrderDetail({ order, onClose }: { order: Order; onClose: () => void }) {
  return (
    <aside className="portal-detail" aria-label={`Order ${order.orderNumber}`}>
      <div className="portal-detail-heading"><div><h2>Order #{order.orderNumber}</h2><span className={`portal-status ${order.status}`}>{portalStatusLabel(order.status)}</span></div><button className="portal-close" onClick={onClose} aria-label="Close order details"><X size={19} /></button></div>
      <div className="portal-detail-store"><StoreMark store={order.store} /><div><strong>{order.store}</strong><span>{formatDateTime(order.orderedAt)}</span></div></div>
      <section className="portal-items-section" aria-labelledby="portal-items-title">
        <div className="portal-items-heading"><h3 id="portal-items-title">Items purchased</h3><span>{order.itemCount ? `${order.itemCount} ${order.itemCount === 1 ? 'item' : 'items'}` : 'Details pending'}</span></div>
        {order.items?.length ? (
          <ul className="portal-items-list">
            {order.items.map((item, index) => {
              const lineTotal = item.totalCents ?? (item.unitPriceCents === null ? null : item.unitPriceCents * item.quantity);
              return <li key={`${item.name}-${index}`}><span><strong>{item.name}</strong><small>Qty {item.quantity}{item.unitPriceCents !== null ? ` · ${formatMoney(item.unitPriceCents, order.currency)} each` : ''}</small></span><b>{formatMoney(lineTotal, order.currency)}</b></li>;
            })}
          </ul>
        ) : <p className="portal-items-empty">Item details will appear when the retailer includes line items in a confirmation email.</p>}
      </section>
      <section className="portal-activity"><h3>Order timeline</h3><ol className="portal-timeline">{order.events.map((event, index) => <li key={event.id} className={index === order.events.length - 1 ? 'last' : ''}><span className="portal-timeline-node" /><div><strong>{event.label}</strong><time>{formatDateTime(event.occurredAt)}</time><p>{event.detail}</p></div></li>)}</ol></section>
      <section className="portal-fee-breakdown"><h3>Fee breakdown</h3><div><span>Customer-paid purchase</span><strong>{formatMoney(order.totalCents, order.currency)}</strong></div><div><span>{order.feeBasis === 'checkout_total' ? 'Checkout fee basis' : 'Custom fee basis'}</span><strong>{formatMoney(order.feeBasisCents, order.currency)}</strong></div><div className="portal-total-row"><span>Service fee ({formatPercent(order.feePercent)})</span><strong>{formatMoney(order.feeCents, order.currency)}</strong></div></section>
      <div className="portal-privacy-note"><ShieldCheck size={16} /><div><strong>Secure & private</strong><p>This link is unique to you. Do not share it with others.</p></div></div>
      {order.isManualOverride && <div className="portal-override-note"><ShieldCheck size={15} /><span><strong>Account manager update</strong>{order.overrideNote || 'The status was updated manually.'}</span></div>}
      {order.trackingUrl && <a className="portal-tracking-link" href={order.trackingUrl} target="_blank" rel="noreferrer">View order tracking <ExternalLink size={15} /></a>}
    </aside>
  );
}

function PortalState({ title, detail, loading = false }: { title: string; detail: string; loading?: boolean }) {
  return <main className="portal-state"><span className={loading ? 'portal-state-mark spinning' : 'portal-state-mark'}>{loading ? null : <ShieldCheck size={22} />}</span><h1>{title}</h1><p>{detail}</p></main>;
}

function countPortalOrders(orders: Order[], filter: 'all' | 'in-transit' | 'delivered' | 'processing' | 'cancelled' | 'pending') {
  if (filter === 'all') return orders.length;
  if (filter === 'in-transit') return orders.filter((order) => order.status === 'shipped').length;
  return orders.filter((order) => order.status === filter).length;
}

function percentOf(value: number, total: number) {
  return total === 0 ? '0% of all orders' : `${Math.round(value / total * 100)}% of all orders`;
}

function portalStatusLabel(status: OrderStatus) {
  if (status === 'shipped') return 'In transit';
  if (status === 'processing') return 'Processing';
  return status.charAt(0).toUpperCase() + status.slice(1);
}
