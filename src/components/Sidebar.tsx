import {
  Boxes,
  CircleDollarSign,
  LayoutDashboard,
  Settings,
  Users,
} from 'lucide-react';
import type { WorkspaceSummary } from '../types';

export type NavSection = 'overview' | 'customers' | 'billing' | 'settings';

interface SidebarProps {
  active: NavSection;
  workspace: WorkspaceSummary;
  onNavigate: (section: NavSection) => void;
  onLogout?: () => void;
}

const items = [
  { id: 'overview' as const, label: 'Overview', icon: LayoutDashboard },
  { id: 'customers' as const, label: 'Customers', icon: Users },
  { id: 'billing' as const, label: 'Billing', icon: CircleDollarSign },
  { id: 'settings' as const, label: 'Settings', icon: Settings },
];

export function Sidebar({ active, workspace, onNavigate, onLogout }: SidebarProps) {
  const displayName = workspace.settings.displayName || workspace.name;
  const initials = displayName.split(/\s+/).map((part) => part[0]).join('').slice(0, 2).toUpperCase();
  const statusLabel = workspace.status === 'active' ? 'Active' : workspace.status === 'provisioning' ? 'Provisioning' : 'Suspended';

  return (
    <aside className="app-sidebar" aria-label="Primary navigation">
      <button className="brand" onClick={() => onNavigate('overview')} aria-label={`${displayName} home`}>
        <span className="brand-mark">{workspace.settings.logoUrl ? <img src={workspace.settings.logoUrl} alt="" /> : <Boxes size={19} strokeWidth={2.2} />}</span>
        <span>{displayName}</span>
      </button>

      <nav className="primary-nav">
        {items.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            className={active === id ? 'nav-item active' : 'nav-item'}
            onClick={() => onNavigate(id)}
            aria-label={label}
            title={label}
            aria-current={active === id ? 'page' : undefined}
          >
            <Icon size={19} strokeWidth={1.8} />
            <span>{label}</span>
          </button>
        ))}
      </nav>

      <button className="operator-menu" onClick={onLogout} title={`${statusLabel} node group · Sign out`} aria-label={`Sign out of ${displayName}`}>
        <span className="operator-avatar">{initials}</span>
        <span className="operator-copy">
          <strong>{displayName}</strong>
          <small><i className={`sync-dot ${workspace.status === 'active' ? 'synced' : workspace.status === 'provisioning' ? 'syncing' : 'error'}`} /> {workspace.nodeGroupKey}</small>
        </span>
      </button>
    </aside>
  );
}
