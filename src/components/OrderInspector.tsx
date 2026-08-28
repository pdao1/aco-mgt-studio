import { Copy, ExternalLink, X } from 'lucide-react';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import type { FeeBasis, Order, OrderStatus, UpdateOrderFeeInput } from '../types';
import { calculateFeeCents, formatDate, formatDateTime, formatMoney, formatPercent, maskTracking, titleCaseStatus } from '../lib/format';
import { StoreMark } from './OrdersTable';

interface OrderInspectorProps {
  order: Order;
  customerName: string;
  onClose: () => void;
  onFeeSave: (orderId: string, input: UpdateOrderFeeInput) => Promise<void>;
  onOverrideSave: (orderId: string, status: OrderStatus | null, note: string | null) => Promise<void>;
  savingFee?: boolean;
  savingOverride?: boolean;
}

export function OrderInspector({ order, customerName, onClose, onFeeSave, onOverrideSave, savingFee = false, savingOverride = false }: OrderInspectorProps) {
  const [feeInput, setFeeInput] = useState(String(order.feePercent));
  const [feeBasis, setFeeBasis] = useState<FeeBasis>(order.feeBasis);
  const [customBasisInput, setCustomBasisInput] = useState(
    order.feeBasis === 'custom_amount' && order.feeBasisCents !== null ? (order.feeBasisCents / 100).toFixed(2) : '',
  );
  const [feeError, setFeeError] = useState('');
  const [overrideStatus, setOverrideStatus] = useState<OrderStatus | ''>(order.isManualOverride ? order.status : '');
  const [overrideNote, setOverrideNote] = useState(order.overrideNote ?? '');
  const [overrideError, setOverrideError] = useState('');

  useEffect(() => {
    setFeeInput(String(order.feePercent));
    setFeeBasis(order.feeBasis);
    setCustomBasisInput(order.feeBasis === 'custom_amount' && order.feeBasisCents !== null ? (order.feeBasisCents / 100).toFixed(2) : '');
    setFeeError('');
    setOverrideStatus(order.isManualOverride ? order.status : '');
    setOverrideNote(order.overrideNote ?? '');
    setOverrideError('');
  }, [order.id, order.feePercent, order.feeBasis, order.feeBasisCents, order.isManualOverride, order.status, order.overrideNote]);

  const feePercent = Number(feeInput);
  const customBasisDollars = Number(customBasisInput);
  const customBasisCents = customBasisInput.trim() && Number.isFinite(customBasisDollars)
    ? Math.round(customBasisDollars * 100)
    : null;
  const resolvedBasisCents = feeBasis === 'checkout_total' ? order.totalCents : customBasisCents;
  const validFeePercent = Number.isFinite(feePercent) && feePercent >= 0 && feePercent <= 100;
  const previewBasisCents = resolvedBasisCents !== null && resolvedBasisCents >= 0 ? resolvedBasisCents : null;
  const feeCents = useMemo(
    () => validFeePercent ? calculateFeeCents(previewBasisCents, feePercent) : null,
    [feePercent, previewBasisCents, validFeePercent],
  );

  const saveFee = async (event: FormEvent) => {
    event.preventDefault();
    if (!validFeePercent) {
      setFeeError('Enter a percentage between 0 and 100.');
      return;
    }
    if (feeBasis === 'checkout_total' && order.totalCents === null) {
      setFeeError('This order has no purchase total. Choose a custom amount.');
      return;
    }
    if (feeBasis === 'custom_amount' && (customBasisCents === null || customBasisCents < 0 || !Number.isSafeInteger(customBasisCents))) {
      setFeeError('Enter a valid custom amount of zero or more.');
      return;
    }
    setFeeError('');
    try {
      const roundedPercent = Math.round(feePercent * 100) / 100;
      const input: UpdateOrderFeeInput = feeBasis === 'checkout_total'
        ? { feePercent: roundedPercent, feeBasis: 'checkout_total' }
        : { feePercent: roundedPercent, feeBasis: 'custom_amount', customBasisCents: customBasisCents! };
      await onFeeSave(order.id, input);
    } catch (error) {
      setFeeError(error instanceof Error ? error.message : 'Could not save this fee.');
    }
  };

  const copyTracking = async () => {
    if (order.trackingNumber) await navigator.clipboard.writeText(order.trackingNumber);
  };

  const saveOverride = async (event: FormEvent) => {
    event.preventDefault();
    setOverrideError('');
    try {
      await onOverrideSave(order.id, overrideStatus || null, overrideStatus ? overrideNote.trim() || null : null);
    } catch (error) {
      setOverrideError(error instanceof Error ? error.message : 'Could not save this status update.');
    }
  };

  return (
    <aside className="inspector" aria-label={`Order ${order.orderNumber}`}>
      <div className="inspector-heading">
        <div>
          <h2>Order #{order.orderNumber}</h2>
          <span className={`status-label ${order.status}`}>{titleCaseStatus(order.status)}</span>
        </div>
        <button className="icon-button bare" onClick={onClose} aria-label="Close order details"><X size={21} /></button>
      </div>

      <div className="inspector-store">
        <StoreMark store={order.store} />
        <div>
          <strong>{order.store}</strong>
          <span>{formatDateTime(order.orderedAt)}</span>
        </div>
      </div>

      <dl className="order-facts primary-facts">
        <div><dt>Purchase total</dt><dd>{formatMoney(order.totalCents, order.currency)}</dd></div>
        <div><dt>Items</dt><dd>{order.itemCount ?? '—'}</dd></div>
        <div><dt>Customer</dt><dd>{customerName}</dd></div>
      </dl>

      <section className="order-items-section" aria-labelledby="order-items-title">
        <div className="order-items-heading"><h3 id="order-items-title">Items purchased</h3><span>{order.itemCount ? `${order.itemCount} ${order.itemCount === 1 ? 'item' : 'items'}` : 'Details pending'}</span></div>
        {order.items?.length ? (
          <ul className="order-items-list">
            {order.items.map((item, index) => {
              const lineTotal = item.totalCents ?? (item.unitPriceCents === null ? null : item.unitPriceCents * item.quantity);
              return <li key={`${item.name}-${index}`}><span><strong>{item.name}</strong><small>Qty {item.quantity}{item.unitPriceCents !== null ? ` · ${formatMoney(item.unitPriceCents, order.currency)} each` : ''}</small></span><b>{formatMoney(lineTotal, order.currency)}</b></li>;
            })}
          </ul>
        ) : <p className="order-items-empty">Item details will appear after a confirmation email with line items is synchronized.</p>}
      </section>

      <form className="fee-section" onSubmit={saveFee}>
        <div className="fee-section-heading"><h3>Customer fee</h3><span>Per order</span></div>
        <div className="fee-control-grid">
          <label className="fee-input-label">
            <span>Fee percentage</span>
            <span className="fee-input-wrap"><input type="number" min="0" max="100" step="0.01" value={feeInput} onChange={(event) => setFeeInput(event.target.value)} aria-label="Customer fee percentage" /><b>%</b></span>
          </label>
          <label className="fee-input-label">
            <span>Apply percentage to</span>
            <select value={feeBasis} onChange={(event) => setFeeBasis(event.target.value as FeeBasis)}>
              <option value="checkout_total">Checkout purchase total</option>
              <option value="custom_amount">Custom amount</option>
            </select>
          </label>
          {feeBasis === 'custom_amount' ? (
            <label className="fee-input-label fee-custom-amount">
              <span>Custom fee basis</span>
              <span className="fee-input-wrap"><b>$</b><input type="number" min="0" step="0.01" inputMode="decimal" value={customBasisInput} onChange={(event) => setCustomBasisInput(event.target.value)} aria-label="Custom fee basis amount" /></span>
              <small>Use an expected sale, profit, or other agreed amount.</small>
            </label>
          ) : null}
        </div>
        <dl className="fee-breakdown">
          <div><dt>Fee basis</dt><dd>{formatMoney(previewBasisCents, order.currency)}</dd></div>
          <div><dt>Service fee ({validFeePercent ? formatPercent(feePercent) : '—'})</dt><dd>{formatMoney(feeCents, order.currency)}</dd></div>
        </dl>
        {feeError && <p className="fee-error" role="alert">{feeError}</p>}
        <button className="secondary-action fee-save-button" type="submit" disabled={savingFee}>{savingFee ? 'Saving…' : 'Save fee'}</button>
        <p className="fee-help">Only the service fee is invoiced. The retailer purchase was paid with the customer&apos;s card.</p>
      </form>

      <form className="override-section" onSubmit={saveOverride}>
        <div className="fee-section-heading"><h3>Manual status override</h3><span>{order.isManualOverride ? 'Active' : 'Automatic'}</span></div>
        <label className="override-label">
          <span>Status shown to customer</span>
          <select value={overrideStatus} onChange={(event) => setOverrideStatus(event.target.value as OrderStatus | '')} aria-label="Status shown to customer">
            <option value="">Use parsed status</option>
            <option value="confirmed">Confirmed</option>
            <option value="processing">Processing</option>
            <option value="shipped">Shipped</option>
            <option value="delivered">Delivered</option>
            <option value="cancelled">Cancelled</option>
          </select>
        </label>
        <label className="override-label"><span>Note (optional)</span><textarea value={overrideNote} onChange={(event) => setOverrideNote(event.target.value)} maxLength={240} placeholder="Add context for the customer" rows={3} /></label>
        {overrideError && <p className="fee-error" role="alert">{overrideError}</p>}
        <button className="secondary-action fee-save-button" type="submit" disabled={savingOverride}>{savingOverride ? 'Saving…' : 'Save status update'}</button>
        <p className="fee-help">This update is recorded separately from email parsing and is shown in the customer timeline.</p>
      </form>

      <dl className="order-facts shipment-facts">
        <div><dt>Carrier</dt><dd>{order.carrier ?? 'Not assigned'}</dd></div>
        <div>
          <dt>Tracking number</dt>
          <dd>
            {maskTracking(order.trackingNumber)}
            {order.trackingNumber && (
              <button className="copy-button" onClick={copyTracking} aria-label="Copy tracking number"><Copy size={15} /></button>
            )}
          </dd>
        </div>
        <div><dt>Expected delivery</dt><dd>{formatDate(order.expectedDelivery)}</dd></div>
      </dl>

      <section className="activity-section">
        <h3>Order activity</h3>
        <ol className="timeline">
          {order.events.map((event) => (
            <li key={event.id}>
              <span className="timeline-node" />
              <div>
                <strong>{event.label}</strong>
                <time>{formatDateTime(event.occurredAt)}</time>
                <p>{event.detail}</p>
              </div>
            </li>
          ))}
        </ol>
      </section>

      {order.trackingUrl && (
        <a className="inspector-link" href={order.trackingUrl} target="_blank" rel="noreferrer">
          View carrier tracking <ExternalLink size={16} />
        </a>
      )}
    </aside>
  );
}
