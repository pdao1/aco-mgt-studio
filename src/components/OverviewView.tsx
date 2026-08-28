import { AlertTriangle, CheckCircle2, CircleDollarSign, Users, XCircle } from 'lucide-react';
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
  const completed = orders.filter((order) => order.status === 'delivered').length;
  const stuck = orders.filter((order) => order.status === 'processing').length;
  const cancelled = orders.filter((order) => order.status === 'cancelled').length;
  const chargeableOrders = orders.filter((order) => order.status !== 'cancelled');
  const currencies = new Set(chargeableOrders.map((order) => order.currency));
  const serviceFeeTotal = chargeableOrders.reduce((sum, order) => sum + (order.feeCents ?? 0), 0);
  const currency = chargeableOrders[0]?.currency ?? 'USD';
  const serviceFeeLabel = currencies.size > 1 ? 'Multiple' : formatMoney(serviceFeeTotal, currency);
  const attentionOrders = orders
    .filter((order) => order.status === 'processing' || order.status === 'cancelled')
    .slice(0, 8);

  return (
    <section className="overview-view" aria-label="Workspace overview">
      <header className="overview-header">
        <div>
          <h1>Overview</h1>
          <p>Keep customer orders, exceptions, and charges in one place.</p>
        </div>
        <span className="overview-live-note"><span className="sync-dot synced" /> Live workspace data</span>
      </header>

      <section className="overview-metrics" aria-label="Workspace totals">
        <OverviewMetric icon={<Users size={19} />} label="Customers" value={customers.length.toString()} detail="Connected customer inboxes" />
        <OverviewMetric icon={<CheckCircle2 size={19} />} label="Completed" value={completed.toString()} detail={percentOf(completed, orders.length)} tone="green" />
        <OverviewMetric icon={<AlertTriangle size={19} />} label="Stuck" value={stuck.toString()} detail="Needs attention" tone="amber" />
        <OverviewMetric icon={<XCircle size={19} />} label="Cancelled" value={cancelled.toString()} detail="Excluded from invoices" tone="red" />
        <OverviewMetric icon={<CircleDollarSign size={19} />} label="Service fees" value={serviceFeeLabel} detail={currencies.size > 1 ? 'Multiple currencies' : 'Excludes retailer purchases'} tone="blue" />
      </section>

      <section className="overview-attention" aria-labelledby="attention-title">
        <div className="overview-section-heading">
          <div><h2 id="attention-title">Needs attention</h2><p>Processing and cancelled orders across all customers.</p></div>
          <span>{attentionOrders.length} shown</span>
        </div>
        {attentionOrders.length === 0 ? (
          <div className="overview-empty"><CheckCircle2 size={22} /><strong>Nothing needs attention</strong><span>New orders will appear here as inboxes sync.</span></div>
        ) : (
          <div className="overview-attention-list">
            {attentionOrders.map((order) => {
              const customer = customers.find((candidate) => candidate.id === order.customerId);
              return (
                <button className="overview-attention-row" key={order.id} onClick={() => onOpenCustomer(order.customerId, order.id)}>
                  <StoreMark store={order.store} />
                  <span className="overview-order-copy"><strong>{order.store} · {order.orderNumber}</strong><small>{customer?.name ?? 'Customer'} · {order.overrideNote || 'Review order status'}</small></span>
                  <span className={`status-label ${order.status}`}>{titleCaseStatus(order.status)}</span>
                  <span className="overview-order-total" title="Service fee">{formatMoney(order.feeCents, order.currency)}</span>
                </button>
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

function percentOf(value: number, total: number) {
  return total === 0 ? '0% of all orders' : `${Math.round(value / total * 100)}% of all orders`;
}
