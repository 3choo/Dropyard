import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate, useParams } from 'react-router';
import { api, errMsg } from '../../api/client';
import { useAuth } from '../../auth/AuthProvider';
import { Button, Input } from '../../components/ui';

function AuthLayout({ title, sub, children }: { title: string; sub: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-sm">
        <div className="mb-7 flex items-center gap-2.5">
          <svg width="26" height="26" viewBox="0 0 32 32" aria-hidden>
            <rect width="32" height="32" rx="7" fill="#C9F24F" />
            <path d="M9 11l6 5-6 5" stroke="#131608" strokeWidth="3" fill="none" strokeLinecap="round" strokeLinejoin="round" />
            <rect x="17" y="19" width="7" height="3" rx="1.5" fill="#131608" />
          </svg>
          <span className="text-[17px] font-semibold tracking-[-0.02em]">gitctx</span>
        </div>
        <h1 className="text-[18px] font-semibold tracking-[-0.01em]">{title}</h1>
        <p className="mb-5 mt-1 text-[13px] leading-relaxed text-ink-2">{sub}</p>
        {children}
      </div>
    </div>
  );
}

function Err({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p className="mt-3 rounded-lg border border-danger/30 bg-danger-dim/60 px-3 py-2 text-[12.5px] leading-relaxed text-danger">
      {message}
    </p>
  );
}

export function LoginPage() {
  const { refresh } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) });
      await refresh();
      navigate('/', { replace: true });
    } catch (err) {
      setError(errMsg(err, 'Sign in failed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthLayout title="Sign in" sub="Your team's private release hub for the FiveM server.">
      <form onSubmit={submit} className="space-y-3">
        <Input
          type="email"
          required
          autoComplete="email"
          placeholder="you@team.gg"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <Input
          type="password"
          required
          autoComplete="current-password"
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <Button type="submit" variant="primary" className="h-9 w-full" loading={busy}>
          Sign in
        </Button>
        <Err message={error} />
      </form>
    </AuthLayout>
  );
}

export function SetupPage() {
  const { refresh } = useAuth();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('/api/auth/setup', { method: 'POST', body: JSON.stringify({ name, email, password }) });
      await refresh();
      navigate('/', { replace: true });
    } catch (err) {
      setError(errMsg(err, 'Setup failed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthLayout
      title="Create the first admin"
      sub="Fresh install. This one-time account owns the instance — you can invite the rest of the team afterwards."
    >
      <form onSubmit={submit} className="space-y-3">
        <Input required placeholder="Your name" value={name} onChange={(e) => setName(e.target.value)} />
        <Input
          type="email"
          required
          autoComplete="email"
          placeholder="you@team.gg"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <Input
          type="password"
          required
          autoComplete="new-password"
          minLength={10}
          placeholder="Password (min 10 chars)"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <Button type="submit" variant="primary" className="h-9 w-full" loading={busy}>
          Create admin account
        </Button>
        <Err message={error} />
      </form>
    </AuthLayout>
  );
}

export function InvitePage() {
  const { code } = useParams<{ code: string }>();
  const { refresh, user } = useAuth();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (user) navigate('/', { replace: true });
  }, [user, navigate]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('/api/auth/accept', {
        method: 'POST',
        body: JSON.stringify({ code, name, password, email: email || undefined }),
      });
      await refresh();
      navigate('/', { replace: true });
    } catch (err) {
      setError(errMsg(err, 'Could not accept the invite'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthLayout
      title="Join your team"
      sub="You were invited to this gitctx instance. Pick your login — email only if the invite didn't pin one."
    >
      <form onSubmit={submit} className="space-y-3">
        <Input required placeholder="Your name" value={name} onChange={(e) => setName(e.target.value)} />
        <Input
          type="email"
          placeholder="Email (if not preassigned)"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <Input
          type="password"
          required
          autoComplete="new-password"
          minLength={10}
          placeholder="Password (min 10 chars)"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <Button type="submit" variant="primary" className="h-9 w-full" loading={busy}>
          Create account
        </Button>
        <Err message={error} />
      </form>
    </AuthLayout>
  );
}
