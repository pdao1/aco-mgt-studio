import { lazy, StrictMode, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import './themes.css';

const App = lazy(() => import('./App'));
const CustomerPortalApp = lazy(() => import('./CustomerPortalApp'));
const MarketingSite = lazy(() => import('./MarketingSite'));
const SuperAdminView = lazy(() => import('./SuperAdminView'));
const SoloBuyerApp = lazy(() => import('./solo/SoloBuyerApp'));
const IdentityGate = lazy(() => import('./components/IdentityGate'));

const portalPrefix = '/portal/';
const isPortalRoute = window.location.pathname.startsWith(portalPrefix);
const portalToken = isPortalRoute
  ? decodeURIComponent(window.location.pathname.slice(portalPrefix.length).split('/')[0] ?? '')
  : null;
const isSuperAdminRoute = window.location.pathname === '/app/admin/super';
const isAppRoute = window.location.pathname === '/app' || window.location.pathname.startsWith('/app/');
const isSoloRoute = window.location.pathname === '/customer' || window.location.pathname.startsWith('/customer/');

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Suspense fallback={<main className="loading-screen">Loading…</main>}>
    {window.location.pathname === '/login' ? <IdentityGate/> : isSoloRoute ? <IdentityGate product="solo"><SoloBuyerApp /></IdentityGate> : isPortalRoute ? <CustomerPortalApp token={portalToken ?? ''} /> : isSuperAdminRoute ? <SuperAdminView /> : isAppRoute ? <IdentityGate product="aco"><App /></IdentityGate> : <MarketingSite />}
    </Suspense>
  </StrictMode>,
);
