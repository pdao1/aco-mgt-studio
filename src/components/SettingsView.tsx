import { Check, Palette, Save } from 'lucide-react';
import { FormEvent, useEffect, useState } from 'react';
import type { WorkspaceSettings } from '../types';

interface SettingsViewProps {
  settings: WorkspaceSettings;
  onSave: (settings: WorkspaceSettings) => Promise<void>;
}

export function SettingsView({ settings, onSave }: SettingsViewProps) {
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
    <header className="settings-header"><div><h1>Settings</h1><p>Customize the workspace customers see in their portal.</p></div><span className="settings-scope"><Palette size={16} /> This ACO only</span></header>
    <form className="settings-panel" onSubmit={submit}>
      <div className="settings-form-grid">
        <label><span>Dashboard name</span><input value={form.displayName} onChange={(event) => setForm({ ...form, displayName: event.target.value })} maxLength={120} required /></label>
        <label><span>Logo URL <small>HTTPS image</small></span><input type="url" value={form.logoUrl ?? ''} onChange={(event) => setForm({ ...form, logoUrl: event.target.value || null })} placeholder="https://…" /></label>
        <label><span>Accent color</span><input type="color" value={form.accentColor} onChange={(event) => setForm({ ...form, accentColor: event.target.value })} /></label>
        <label><span>Seller notification email</span><input type="email" value={form.notificationSellerEmail ?? ''} onChange={(event) => setForm({ ...form, notificationSellerEmail: event.target.value || null })} placeholder="you@example.com" /></label>
        <label className="settings-wide"><span>Venmo payment URL <small>HTTPS business link</small></span><input type="url" value={form.venmoPaymentUrl ?? ''} onChange={(event) => setForm({ ...form, venmoPaymentUrl: event.target.value || null })} placeholder="https://venmo.com/…" /></label>
      </div>
      <div className="settings-actions"><span className="settings-note">Logo, color, payment, and notification settings apply to this node group.</span><button className="primary-action" disabled={saving}>{saved ? <><Check size={16} /> Saved</> : <><Save size={16} /> {saving ? 'Saving…' : 'Save settings'}</>}</button></div>
      {error && <p className="form-error" role="alert">{error}</p>}
    </form>
  </section>;
}
