import { Check, LockKeyhole, Palette, Save } from 'lucide-react';
import { FormEvent, useEffect, useState } from 'react';
import type { WorkspaceSettings } from '../types';
import { WORKSPACE_THEMES } from '../lib/themes';

interface SettingsViewProps {
  settings: WorkspaceSettings;
  workspaceSlug: string;
  onSave: (settings: WorkspaceSettings) => Promise<void>;
  onChangePassword: (currentPassword: string, newPassword: string) => Promise<unknown>;
}

export function SettingsView({ settings, workspaceSlug, onSave, onChangePassword }: SettingsViewProps) {
  const [form, setForm] = useState(settings);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => setForm(settings), [settings]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setSaved(false);
    setError('');
    try {
      await onSave(form);
      setSaved(true);
      window.setTimeout(() => setSaved(false), 3000);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Settings could not be saved.');
    } finally {
      setSaving(false);
    }
  };

  return <section className="settings-view" aria-label="Workspace settings">
    <header className="settings-header"><div><h1>Settings</h1><p>Your company, your workspace. Changes apply only to this ACO.</p></div><span className="settings-scope"><Palette size={16} /> This workspace only</span></header>
    <form className="settings-panel" onSubmit={submit}>
      <h2>Company & appearance</h2>
      <div className="settings-form-grid">
        <label className="settings-wide"><span>ACO Company Name</span><input value={form.displayName} onChange={(event) => { setSaved(false); setForm({ ...form, displayName: event.target.value }); }} maxLength={120} required pattern=".*\S.*" /><small>Shown in the top-left corner, your customer portal, and new invoices.</small></label>
        <div className="settings-wide settings-workspace-id"><span>Workspace ID <strong>{workspaceSlug}</strong></span><a href={`/app/workspaces/${encodeURIComponent(workspaceSlug)}`}>Workspace sign-in link</a></div>
        <fieldset className="settings-wide theme-picker"><legend>Theme</legend><p>Four light and four dark themes, shared with your customer portal. Save to apply.</p>
          {(['light', 'dark'] as const).map((mode) => <div className="theme-group" key={mode}><h3>{mode === 'light' ? 'Light themes' : 'Dark themes'}</h3><div className="theme-options">
            {WORKSPACE_THEMES.filter((theme) => theme.mode === mode).map((theme) => <label className={`theme-option ${form.theme === theme.id ? 'selected' : ''}`} key={theme.id}>
              <input type="radio" name="theme" value={theme.id} checked={form.theme === theme.id} onChange={() => { setSaved(false); setForm({ ...form, theme: theme.id, accentColor: theme.accent }); }} />
              <span className="theme-preview" aria-hidden="true" style={{ background: theme.background }}><span className="theme-preview-nav" style={{ background: theme.accent }} /><span className="theme-preview-content" style={{ background: theme.surface }}><i style={{ background: theme.accent }} /><i style={{ background: theme.accent }} /><i style={{ background: theme.accent }} /></span></span>
              <span className="theme-option-name">{theme.name}{form.theme === theme.id && <Check size={14} aria-hidden="true" />}</span>
            </label>)}
          </div></div>)}
        </fieldset>
        <label><span>Logo URL <small>HTTPS image</small></span><input type="url" value={form.logoUrl ?? ''} onChange={(event) => setForm({ ...form, logoUrl: event.target.value || null })} placeholder="https://…" /></label>
        <label><span>Accent color</span><input type="color" value={form.accentColor} onChange={(event) => setForm({ ...form, accentColor: event.target.value })} /></label>
        <label><span>Seller notification email</span><input type="email" value={form.notificationSellerEmail ?? ''} onChange={(event) => setForm({ ...form, notificationSellerEmail: event.target.value || null })} placeholder="you@example.com" /></label>
        <label className="settings-wide"><span>Venmo payment URL <small>HTTPS business link</small></span><input type="url" value={form.venmoPaymentUrl ?? ''} onChange={(event) => setForm({ ...form, venmoPaymentUrl: event.target.value || null })} placeholder="https://venmo.com/…" /></label>
      </div>
      <div className="settings-actions"><span className="settings-note" role="status">{saved ? 'Workspace settings saved.' : 'Issued invoices keep their original company name.'}</span><button className="primary-action" disabled={saving || !form.displayName.trim()}>{saved ? <><Check size={16} /> Saved</> : <><Save size={16} /> {saving ? 'Saving…' : 'Save settings'}</>}</button></div>
      {error && <p className="form-error" role="alert">{error}</p>}
    </form>
    <PasswordSettings onChangePassword={onChangePassword} />
  </section>;
}

function PasswordSettings({ onChangePassword }: Pick<SettingsViewProps, 'onChangePassword'>) {
  const [current, setCurrent] = useState('');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(''); setSaved(false);
    if (password !== confirmation) { setError('The new passwords do not match.'); return; }
    setBusy(true);
    try {
      await onChangePassword(current, password);
      setCurrent(''); setPassword(''); setConfirmation(''); setSaved(true);
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'Password could not be changed.'); }
    finally { setBusy(false); }
  };
  return <form className="settings-panel password-settings" onSubmit={submit}>
    <h2><LockKeyhole size={17} /> Workspace password</h2><p>Only operators in this workspace use this password. Changing it signs out other sessions.</p>
    <div className="settings-form-grid">
      <label className="settings-wide"><span>Current password</span><input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} maxLength={512} required /></label>
      <label><span>New password <small>12 characters minimum</small></span><input type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} minLength={12} maxLength={512} required /></label>
      <label><span>Confirm new password</span><input type="password" autoComplete="new-password" value={confirmation} onChange={(e) => setConfirmation(e.target.value)} minLength={12} maxLength={512} required /></label>
    </div>
    <div className="settings-actions"><span className="settings-note" role="status">{saved ? 'Password changed. Other sessions must sign in again.' : 'Your current session will stay signed in.'}</span><button className="primary-action" disabled={busy}>{busy ? 'Updating…' : 'Update password'}</button></div>
    {error && <p className="form-error" role="alert">{error}</p>}
  </form>;
}
