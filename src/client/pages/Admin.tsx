import { useState } from 'react';
import { del, patch, post, useApi } from '../api.ts';
import { ErrorBox, Spinner, toast } from '../components/ui.tsx';
import { useSession } from '../session.ts';
import { AccessLinkBox, accessUrl } from './Me.tsx';

interface AdminUser {
  id: number;
  displayName: string;
  isAdmin: boolean;
  createdAt: number;
  votes: number;
  groups: string;
  sessionExpiresAt: number | null;
}

export function AdminPage() {
  const { user } = useSession();
  const users = useApi<{ users: AdminUser[] }>(user?.isAdmin ? '/admin/users' : null);
  // Freshly generated access links, shown once per user row.
  const [links, setLinks] = useState<Record<number, string>>({});

  if (!user?.isAdmin) return <ErrorBox message="Solo el admin puede ver esta página." />;
  if (users.error) return <ErrorBox message={users.error} onRetry={users.reload} />;
  if (!users.data) return <Spinner />;

  const act = async (fn: () => Promise<unknown>, done: string) => {
    try {
      await fn();
      toast(done);
      users.reload();
    } catch (err) {
      toast((err as Error).message);
    }
  };

  const issueLink = async (u: AdminUser) => {
    if (!confirm(`¿Generar un link de acceso nuevo para ${u.displayName}? Su link anterior dejará de funcionar.`)) return;
    try {
      const r = await post<{ key: string }>(`/admin/users/${u.id}/access-key`);
      setLinks((l) => ({ ...l, [u.id]: accessUrl(r.key) }));
    } catch (err) {
      toast((err as Error).message);
    }
  };

  const rename = (u: AdminUser) => {
    const name = prompt(`Nuevo nombre para ${u.displayName}:`, u.displayName);
    if (name && name.trim() !== u.displayName) void act(() => patch(`/admin/users/${u.id}`, { name }), 'Nombre actualizado');
  };

  const remove = (u: AdminUser) => {
    if (!confirm(`¿Borrar a ${u.displayName}? Se borran sus votos y listas personales. Sus listas grupales pasan a ser tuyas.`)) return;
    void act(() => del(`/admin/users/${u.id}`), `${u.displayName} fue borrado`);
  };

  return (
    <div className="stack-lg">
      <div>
        <h1>Admin</h1>
        <p className="muted">
          {users.data.users.length} personas. Si alguien perdió su dispositivo, genérale un link de acceso y mándaselo por privado.
        </p>
      </div>
      <ul className="item-list">
        {users.data.users.map((u) => (
          <li key={u.id} className="item-row admin-row">
            <div className="admin-user">
              <strong>
                {u.displayName}
                {u.isAdmin && <span className="pill pill-accent admin-pill">admin</span>}
              </strong>
              <span className="muted small">
                {u.votes} votos · {u.groups || 'sin grupos'}
                {u.sessionExpiresAt === null ? ' · sin sesión activa' : ''}
              </span>
            </div>
            <span className="row">
              <button className="btn btn-ghost btn-sm" onClick={() => issueLink(u)}>
                Link de acceso
              </button>
              <button className="btn btn-ghost btn-sm" onClick={() => rename(u)}>
                Renombrar
              </button>
              {!u.isAdmin && (
                <button className="btn btn-ghost btn-sm danger" onClick={() => remove(u)}>
                  Borrar
                </button>
              )}
            </span>
            {links[u.id] && (
              <div className="admin-link">
                <AccessLinkBox url={links[u.id]!} />
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
