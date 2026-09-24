import { Check, Download, Palette, Save } from 'lucide-react';
import { FormEvent, useEffect, useState } from 'react';
import type { WorkspaceSettings } from '../types';
import { WORKSPACE_THEMES } from '../lib/themes';

interface SettingsViewProps {
  settings: WorkspaceSettings;
  workspaceSlug: string;
  onSave: (settings: WorkspaceSettings, workspaceSlug:string) => Promise<void>;
}

export function SettingsView({ settings, workspaceSlug, onSave }: SettingsViewProps) {
  const [form, setForm] = useState(settings);
  const [slug,setSlug]=useState(workspaceSlug);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => setForm(settings), [settings]);
  useEffect(() => setSlug(workspaceSlug), [workspaceSlug]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setSaved(false);
    setError('');
    try {
      await onSave(form,slug);
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
        <label className="settings-wide"><span>Custom workspace path</span><input value={slug} onChange={event=>{setSaved(false);setSlug(event.target.value.toLowerCase());}} required maxLength={80} pattern="[a-z0-9]+(-[a-z0-9]+)*" /><small>ordertracker.pro/app/workspaces/{slug} · Letters, numbers, and hyphens. Discord remembers this destination for you; it is not a login credential.</small></label>
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
    <section className="settings-panel parser-feedback-settings">
      <h2>Parser feedback</h2>
      <p>Hide or restore item rows from order details to build a workspace-scoped correction set. Download the redacted JSONL when you want to review or run offline evaluations.</p>
      <a className="secondary-action" href="/api/parser-feedback/export"><Download size={16} /> Download feedback JSONL</a>
    </section>
    <section className="settings-panel"><h2>Login & license</h2><p>Your ACO license is linked to Discord. Use Discord to sign in; no workspace password is required.</p><a href="https://whop.com/@me/settings/memberships/" target="_blank" rel="noreferrer">Manage your Whop membership</a></section>
  </section>;
}
