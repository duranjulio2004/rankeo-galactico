import { useState, type FormEvent } from 'react';
import { Link, useLocation } from 'wouter';
import { post, useApi, type GroupSummary, type ListSummary } from '../api.ts';
import { ConfidenceBar, Empty, ErrorBox, Spinner, pluralize } from '../components/ui.tsx';
import { useSession } from '../session.ts';

export function ListCard({ list }: { list: ListSummary }) {
  const started = list.myVotes > 0;
  return (
    <Link href={`/lists/${list.id}`} className="card list-card">
      <div className="list-card-head">
        <span className="list-emoji">{list.emoji}</span>
        <div className="list-card-title">
          <h3>{list.title}</h3>
          <span className="muted small">
            {list.group ? `${list.group.emoji} ${list.group.name}` : 'Personal'} · {pluralize(list.itemCount, 'ítem', 'ítems')}
            {list.group && list.voters > 0 ? ` · ${pluralize(list.voters, 'rankeador', 'rankeadores')}` : ''}
          </span>
        </div>
      </div>
      {started ? (
        <ConfidenceBar value={list.myConfidence} />
      ) : (
        <span className="pill pill-accent">{list.itemCount >= 2 ? '¡Empieza a rankear!' : 'Agrega ítems'}</span>
      )}
    </Link>
  );
}

export function HomePage() {
  const { user } = useSession();
  const lists = useApi<{ lists: ListSummary[] }>('/lists');
  const groups = useApi<{ groups: GroupSummary[] }>('/groups');
  const [creatingGroup, setCreatingGroup] = useState(false);

  return (
    <div className="stack-lg">
      <section className="hero-row">
        <div>
          <h1>Hola, {user?.displayName}</h1>
          <p className="muted">¿Qué vamos a rankear hoy?</p>
        </div>
        <Link href="/new" className="btn btn-primary">
          + Nueva lista
        </Link>
      </section>

      <section className="stack">
        <div className="section-head">
          <h2>Tus grupos</h2>
          <button className="btn btn-ghost btn-sm" onClick={() => setCreatingGroup((v) => !v)}>
            {creatingGroup ? 'Cancelar' : '+ Nuevo grupo'}
          </button>
        </div>
        {creatingGroup && <NewGroupForm />}
        {groups.error && <ErrorBox message={groups.error} onRetry={groups.reload} />}
        {groups.data && groups.data.groups.length === 0 && !creatingGroup && (
          <p className="muted">Todavía no estás en ningún grupo. Crea uno y comparte el link de invitación con tus amigos.</p>
        )}
        <div className="grid">
          {groups.data?.groups.map((g) => (
            <Link key={g.id} href={`/groups/${g.id}`} className="card group-card">
              <span className="group-emoji">{g.emoji}</span>
              <div>
                <h3>{g.name}</h3>
                <span className="muted small">
                  {pluralize(g.memberCount, 'miembro', 'miembros')} · {pluralize(g.listCount, 'lista', 'listas')}
                </span>
              </div>
            </Link>
          ))}
        </div>
      </section>

      <section className="stack">
        <h2>Tus listas</h2>
        {lists.loading && !lists.data && <Spinner />}
        {lists.error && <ErrorBox message={lists.error} onRetry={lists.reload} />}
        {lists.data && lists.data.lists.length === 0 && (
          <Empty title="Aún no hay nada que rankear">
            <p className="muted">Crea una lista (completos, películas, ramos, lo que sea) y empieza con los duelos.</p>
            <Link href="/new" className="btn btn-primary">
              Crear mi primera lista
            </Link>
          </Empty>
        )}
        <div className="grid">
          {lists.data?.lists.map((l) => (
            <ListCard key={l.id} list={l} />
          ))}
        </div>
      </section>
    </div>
  );
}

const GROUP_EMOJIS = ['🪐', '🚀', '👽', '🌮', '🎮', '🎬', '🍻', '📚', '⚽', '🎸'];

function NewGroupForm() {
  const [, navigate] = useLocation();
  const [name, setName] = useState('');
  const [emoji, setEmoji] = useState(GROUP_EMOJIS[0]!);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const r = await post<{ group: { id: number } }>('/groups', { name, emoji });
      navigate(`/groups/${r.group.id}`);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <form className="card stack" onSubmit={submit}>
      <label>
        Nombre del grupo
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Los del DCC" required maxLength={60} autoFocus />
      </label>
      <div className="emoji-picker" role="radiogroup" aria-label="Emoji del grupo">
        {GROUP_EMOJIS.map((em) => (
          <button type="button" key={em} role="radio" aria-checked={em === emoji} className={em === emoji ? 'on' : ''} onClick={() => setEmoji(em)}>
            {em}
          </button>
        ))}
      </div>
      {error && <p className="form-error">{error}</p>}
      <button className="btn btn-primary">Crear grupo</button>
    </form>
  );
}
