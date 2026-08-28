import type { OrderStatus } from '../types.js';

export const formatMoney = (cents: number | null, currency = 'USD') => {
  if (cents === null) return '—';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(cents / 100);
};

export const formatPercent = (value: number) => `${Number.isInteger(value) ? value.toFixed(0) : value.toFixed(2).replace(/0+$/, '').replace(/\.$/, '')}%`;

export const calculateFeeCents = (basisCents: number | null, feePercent: number) =>
  basisCents === null ? null : Math.round(basisCents * feePercent / 100);

export const formatDate = (value: string | null, options?: Intl.DateTimeFormatOptions) => {
  if (!value) return '—';
  return new Intl.DateTimeFormat('en-US', options ?? { month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(value));
};

export const formatDateTime = (value: string) =>
  new Intl.DateTimeFormat('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
  }).format(new Date(value));

export const relativeTime = (value: string | null) => {
  if (!value) return 'Never';
  const seconds = Math.round((new Date(value).getTime() - Date.now()) / 1000);
  const formatter = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  if (Math.abs(seconds) < 60) return 'Just now';
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return formatter.format(minutes, 'minute');
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return formatter.format(hours, 'hour');
  return formatter.format(Math.round(hours / 24), 'day');
};

export const titleCaseStatus = (status: OrderStatus) =>
  status.charAt(0).toUpperCase() + status.slice(1);

export const maskTracking = (tracking: string | null) => {
  if (!tracking) return '—';
  if (tracking.length <= 9) return tracking;
  return `${tracking.slice(0, 8)}••••${tracking.slice(-4)}`;
};
