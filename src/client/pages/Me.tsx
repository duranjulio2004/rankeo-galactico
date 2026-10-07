import { useState, type FormEvent } from 'react';
import { useLocation } from 'wouter';
import { patch, post, type User } from '../api.ts';
import { toast } from '../components/ui.tsx';
import { useSession } from '../session.ts';

export const accessUrl = (key: string) => `${window.location.origin}/acceso/${key}`;

/** Shows a freshly generated access link once, with a copy button. */
export function AccessLinkBox({ url }: { url: string }) {
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      toast('Link copiado');
    } catch {
      toast('No se pudo copiar; selecciónalo a mano');
    }
  };
  return (
    <div className="stack">
      <input readOnly value={url} onFocus={(e) => e.currentTarget.select()} aria-label="Link de acceso" />
      <div className="row">
        <button type="button" className="btn btn-sm" onClick={copy}>
          Copiar
        </button>
        <span className="muted small">Guárdalo en un lugar privado: quien lo abra entra como esta persona.</span>
      </div>
    </div>
  );
}

export function MePage() {
  const { user, setUser } = useSession();
  const [, navigate] = useLocation();
  const [name, setName] = useState(user!.displayName);
  const [nameError, setNameError] = useState<string | null>(null);
  const [link, setLink] = useState<string | null>(null);

  const rename = async (e: FormEvent) => {
    e.preventDefault();
    setNameError(null);
    try {
      const r = await patch<{ user: User }>('/auth/me', { name });
      setUser(r.user);
      toast('Nombre actualizado');
    } catch (err) {
      setNameError((err as Error).message);
    }
  };

  const generate = async () => {
    if (link === null || confirm('Generar un link nuevo hace que el anterior deje de funcionar. ¿Seguir?')) {
      const r = await post<{ key: string }>('/auth/access-key');
      setLink(accessUrl(r.key));
    }
  };

  const logout = async () => {
    const ok = confirm(
      'Sin contraseña, la única forma de volver a ser tú es con tu link de acceso. Si no lo tienes guardado, genera uno antes de salir. ¿Salir igual?',
    );
    if (!ok) return;
    await post('/auth/logout').catch(() => {});
    setUser(null);
    navigate('/');
  };

  return (
    <div className="stack-lg narrow">
      <h1>{user!.displayName}</h1>

      <form className="card stack" onSubmit={rename}>
        <label>
          Tu nombre
          <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={30} />
        </label>
        {nameError && <p className="form-error">{nameError}</p>}
        <button className="btn" disabled={name.trim() === user!.displayName}>
          Cambiar nombre
        </button>
      </form>

      <section className="card stack">
        <h3>Link de acceso</h3>
        <p className="muted small">
          No hay contraseñas: este dispositivo te recuerda. Para entrar desde otro celular o computador (o si borras los datos del navegador), abre tu link de
          acceso ahí. Si lo pierdes, el admin te puede dar uno nuevo.
        </p>
        {link ? (
          <AccessLinkBox url={link} />
        ) : (
          <button className="btn btn-primary" onClick={generate}>
            Generar mi link de acceso
          </button>
        )}
      </section>

      <section className="row">
        <button className="btn btn-ghost btn-sm danger" onClick={logout}>
          Salir de este dispositivo
        </button>
      </section>
    </div>
  );
}
