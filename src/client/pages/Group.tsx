import { useState } from 'react';
import { Link, useLocation } from 'wouter';
import { post, useApi, type ListSummary, type User } from '../api.ts';
import { Empty, ErrorBox, Spinner, toast } from '../components/ui.tsx';
import { ListCard } from './Home.tsx';

interface GroupDetail {
  group: { id: number; name: string; emoji: string; inviteCode: string; createdBy: number };
  members: (User & { joinedAt: number })[];
  lists: ListSummary[];
}

export function GroupPage({ id }: { id: number }) {
  const { data, error, reload } = useApi<GroupDetail>(`/groups/${id}`);
  const [, navigate] = useLocation();
  const [showInvite, setShowInvite] = useState(false);

  if (error) return <ErrorBox message={error} onRetry={reload} />;
  if (!data) return <Spinner />;
  const { group, members, lists } = data;
  const inviteUrl = `${window.location.origin}/join/${group.inviteCode}`;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(inviteUrl);
      toast('Link copiado');
    } catch {
      setShowInvite(true);
    }
  };
  const share = async () => {
    if (navigator.share) {
      await navigator.share({ title: `Únete a ${group.name} en Rankeo Galáctico`, url: inviteUrl }).catch(() => {});
    } else {
      void copy();
    }
  };
  const regenerate = async () => {
    if (!confirm('El link actual dejará de funcionar. ¿Generar uno nuevo?')) return;
    await post(`/groups/${id}/invite`);
    reload();
    toast('Nuevo link generado');
  };
  const leave = async () => {
    if (!confirm(`¿Salir de ${group.name}? Tus votos dejarán de contar para el ranking grupal.`)) return;
    await post(`/groups/${id}/leave`);
    navigate('/');
  };

  return (
    <div className="stack-lg">
      <section className="hero-row">
        <div className="title-with-emoji">
          <span className="big-emoji">{group.emoji}</span>
          <div>
            <h1>{group.name}</h1>
            <p className="muted">{members.map((m) => m.displayName).join(' · ')}</p>
          </div>
        </div>
        <Link href={`/new?group=${id}`} className="btn btn-primary">
          + Nueva lista grupal
        </Link>
      </section>

      <section className="card invite">
        <div>
          <h3>Invita a tus amigos</h3>
          <p className="muted small">Cualquiera con este link (o su código) entra al grupo solo poniendo su nombre.</p>
          {showInvite && <input readOnly value={inviteUrl} onFocus={(e) => e.currentTarget.select()} />}
        </div>
        <div className="row">
          <button className="btn" onClick={share}>
            Compartir link
          </button>
          <button className="btn btn-ghost" onClick={copy}>
            Copiar
          </button>
        </div>
      </section>

      <section className="stack">
        <h2>Listas del grupo</h2>
        {lists.length === 0 ? (
          <Empty title="Este grupo no tiene listas todavía">
            <Link href={`/new?group=${id}`} className="btn btn-primary">
              Crear la primera
            </Link>
          </Empty>
        ) : (
          <div className="grid">
            {lists.map((l) => (
              <ListCard key={l.id} list={l} />
            ))}
          </div>
        )}
      </section>

      <section className="row muted small">
        <button className="btn btn-ghost btn-sm" onClick={regenerate}>
          Generar nuevo link de invitación
        </button>
        <button className="btn btn-ghost btn-sm danger" onClick={leave}>
          Salir del grupo
        </button>
      </section>
    </div>
  );
}
