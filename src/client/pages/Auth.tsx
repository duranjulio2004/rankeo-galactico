import { useState, type FormEvent } from 'react';
import { useLocation } from 'wouter';
import { post, type User } from '../api.ts';
import { useSession } from '../session.ts';

/** Enter with a code + name. With `code` preset (invite link), only the name is asked. */
export function AuthPage({ code: presetCode, title }: { code?: string; title?: string }) {
  const { setUser } = useSession();
  const [, navigate] = useLocation();
  const [code, setCode] = useState(presetCode ?? '');
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await post<{ user: User; groupId: number | null }>('/auth/enter', { code, name });
      setUser(r.user);
      navigate(r.groupId ? `/groups/${r.groupId}` : '/');
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
        {!presetCode && (
          <label>
            Código
            <input value={code} onChange={(e) => setCode(e.target.value)} autoCapitalize="none" autoComplete="off" spellCheck={false} required />
          </label>
        )}
        <label>
          Tu nombre
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Como te conocen tus amigos" required maxLength={30} autoFocus={!!presetCode} />
        </label>
        {error && <p className="form-error">{error}</p>}
        <button className="btn btn-primary btn-block" disabled={busy}>
          {busy ? '…' : 'Entrar'}
        </button>
        <p className="muted small">
          Sin contraseñas: este dispositivo te recuerda. Si ya entraste antes en otro lado, abre tu <strong>link de acceso</strong> (lo encuentras en "Yo") en vez de
          volver a poner tu nombre.
        </p>
      </form>
    </div>
  );
}

/** /acceso/:key: logs this device in as the owner of the access link. */
export function AccessPage({ accessKey }: { accessKey: string }) {
  const { user, setUser } = useSession();
  const [, navigate] = useLocation();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const enter = async () => {
    setBusy(true);
    try {
      const r = await post<{ user: User }>('/auth/access', { key: accessKey });
      setUser(r.user);
      navigate('/');
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="card stack narrow center-text">
      <h1>Link de acceso</h1>
      <p className="muted">
        {user ? `Ahora estás como ${user.displayName}. Si sigues, este dispositivo pasa a ser de la persona dueña del link.` : 'Entra como la persona dueña de este link.'}
      </p>
      {error && <p className="form-error">{error}</p>}
      <button className="btn btn-primary" onClick={enter} disabled={busy}>
        Entrar con este link
      </button>
    </div>
  );
}
