import { AlertTriangle, CheckCircle2, ShoppingBag, XCircle } from 'lucide-react';
import type { Order, OrderStatus } from '../types';

interface SummaryStripProps {
  orders: Order[];
  activeStatus: 'all' | OrderStatus;
  onSelect: (status: 'all' | OrderStatus) => void;
}

export function SummaryStrip({ orders, activeStatus, onSelect }: SummaryStripProps) {
  const summaries = [
    { id: 'all' as const, label: 'All orders', icon: ShoppingBag, value: orders.length },
    { id: 'delivered' as const, label: 'Completed', icon: CheckCircle2, value: orders.filter((order) => order.status === 'delivered').length },
    { id: 'processing' as const, label: 'Processing', icon: AlertTriangle, value: orders.filter((order) => order.status === 'processing').length },
    { id: 'cancelled' as const, label: 'Cancelled', icon: XCircle, value: orders.filter((order) => order.status === 'cancelled').length },
  ];

  return (
    <section className="summary-strip" aria-label="Order summary">
      {summaries.map(({ id, label, icon: Icon, value }) => {
        const percentage = orders.length === 0 ? 0 : Math.round((value / orders.length) * 100);
        return (
          <button
            key={id}
            className={activeStatus === id ? 'summary-item selected' : 'summary-item'}
            onClick={() => onSelect(id)}
          >
            <span className={`summary-icon ${id}`}><Icon size={20} /></span>
            <span className="summary-copy">
              <span>{label}</span>
              <strong>{value}</strong>
              <small>{id === 'all' ? 'Total orders' : `${percentage}% of all orders`}</small>
            </span>
          </button>
        );
      })}
    </section>
  );
}
