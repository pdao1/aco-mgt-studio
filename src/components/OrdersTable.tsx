import { Archive, ArchiveRestore, ArrowDown, ArrowUp, MoreHorizontal, Search } from 'lucide-react';
import { FaAmazon } from 'react-icons/fa6';
import { SiAdidas, SiNike, SiStockx, SiTarget } from 'react-icons/si';
import { TbBrandWalmart } from 'react-icons/tb';
import type { IconType } from 'react-icons';
import type { Order, OrderStatus } from '../types';
import { formatDate, formatMoney, formatPaymentMethod, formatPercent, maskTracking, titleCaseStatus } from '../lib/format';
import { filterOrders, listRetailers } from '../lib/orders';

export type OrderFilter = 'all' | OrderStatus;
export type DateWindow = 7 | 30 | 60 | 90 | null;
export type SortDirection = 'asc' | 'desc';

interface OrdersTableProps {
  orders: Order[];
  allOrders: Order[];
  filter: OrderFilter;
  query: string;
  retailer: string;
  selectedId: string | null;
  onFilter: (filter: OrderFilter) => void;
  onQuery: (query: string) => void;
  onRetailer: (retailer: string) => void;
  onSelect: (order: Order) => void;
  dateWindow: DateWindow;
  sortDirection: SortDirection;
  showArchived: boolean;
  onDateWindow: (value: DateWindow) => void;
  onSortDirection: (value: SortDirection) => void;
  onShowArchived: (value: boolean) => void;
  onArchive: (order: Order) => void;
}

const filters: Array<{ id: OrderFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'pending', label: 'Pending' },
  { id: 'confirmed', label: 'Confirmed' },
  { id: 'processing', label: 'Processing' },
  { id: 'shipped', label: 'Shipped' },
  { id: 'delivered', label: 'Delivered' },
  { id: 'cancelled', label: 'Cancelled' },
];

const storeIcons: Record<string, IconType> = {
  nike: SiNike,
  adidas: SiAdidas,
  amazon: FaAmazon,
  stockx: SiStockx,
  target: SiTarget,
  walmart: TbBrandWalmart,
};

const storeSlug = (store: string) => store.toLowerCase().replace(/[^a-z0-9]+/g, '-');

export function StoreMark({ store }: { store: string }) {
  const slug = storeSlug(store);
  const Icon = storeIcons[slug];
  const letters = store
    .split(/\s+/)
    .map((word) => word[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
  return <span className={`store-mark ${slug}`} aria-hidden="true">{Icon ? <Icon size={18} /> : letters}</span>;
}

export function OrderMetadataCell({ value }: { value: string | null }) {
  return <td><span className="order-metadata-cell" title={value ?? undefined}>{value ?? '—'}</span></td>;
}

export function OrdersTable({
  orders,
  allOrders,
  filter,
  query,
  retailer,
  selectedId,
  onFilter,
  onQuery,
  onRetailer,
  onSelect,
  dateWindow,
  sortDirection,
  showArchived,
  onDateWindow,
  onSortDirection,
  onShowArchived,
  onArchive,
}: OrdersTableProps) {
  const retailerOrders = filterOrders(allOrders, { retailer });
  const count = (status: OrderFilter) => status === 'all'
    ? retailerOrders.length
    : retailerOrders.filter((order) => order.status === status).length;
  const retailers = listRetailers(allOrders);

  return (
    <section className="orders-region" aria-label="Orders">
      <div className="orders-toolbar">
        <div className="status-tabs" role="tablist" aria-label="Filter orders by status">
          {filters.map(({ id, label }) => (
            <button
              key={id}
              className={filter === id ? 'status-tab active' : 'status-tab'}
              onClick={() => onFilter(id)}
              role="tab"
              aria-selected={filter === id}
            >
              {label} <span>{count(id)}</span>
            </button>
          ))}
        </div>

        <div className="table-tools">
          <label className="retailer-filter">
            <span>Retailer</span>
            <select value={retailer} onChange={(event) => onRetailer(event.target.value)}>
              <option value="">All retailers</option>
              {retailers.map((name) => <option key={name.toLowerCase()} value={name}>{name}</option>)}
            </select>
          </label>
          <label className="retailer-filter date-filter">
            <span>Show</span>
            <select value={dateWindow ?? ''} onChange={(event) => onDateWindow(event.target.value ? Number(event.target.value) as DateWindow : null)} aria-label="Filter orders by date">
              <option value="">Any time</option>
              <option value="7">Last 7 days</option>
              <option value="30">Last 30 days</option>
              <option value="60">Last 60 days</option>
              <option value="90">Last 90 days</option>
            </select>
          </label>
          <label className="retailer-filter sort-filter">
            <span>Sort</span>
            <select value={sortDirection} onChange={(event) => onSortDirection(event.target.value as SortDirection)} aria-label="Sort orders by date">
              <option value="desc">Newest first</option>
              <option value="asc">Oldest first</option>
            </select>
          </label>
          <label className="archived-toggle">
            <input type="checkbox" checked={showArchived} onChange={(event) => onShowArchived(event.target.checked)} />
            <span>Show archived</span>
          </label>
          <label className="search-field order-search">
            <Search size={17} />
            <input
              value={query}
              onChange={(event) => onQuery(event.target.value)}
              placeholder="Search orders"
              aria-label="Search orders"
            />
          </label>
        </div>
      </div>

      <div className="orders-table-wrap">
        <table className="orders-table">
          <thead>
            <tr>
              <th>Store</th>
              <th>Order</th>
              <th>To alias</th>
              <th>Ship to</th>
              <th>Payment</th>
              <th className="sorted-column">Ordered {sortDirection === 'desc' ? <ArrowDown size={13} /> : <ArrowUp size={13} />}</th>
              <th>Purchase total</th>
              <th>Fee basis</th>
              <th>Service fee</th>
              <th>Status</th>
              <th>Tracking</th>
            </tr>
          </thead>
          <tbody>
            {orders.map((order) => (
              <tr
                key={order.id}
                className={selectedId === order.id ? 'selected' : ''}
                onClick={() => onSelect(order)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') onSelect(order);
                }}
                tabIndex={0}
              >
                <td>
                  <span className="store-cell"><StoreMark store={order.store} /><span>{order.store}</span></span>
                </td>
                <td className="order-number">
                  <span>{order.orderNumber}</span>
                  {order.trackingNumber && <small className="order-tracking-inline">{order.carrier ?? 'Tracking'} · {maskTracking(order.trackingNumber)}</small>}
                  <details className="order-row-menu" onClick={(event) => event.stopPropagation()}>
                    <summary aria-label={`Actions for order ${order.orderNumber}`}><MoreHorizontal size={16} /></summary>
                    <div className="order-row-menu-popover">
                      <button type="button" onClick={() => onArchive(order)}>
                        {order.isArchived ? <ArchiveRestore size={14} /> : <Archive size={14} />}
                        {order.isArchived ? 'Restore order' : 'Archive order'}
                      </button>
                    </div>
                  </details>
                </td>
                <OrderMetadataCell value={order.emailTo} />
                <OrderMetadataCell value={order.shippingAddress} />
                <OrderMetadataCell value={formatPaymentMethod(order.paymentMethodType, order.paymentLast4)} />
                <td>{formatDate(order.orderedAt)}</td>
                <td>{formatMoney(order.totalCents, order.currency)}</td>
                <td><span className="fee-cell">{formatMoney(order.feeBasisCents, order.currency)} <small>{order.feeBasis === 'checkout_total' ? 'Checkout total' : 'Custom amount'}</small></span></td>
                <td className="service-fee-cell"><span className="fee-cell">{formatMoney(order.feeCents, order.currency)} <small>{formatPercent(order.feePercent)}</small></span></td>
                <td><span className={`status-label ${order.status}`}>{titleCaseStatus(order.status)}</span></td>
                <td>
                  {order.trackingNumber ? (
                    order.trackingUrl ? (
                      <a href={order.trackingUrl} target="_blank" rel="noreferrer" onClick={(event) => event.stopPropagation()}>
                        {maskTracking(order.trackingNumber)}
                      </a>
                    ) : <span className="tracking-text">{maskTracking(order.trackingNumber)}</span>
                  ) : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {orders.length === 0 && (
          <div className="orders-empty">
            <PackageEmpty />
            <strong>No matching orders</strong>
            <span>Try a different status or search term.</span>
          </div>
        )}
      </div>

      <footer className="table-footer">
        <span>Showing {orders.length} of {allOrders.length} orders</span>
      </footer>
    </section>
  );
}

function PackageEmpty() {
  return (
    <svg width="34" height="34" viewBox="0 0 34 34" fill="none" aria-hidden="true">
      <path d="M5 10.5 17 4l12 6.5v13L17 30 5 23.5v-13Z" stroke="currentColor" strokeWidth="1.6" />
      <path d="m5 10.5 12 6.3 12-6.3M17 16.8V30" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  );
}
