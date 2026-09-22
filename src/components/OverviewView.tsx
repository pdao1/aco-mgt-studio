import { AlertTriangle, CheckCircle2, CircleDollarSign, ShoppingBag, TrendingUp, XCircle } from 'lucide-react';
import type { ReactNode } from 'react';
import { formatMoney, titleCaseStatus } from '../lib/format';
import { StoreMark } from './OrdersTable';
import type { Customer, Order } from '../types';

interface OverviewViewProps {
  customers: Customer[];
  orders: Order[];
  onOpenCustomer: (customerId: string, orderId?: string) => void;
}

export function OverviewView({ customers, orders, onOpenCustomer }: OverviewViewProps) {
  const activeOrders = orders.filter((order) => !order.isArchived);
  const cancelled = activeOrders.filter((order) => order.status === 'cancelled').length;
  const chargeableOrders = activeOrders.filter((order) => order.status !== 'cancelled');
  const currencies = new Set(chargeableOrders.map((order) => order.currency));
  const totalSpent = chargeableOrders.reduce((sum, order) => sum + (order.totalCents ?? 0), 0);
  const currency = chargeableOrders[0]?.currency ?? 'USD';
  const totalSpentLabel = currencies.size > 1 ? 'Multiple' : formatMoney(totalSpent, currency);
  const stickRate = activeOrders.length === 0 ? '—' : `${Math.round((activeOrders.length - cancelled) / activeOrders.length * 100)}%`;
  const attentionOrders = activeOrders
    .filter((order) => order.status === 'processing' || order.status === 'cancelled')
    .slice(0, 8);

  return (
    <section className="overview-view" aria-label="Workspace overview">
      <header className="overview-header">
        <div>
          <h1>Overview</h1>
        </div>
      </header>

      <section className="overview-metrics" aria-label="Workspace totals">
        <OverviewMetric icon={<ShoppingBag size={19} />} label="Total orders" value={activeOrders.length.toString()} detail="Active order records" />
        <OverviewMetric icon={<CircleDollarSign size={19} />} label="Total spent" value={totalSpentLabel} detail={currencies.size > 1 ? 'Multiple currencies' : 'Cancelled orders excluded'} tone="green" />
        <OverviewMetric icon={<XCircle size={19} />} label="Total cancels" value={cancelled.toString()} detail="Excluded from active spend" tone="red" />
        <OverviewMetric icon={<TrendingUp size={19} />} label="Net stick rate" value={stickRate} detail="Orders not cancelled" tone="blue" />
      </section>

      <section className="overview-attention" aria-labelledby="attention-title">
        <div className="overview-section-heading">
          <div><h2 id="attention-title">Order activity</h2><p>Processing and cancelled orders across all customers.</p></div>
          <span>{attentionOrders.length} shown</span>
        </div>
        {attentionOrders.length === 0 ? (
          <div className="overview-empty"><CheckCircle2 size={22} /><strong>Nothing needs attention</strong><span>New orders will appear here as inboxes sync.</span></div>
        ) : (
          <div className="overview-attention-list">
            {attentionOrders.map((order) => {
              const customer = customers.find((candidate) => candidate.id === order.customerId);
              return (
                <div
                  className="overview-attention-row"
                  key={order.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => onOpenCustomer(order.customerId, order.id)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') onOpenCustomer(order.customerId, order.id);
                  }}
                >
                  <StoreMark store={order.store} />
                  <span className="overview-order-copy">
                    <strong>{order.store} · {order.orderNumber}</strong>
                    <button
                      type="button"
                      className="overview-customer-link"
                      onClick={(event) => {
                        event.stopPropagation();
                        onOpenCustomer(order.customerId);
                      }}
                      onKeyDown={(event) => event.stopPropagation()}
                    >
                      {customer?.name ?? 'Customer'}
                    </button>
                    <small>{order.overrideNote || 'Review order status'}</small>
                  </span>
                  <span className={`status-label ${order.status}`}>{titleCaseStatus(order.status)}</span>
                  <span className="overview-order-total" title="Service fee">{formatMoney(order.feeCents, order.currency)}</span>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </section>
  );
}

function OverviewMetric({ icon, label, value, detail, tone = 'blue' }: { icon: ReactNode; label: string; value: string; detail: string; tone?: 'blue' | 'green' | 'amber' | 'red' }) {
  return <div className="overview-metric"><span className={`overview-metric-icon ${tone}`}>{icon}</span><span><small>{label}</small><strong>{value}</strong><em>{detail}</em></span></div>;
}
