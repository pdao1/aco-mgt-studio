import { Plus, Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { Customer } from '../types';
import { relativeTime } from '../lib/format';

interface CustomerRailProps {
  customers: Customer[];
  selectedId: string;
  onSelect: (id: string) => void;
  onAdd: () => void;
}

const syncLabels = {
  synced: 'Synced',
  syncing: 'Syncing',
  warning: 'Sync warning',
  error: 'Sync error',
};

export function CustomerRail({ customers, selectedId, onSelect, onAdd }: CustomerRailProps) {
  const [query, setQuery] = useState('');
  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return customers;
    return customers.filter((customer) => customer.name.toLowerCase().includes(normalized));
  }, [customers, query]);

  return (
    <aside className="customer-rail" aria-label="Customers">
      <div className="rail-heading">
        <h2>Customers</h2>
        <button className="icon-button" onClick={onAdd} aria-label="Add customer">
          <Plus size={20} />
        </button>
      </div>

      <label className="search-field customer-search">
        <Search size={17} aria-hidden="true" />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search customers"
          aria-label="Search customers"
        />
      </label>

      <div className="customer-list">
        {filtered.map((customer) => (
          <button
            key={customer.id}
            className={selectedId === customer.id ? 'customer-row selected' : 'customer-row'}
            onClick={() => onSelect(customer.id)}
          >
            <strong>{customer.name}</strong>
            <span className="sync-line">
              <span className={`sync-dot ${customer.syncStatus}`} />
              <span>{syncLabels[customer.syncStatus]}</span>
              <time>{relativeTime(customer.lastSyncedAt)}</time>
            </span>
          </button>
        ))}
        {filtered.length === 0 && <p className="empty-list">No customers match “{query}”.</p>}
      </div>

      <div className="rail-footer">
        <button className="secondary-action add-customer-button" onClick={onAdd}>
          <Plus size={17} /> Add customer
        </button>
      </div>
    </aside>
  );
}
