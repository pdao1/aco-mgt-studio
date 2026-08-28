import { ExternalLink, Eye, EyeOff, LockKeyhole, X } from 'lucide-react';
import { FormEvent, useState } from 'react';
import type { ConnectCustomerInput } from '../types';

interface ConnectCustomerDrawerProps {
  onClose: () => void;
  onConnect: (input: ConnectCustomerInput) => Promise<void>;
}

export function ConnectCustomerDrawer({ onClose, onConnect }: ConnectCustomerDrawerProps) {
  const [showPassword, setShowPassword] = useState(false);
  const [name, setName] = useState('');
  const [gmailAddress, setGmailAddress] = useState('');
  const [appPassword, setAppPassword] = useState('');
  const [syncDays, setSyncDays] = useState(90);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError('');
    const normalizedPassword = appPassword.replace(/\s/g, '');
    if (!gmailAddress.trim().toLowerCase().endsWith('@gmail.com')) {
      setError('Enter a Gmail address ending in @gmail.com.');
      return;
    }
    if (normalizedPassword.length !== 16) {
      setError('Google app passwords contain 16 characters.');
      return;
    }
    setSubmitting(true);
    try {
      await onConnect({ name: name.trim(), gmailAddress: gmailAddress.trim(), appPassword: normalizedPassword, syncDays });
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not connect this inbox.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="drawer-layer" role="presentation">
      <button className="drawer-scrim" onClick={onClose} aria-label="Close connect customer drawer" />
      <aside className="connect-drawer" aria-labelledby="connect-title">
        <div className="drawer-heading">
          <h2 id="connect-title">Connect customer inbox</h2>
          <button className="icon-button bare" onClick={onClose} aria-label="Close"><X size={21} /></button>
        </div>

        <div className="security-note">
          <LockKeyhole size={20} />
          <p>Your connection is encrypted and secure. We never display or log your Gmail app password.</p>
        </div>

        <form onSubmit={submit} className="connect-form">
          <label>
            <span>Customer name</span>
            <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Enter customer name" autoFocus required />
          </label>
          <label>
            <span>Gmail address</span>
            <input type="email" value={gmailAddress} onChange={(event) => setGmailAddress(event.target.value)} placeholder="Enter Gmail address" required />
          </label>
          <label>
            <span>Gmail app password</span>
            <span className="password-input">
              <input
                type={showPassword ? 'text' : 'password'}
                value={appPassword}
                onChange={(event) => setAppPassword(event.target.value)}
                placeholder="•••• •••• •••• ••••"
                autoComplete="new-password"
                required
              />
              <button type="button" onClick={() => setShowPassword((visible) => !visible)} aria-label={showPassword ? 'Hide app password' : 'Show app password'}>
                {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
              </button>
            </span>
          </label>
          <label>
            <span>Sync history</span>
            <select value={syncDays} onChange={(event) => setSyncDays(Number(event.target.value))}>
              <option value={30}>Last 30 days</option>
              <option value={90}>Last 90 days</option>
              <option value={180}>Last 6 months</option>
              <option value={365}>Last year</option>
            </select>
          </label>

          <div className="password-help">
            <p>Use a 16-character Google app password. Your password is encrypted before storage.</p>
            <a href="https://support.google.com/accounts/answer/185833" target="_blank" rel="noreferrer">
              <ExternalLink size={14} /> How to create an app password
            </a>
          </div>

          {error && <p className="form-error" role="alert">{error}</p>}

          <div className="drawer-actions">
            <button type="button" className="secondary-action" onClick={onClose}>Cancel</button>
            <button type="submit" className="primary-action" disabled={submitting}>
              {submitting ? 'Verifying…' : 'Verify & connect'}
            </button>
          </div>
        </form>
      </aside>
    </div>
  );
}
