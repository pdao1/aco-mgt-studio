import { ShieldCheck } from 'lucide-react';

export default function SuperAdminView() {
  return <main className="reserved-screen"><ShieldCheck size={28} /><h1>Owner console reserved</h1><p>This route is reserved for the ACO Studio service owner.</p><a className="secondary-action" href="/app/dashboard">Return to operator sign in</a></main>;
}
