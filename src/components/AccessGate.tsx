import { KeyRound } from 'lucide-react';
import { FormEvent, useState } from 'react';

export function AccessGate({ onActivate }: { onActivate: (serial: string) => Promise<void> }) {
  const [serial, setSerial] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError('');
    try {
      await onActivate(serial);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The service serial could not be verified.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="login-screen">
      <section className="login-panel">
        <div className="login-brand"><KeyRound size={21} /> ACO Studio</div>
        <div className="login-copy">
          <KeyRound size={24} />
          <h1>Activate your service</h1>
          <p>Enter the serial supplied with your ACO Studio subscription.</p>
        </div>
        <form onSubmit={submit}>
          <label>
            <span>Service serial</span>
            <input value={serial} onChange={(event) => setSerial(event.target.value)} autoComplete="off" autoFocus required />
          </label>
          {error && <p className="form-error" role="alert">{error}</p>}
          <button className="primary-action" disabled={submitting}>{submitting ? 'Verifying…' : 'Continue'}</button>
        </form>
      </section>
    </main>
  );
}
