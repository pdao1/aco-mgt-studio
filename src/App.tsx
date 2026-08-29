import { AlertTriangle, ExternalLink, RefreshCw } from 'lucide-react';
import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { BillingView } from './components/BillingView';
import { AccessGate } from './components/AccessGate';
import { ConnectCustomerDrawer } from './components/ConnectCustomerDrawer';
import { CustomerRail } from './components/CustomerRail';
import { LoginScreen } from './components/LoginScreen';
import { OrderInspector } from './components/OrderInspector';
import { OrdersTable, type OrderFilter } from './components/OrdersTable';
import { OverviewView } from './components/OverviewView';
import { Sidebar, type NavSection } from './components/Sidebar';
import { SettingsView } from './components/SettingsView';
import { SummaryStrip } from './components/SummaryStrip';
import { ApiError, api } from './lib/api';
import { relativeTime } from './lib/format';
import { filterOrders } from './lib/orders';
import type { BillingPayload, ConnectCustomerInput, DashboardPayload, Order, UpdateOrderFeeInput, WorkspaceSettings } from './types';

export default function App() {
  const [data, setData] = useState<DashboardPayload | null>(null);
  const [billing, setBilling] = useState<BillingPayload>({ invoices: [] });
  const [needsLogin, setNeedsLogin] = useState(false);
  const [needsAccess, setNeedsAccess] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [selectedCustomerId, setSelectedCustomerId] = useState('');
  const [selectedOrderId, setSelectedOrderId] = useState<string | null>(null);
  const [filter, setFilter] = useState<OrderFilter>('all');
  const [query, setQuery] = useState('');
  const [retailer, setRetailer] = useState('');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [nav, setNav] = useState<NavSection>('overview');
  const [savingFeeOrderId, setSavingFeeOrderId] = useState<string | null>(null);
  const [savingOverrideOrderId, setSavingOverrideOrderId] = useState<string | null>(null);
  const [toast, setToast] = useState('');

  const refresh = async () => {
    try {
      const [payload, billingPayload] = await Promise.all([api.dashboard(), api.billing()]);
      setData(payload);
      setBilling(billingPayload);
      setNeedsLogin(false);
      setNeedsAccess(false);
      setLoadError('');
      setSelectedCustomerId((current) => payload.customers.some((customer) => customer.id === current)
        ? current
        : (payload.customers[0]?.id ?? ''));
    } catch (error) {
      if (error instanceof ApiError && error.status === 402) {
        setNeedsAccess(true);
      } else if (error instanceof ApiError && error.status === 401) {
        setNeedsLogin(true);
      } else {
        setLoadError(error instanceof Error ? error.message : 'ACO Studio could not load the workspace.');
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void refresh(); }, []);

  useEffect(() => {
    const mobile = window.matchMedia('(max-width: 840px)');
    const closeInspectorOnMobile = (event: MediaQueryListEvent | MediaQueryList) => {
      if (event.matches) setSelectedOrderId(null);
    };
    closeInspectorOnMobile(mobile);
    mobile.addEventListener('change', closeInspectorOnMobile);
    return () => mobile.removeEventListener('change', closeInspectorOnMobile);
  }, []);

  useEffect(() => {
    if (!data?.customers.some((customer) => customer.syncStatus === 'syncing')) return;
    const timer = window.setInterval(() => void refresh(), 10_000);
    return () => window.clearInterval(timer);
  }, [data]);

  const selectedCustomer = data?.customers.find((customer) => customer.id === selectedCustomerId) ?? null;
  const customerOrders = useMemo(
    () => data?.orders.filter((order) => order.customerId === selectedCustomerId) ?? [],
    [data, selectedCustomerId],
  );
  const retailerOrders = useMemo(() => filterOrders(customerOrders, { retailer }), [customerOrders, retailer]);
  const filteredOrders = useMemo(
    () => filterOrders(customerOrders, { status: filter, query, retailer }),
    [customerOrders, filter, query, retailer],
  );
  const selectedOrder = customerOrders.find((order) => order.id === selectedOrderId) ?? null;

  useEffect(() => {
    if (selectedOrderId && !filteredOrders.some((order) => order.id === selectedOrderId)) setSelectedOrderId(null);
  }, [filteredOrders, selectedOrderId]);

  const selectCustomer = (id: string) => {
    setSelectedCustomerId(id);
    // Selecting a customer should open their workspace, not an arbitrary
    // receipt. Orders remain available from the table and overview activity.
    setSelectedOrderId(null);
    setFilter('all');
    setQuery('');
    setRetailer('');
    setNav('customers');
  };

  const openCustomerOrder = (customerId: string, orderId?: string) => {
    setSelectedCustomerId(customerId);
    setSelectedOrderId(orderId ?? null);
    setFilter('all');
    setQuery('');
    setRetailer('');
    setNav('customers');
  };

  const selectOrder = (order: Order) => setSelectedOrderId(order.id);

  const updateOrderFee = async (orderId: string, input: UpdateOrderFeeInput) => {
    setSavingFeeOrderId(orderId);
    try {
      const update = await api.updateOrderFee(orderId, input);
      setData((current) => current && ({
        ...current,
        orders: current.orders.map((order) => order.id === orderId ? { ...order, ...update } : order),
      }));
      // Refresh invoice snapshots too: a draft line and its aggregate total
      // are recalculated in the same server transaction as this fee edit.
      await refresh();
      setToast('Fee updated and reflected in the customer portal.');
      window.setTimeout(() => setToast(''), 4200);
    } finally {
      setSavingFeeOrderId(null);
    }
  };

  const updateOrderOverride = async (orderId: string, status: Order['status'] | null, note: string | null) => {
    setSavingOverrideOrderId(orderId);
    try {
      await api.updateOrderOverride(orderId, status, note);
      await refresh();
      setToast('Manual status update is now visible to the customer.');
      window.setTimeout(() => setToast(''), 4200);
    } finally {
      setSavingOverrideOrderId(null);
    }
  };

  const sharePortal = async () => {
    if (!selectedCustomer || toast) return;
    setToast('Preparing customer link…');
    try {
      const { url } = await api.createPortalLink(selectedCustomer.id);
      try {
        await navigator.clipboard.writeText(url);
        setToast('Static customer portal link copied');
      } catch {
        setToast(url);
      }
    } catch (error) {
      setToast(error instanceof Error ? error.message : 'Could not create a customer link.');
    }
    window.setTimeout(() => setToast(''), 4200);
  };

  const navigate = (section: NavSection) => {
    setNav(section);
    if (section !== 'customers') setSelectedOrderId(null);
    if (section === 'customers') {
      setFilter('all');
      setQuery('');
      setRetailer('');
    }
  };

  const activateService = async (serial: string) => {
    await api.activateService(serial);
    setNeedsAccess(false);
    setLoading(true);
    await refresh();
  };

  const saveSettings = async (settings: WorkspaceSettings) => {
    const result = await api.updateSettings(settings);
    setData((current) => current ? { ...current, workspace: { ...current.workspace, settings: result.settings } } : current);
  };

  const connectCustomer = async (input: ConnectCustomerInput) => {
    const { customer } = await api.connectCustomer(input);
    await refresh();
    setSelectedCustomerId(customer.id);
    setSelectedOrderId(null);
    setFilter('all');
    setQuery('');
    setRetailer('');
    setNav('customers');
    setToast('Customer connected. The first inbox sync is starting.');
    window.setTimeout(() => setToast(''), 4200);
  };

  const syncInbox = async () => {
    if (!selectedCustomer || selectedCustomer.syncStatus === 'syncing') return;
    setData((current) => current && ({
      ...current,
      customers: current.customers.map((customer) => customer.id === selectedCustomer.id
        ? { ...customer, syncStatus: 'syncing' }
        : customer),
    }));
    try {
      await api.syncCustomer(selectedCustomer.id);
    } catch (error) {
      setData((current) => current && ({
        ...current,
        customers: current.customers.map((customer) => customer.id === selectedCustomer.id
          ? { ...customer, syncStatus: 'error', syncMessage: error instanceof Error ? error.message : 'Sync failed.' }
          : customer),
      }));
    }
  };

  const createInvoice = async (customerId: string, orderIds: string[]) => {
    await api.createInvoice(customerId, { orderIds, dueDays: 7 });
    await refresh();
    setToast('Draft invoice created. Issue it with Stripe when you are ready.');
    window.setTimeout(() => setToast(''), 4200);
  };

  const issueInvoice = async (invoiceId: string) => {
    await api.issueInvoice(invoiceId);
    await refresh();
    setToast('Invoice issued. The hosted Stripe payment link is ready.');
    window.setTimeout(() => setToast(''), 4200);
  };

  const login = async (password: string) => {
    await api.login(password);
    setNeedsLogin(false);
    setLoading(true);
    await refresh();
  };

  const logout = async () => {
    await api.logout();
    setData(null);
    setBilling({ invoices: [] });
    setNeedsLogin(true);
  };

  if (needsAccess) return <AccessGate onActivate={activateService} />;
  if (needsLogin) return <LoginScreen onLogin={login} />;
  if (loading) return <LoadingScreen />;
  if (loadError || !data) return <WorkspaceState detail={loadError || 'The workspace is unavailable.'} onRetry={() => { setLoading(true); setLoadError(''); void refresh(); }} />;

  return (
    <main className={`app-shell ${selectedOrder && nav === 'customers' ? 'has-inspector' : ''}`} style={{ '--blue': data.workspace.settings.accentColor } as CSSProperties}>
      <Sidebar active={nav} workspace={data.workspace} onNavigate={navigate} onLogout={logout} />
      <CustomerRail
        customers={data.customers}
        selectedId={selectedCustomerId}
        onSelect={selectCustomer}
        onAdd={() => setDrawerOpen(true)}
      />

      <section className={`workspace ${nav}-workspace`}>
        {nav === 'overview' && <OverviewView customers={data.customers} orders={data.orders} onOpenCustomer={openCustomerOrder} />}
        {nav === 'billing' && <BillingView customer={selectedCustomer} orders={customerOrders} invoices={billing.invoices} onCreateInvoice={createInvoice} onIssueInvoice={issueInvoice} />}
        {nav === 'settings' && <SettingsView settings={data.workspace.settings} onSave={saveSettings} />}
        {nav === 'customers' && (selectedCustomer ? (
          <>
            <header className="workspace-header">
              <div className="workspace-title-block">
                <h1>{selectedCustomer.name}</h1>
                <span className="mobile-email">{selectedCustomer.emailMasked}</span>
                {(selectedCustomer.syncStatus === 'error' || selectedCustomer.syncStatus === 'warning') && (
                  <div className={`sync-alert ${selectedCustomer.syncStatus}`} role="alert">
                    <AlertTriangle size={15} aria-hidden="true" />
                    <span className="sync-alert-copy">
                      <strong>{selectedCustomer.syncStatus === 'error' ? 'Sync error' : 'Sync warning'}</strong>
                      <span>{selectedCustomer.syncMessage ?? (selectedCustomer.syncStatus === 'error'
                        ? 'The inbox sync failed. Check the Gmail connection and try again.'
                        : 'Some inbox messages could not be processed. Review the mailbox and sync again.')}</span>
                    </span>
                  </div>
                )}
              </div>
              <div className="sync-control">
                <span className="last-sync">
                  <span>Last sync</span>
                  <strong><i className={`sync-dot ${selectedCustomer.syncStatus}`} /> {relativeTime(selectedCustomer.lastSyncedAt)}</strong>
                </span>
                <button className="secondary-action portal-action" onClick={() => void sharePortal()} disabled={Boolean(toast)} title="Copy a secure customer portal link">
                  <ExternalLink size={16} />
                  <span>Customer portal</span>
                </button>
                <button className="primary-action sync-button" onClick={() => void syncInbox()} disabled={selectedCustomer.syncStatus === 'syncing'}>
                  <RefreshCw size={17} className={selectedCustomer.syncStatus === 'syncing' ? 'spin' : ''} />
                  {selectedCustomer.syncStatus === 'syncing' ? 'Syncing…' : 'Sync inbox'}
                </button>
              </div>
            </header>

            <SummaryStrip orders={retailerOrders} activeStatus={filter} onSelect={setFilter} />
            <OrdersTable
              orders={filteredOrders}
              allOrders={customerOrders}
              filter={filter}
              query={query}
              retailer={retailer}
              selectedId={selectedOrderId}
              onFilter={setFilter}
              onQuery={setQuery}
              onRetailer={setRetailer}
              onSelect={selectOrder}
            />
          </>
        ) : (
          <section className="first-customer-empty">
            <h1>Connect your first customer</h1>
            <p>Add a Gmail inbox to begin collecting confirmed orders and shipment updates.</p>
            <button className="primary-action" onClick={() => setDrawerOpen(true)}>Add customer</button>
          </section>
        ))}
      </section>

      {selectedOrder && selectedCustomer && nav === 'customers' && (
        <OrderInspector
          order={selectedOrder}
          customerName={selectedCustomer.name}
          onClose={() => setSelectedOrderId(null)}
          onFeeSave={updateOrderFee}
          onOverrideSave={updateOrderOverride}
          savingFee={savingFeeOrderId === selectedOrder.id}
          savingOverride={savingOverrideOrderId === selectedOrder.id}
        />
      )}

      {drawerOpen && <ConnectCustomerDrawer onClose={() => setDrawerOpen(false)} onConnect={connectCustomer} />}
      {toast && <div className="app-toast" role="status">{toast}</div>}
    </main>
  );
}

function LoadingScreen() {
  return <main className="loading-screen"><span className="loading-mark" /><strong>Loading ACO Studio</strong></main>;
}

function WorkspaceState({ detail, onRetry }: { detail: string; onRetry: () => void }) {
  return <main className="loading-screen workspace-error"><strong>ACO Studio could not load</strong><p>{detail}</p><button className="primary-action" onClick={onRetry}>Try again</button></main>;
}
