import { Boxes, LockKeyhole } from 'lucide-react';
import { FormEvent, useState } from 'react';

interface LoginScreenProps {
  onLogin: (password: string, workspaceSlug: string, companyName?: string) => Promise<void>;
}

export function LoginScreen({ onLogin }: LoginScreenProps) {
  const initialSlug = window.location.pathname.match(/^\/app\/workspaces\/([^/]+)/)?.[1] ?? '';
  const [workspaceSlug, setWorkspaceSlug] = useState(decodeURIComponent(initialSlug));
  const [companyName, setCompanyName] = useState('');
  const [creating, setCreating] = useState(false);
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (creating && password !== confirmPassword) { setError('The passwords do not match.'); return; }
    setSubmitting(true);
    setError('');
    try { await onLogin(password, workspaceSlug.trim().toLowerCase(), creating ? companyName.trim() : undefined); }
    catch (caught) { setError(caught instanceof Error ? caught.message : 'Sign in failed.'); }
    finally { setSubmitting(false); }
  };

  return <main className="login-screen"><section className="login-panel">
    <div className="login-brand"><Boxes size={21} /> ACO Studio</div>
    <div className="login-copy"><LockKeyhole size={24} /><h1>{creating ? 'Create your workspace' : 'Operator sign in'}</h1>
      <p>{creating ? 'Set up a private workspace for your ACO company.' : 'Sign in with your company’s workspace ID and password.'}</p></div>
    <form onSubmit={submit}>
      {creating && <label><span>ACO Company Name</span><input value={companyName} onChange={(e) => setCompanyName(e.target.value)} maxLength={120} required autoComplete="organization" /></label>}
      <label><span>Workspace ID</span><input value={workspaceSlug} onChange={(e) => setWorkspaceSlug(e.target.value.toLowerCase())} maxLength={80} pattern="[a-z0-9]+(-[a-z0-9]+)*" placeholder={creating ? 'your-company' : 'e.g. your-company or default'} required autoComplete="username" />
        <small>Lowercase letters, numbers, and hyphens. Existing installations use “default” unless configured otherwise.</small></label>
      <label><span>Workspace password</span><input type="password" value={password} onChange={(e) => setPassword(e.target.value)} minLength={creating ? 12 : undefined} maxLength={512} autoComplete={creating ? 'new-password' : 'current-password'} required /></label>
      {creating && <label><span>Confirm password</span><input type="password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} minLength={12} maxLength={512} autoComplete="new-password" required /></label>}
      {error && <p className="form-error" role="alert">{error}</p>}
      <button className="primary-action" disabled={submitting}>{submitting ? 'Please wait…' : creating ? 'Create workspace' : 'Sign in'}</button>
    </form>
    <button type="button" className="login-switch" disabled={submitting} onClick={() => { setCreating(!creating); setPassword(''); setConfirmPassword(''); setError(''); }}>{creating ? 'Already have a workspace? Sign in' : 'New company? Create a workspace'}</button>
  </section></main>;
}
