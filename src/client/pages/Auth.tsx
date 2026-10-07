import { useState, type FormEvent } from 'react';
import { post, type User } from '../api.ts';
import { useSession } from '../session.ts';

/** Login / sign-up. `inviteCode` is sent as the sign-up code when joining via link. */
export function AuthPage({ inviteCode, title }: { inviteCode?: string; title?: string }) {
  const { setUser } = useSession();
  const [mode, setMode] = useState<'login' | 'register'>(inviteCode ? 'register' : 'login');
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body = mode === 'login' ? { username, password } : { username, password, displayName, code: inviteCode ?? code };
      const r = await post<{ user: User }>(`/auth/${mode}`, body);
      setUser(r.user);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth">
      <div className="auth-hero">
        <div className="auth-planet">🪐</div>
        <h1>
          Rankeo <em>Galáctico</em>
        </h1>
        <p className="muted">{title ?? 'Rankea lo que sea con tus amigos. Dos opciones, eliges una, y de a poco sale el ranking definitivo.'}</p>
      </div>
      <form className="card auth-card" onSubmit={submit}>
        <div className="segmented" role="tablist">
          <button type="button" role="tab" aria-selected={mode === 'login'} className={mode === 'login' ? 'on' : ''} onClick={() => setMode('login')}>
            Entrar
          </button>
          <button type="button" role="tab" aria-selected={mode === 'register'} className={mode === 'register' ? 'on' : ''} onClick={() => setMode('register')}>
            Crear cuenta
          </button>
        </div>
        <label>
          Usuario
          <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" autoCapitalize="none" required minLength={3} maxLength={24} />
        </label>
        {mode === 'register' && (
          <label>
            Nombre para mostrar
            <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="Como te conocen tus amigos" maxLength={40} />
          </label>
        )}
        <label>
          Contraseña
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            required
            minLength={mode === 'register' ? 8 : 1}
          />
        </label>
        {mode === 'register' && !inviteCode && (
          <label>
            <span>Código de invitación <span className="muted">(si te lo pidieron)</span></span>
            <input value={code} onChange={(e) => setCode(e.target.value)} autoCapitalize="none" />
          </label>
        )}
        {error && <p className="form-error">{error}</p>}
        <button className="btn btn-primary btn-block" disabled={busy}>
          {busy ? '…' : mode === 'login' ? 'Entrar' : 'Crear cuenta'}
        </button>
      </form>
    </div>
  );
}
