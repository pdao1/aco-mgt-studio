import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import CustomerPortalApp from './CustomerPortalApp';
import MarketingSite from './MarketingSite';
import SuperAdminView from './SuperAdminView';
import './styles.css';
import './themes.css';

const portalPrefix = '/portal/';
const isPortalRoute = window.location.pathname.startsWith(portalPrefix);
const portalToken = isPortalRoute
  ? decodeURIComponent(window.location.pathname.slice(portalPrefix.length).split('/')[0] ?? '')
  : null;
const isSuperAdminRoute = window.location.pathname === '/app/admin/super';
const isAppRoute = window.location.pathname === '/app' || window.location.pathname.startsWith('/app/');

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {isPortalRoute ? <CustomerPortalApp token={portalToken ?? ''} /> : isSuperAdminRoute ? <SuperAdminView /> : isAppRoute ? <App /> : <MarketingSite />}
  </StrictMode>,
);
