import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link, useLocation } from 'wouter';
import { del, patch, post, put, useApi, type GroupRanking, type Insights, type Item, type ListDetail, type PersonalRanking, type User } from '../api.ts';
import { RankingView } from '../components/RankingView.tsx';
import { ErrorBox, ItemFace, Spinner, parseItemLine, pluralize, toast } from '../components/ui.tsx';
import { useSession } from '../session.ts';
import { DuelView } from './Duel.tsx';

export function ListPage({ id, tab }: { id: number; tab: string }) {
  const detail = useApi<ListDetail>(`/lists/${id}`);
  const items = useMemo(() => new Map((detail.data?.items ?? []).map((i) => [i.id, i])), [detail.data]);
  // Bumped after votes so ranking tabs refetch when you switch to them.
  const [version, setVersion] = useState(0);
  // Refetch details on tab switch: friends may have joined or added items meanwhile.
  const { reload } = detail;
  useEffect(() => {
    if (tab !== 'duelo') reload();
  }, [tab, reload]);

  if (detail.error) return <ErrorBox message={detail.error} onRetry={detail.reload} />;
  if (!detail.data) return <Spinner />;
  const { list, group } = detail.data;

  const tabs: [string, string][] = [
    ['duelo', '⚔️ Duelo'],
    ['ranking', '🏆 Mi ranking'],
    ...(group ? ([['grupo', '👥 Grupo']] as [string, string][]) : []),
    ['items', `📋 Ítems`],
  ];

  return (
    <div className="stack-lg">
      <header className="list-header">
        <div className="title-with-emoji">
          <span className="big-emoji">{list.emoji}</span>
          <div>
            <h1>{list.title}</h1>
            <p className="muted small">
              {group ? (
                <Link href={`/groups/${group.id}`}>
                  {group.emoji} {group.name}
                </Link>
              ) : (
                '🔒 Lista personal'
              )}
              {list.description ? ` · ${list.description}` : ''}
            </p>
          </div>
        </div>
      </header>

      <nav className="tabs" role="tablist">
        {tabs.map(([key, label]) => (
          <Link key={key} href={`/lists/${id}/${key}`} role="tab" aria-selected={tab === key} className={tab === key ? 'tab on' : 'tab'}>
            {label}
          </Link>
        ))}
      </nav>

      {tab === 'duelo' && <DuelView listId={id} onVoted={() => setVersion((v) => v + 1)} />}
      {tab === 'ranking' && <PersonalTab listId={id} items={items} members={detail.data.members} isGroup={!!group} version={version} />}
      {tab === 'grupo' && group && <GroupTab listId={id} items={items} members={detail.data.members} version={version} />}
      {tab === 'items' && <ItemsTab detail={detail.data} reload={detail.reload} onChange={() => setVersion((v) => v + 1)} />}
    </div>
  );
}

function PersonalTab({ listId, items, members, isGroup, version }: { listId: number; items: Map<number, Item>; members: User[]; isGroup: boolean; version: number }) {
  const { user } = useSession();
  const [who, setWho] = useState(user!.id);
  const ranking = useApi<PersonalRanking>(`/lists/${listId}/ranking?user=${who}&v=${version}`);
  const isMe = who === user!.id;

  return (
    <div className="stack">
      {isGroup && members.length > 1 && (
        <div className="chips" role="radiogroup" aria-label="Ver ranking de">
          {members.map((m) => (
            <button key={m.id} role="radio" aria-checked={who === m.id} className={who === m.id ? 'chip on' : 'chip'} onClick={() => setWho(m.id)}>
              {m.id === user!.id ? 'Yo' : m.displayName}
            </button>
          ))}
        </div>
      )}
      {ranking.error && <ErrorBox message={ranking.error} onRetry={ranking.reload} />}
      {ranking.data ? (
        <>
          <p className="muted small">
            {pluralize(ranking.data.votes, 'duelo', 'duelos')}
            {isMe && ranking.data.confidence < 0.75 && ranking.data.votes > 0 ? '. Unos cuantos duelos más y el ranking se afina.' : ''}
          </p>
          <RankingView
            ranking={ranking.data}
            items={items}
            emptyHint={isMe ? 'Todavía no hay duelos. Anda a la pestaña Duelo y elige tus favoritos.' : 'Esta persona todavía no ha rankeado esta lista.'}
          />
          {isMe && ranking.data.votes > 0 && (
            <Link href={`/lists/${listId}/duelo`} className="btn btn-primary">
              Seguir rankeando ⚔️
            </Link>
          )}
        </>
      ) : (
        !ranking.error && <Spinner />
      )}
    </div>
  );
}

function GroupTab({ listId, items, members, version }: { listId: number; items: Map<number, Item>; members: User[]; version: number }) {
  const ranking = useApi<GroupRanking>(`/lists/${listId}/group?v=${version}`);
  const insights = useApi<Insights>(`/lists/${listId}/insights?v=${version}`);
  const name = (uid: number) => members.find((m) => m.id === uid)?.displayName ?? '¿?';
  const itemName = (iid: number) => items.get(iid)?.name ?? '¿?';

  if (ranking.error) return <ErrorBox message={ranking.error} onRetry={ranking.reload} />;
  if (!ranking.data) return <Spinner />;
  // Only mention the cap when it's noticeable.
  const capped = ranking.data.contributors.filter((c) => c.weight < 0.8);

  return (
    <div className="group-tab">
      <div className="stack">
        <p className="muted small">
          {ranking.data.contributors.length === 0
            ? 'Nadie ha rankeado todavía.'
            : `Ranking combinado de ${ranking.data.contributors.map((c) => `${name(c.userId)} (${c.votes})`).join(', ')}.`}
          {capped.length > 0 && ` Para que nadie domine, los votos de ${capped.map((c) => name(c.userId)).join(', ')} pesan menos (hicieron muchos más duelos que el resto).`}
        </p>
        <RankingView ranking={ranking.data} items={items} emptyHint="Cuando alguien del grupo haga duelos, aquí aparece el ranking grupal." />
      </div>

      {insights.data && <InsightsPanel insights={insights.data} name={name} itemName={itemName} items={items} />}
    </div>
  );
}

function pct(x: number) {
  return `${Math.round(x * 100)}%`;
}

function InsightsPanel({ insights, name, itemName, items }: { insights: Insights; name: (id: number) => string; itemName: (id: number) => string; items: Map<number, Item> }) {
  const { user } = useSession();
  const myTakes = insights.hotTakes.find((h) => h.userId === user!.id)?.takes ?? [];
  const otherTakes = insights.hotTakes.filter((h) => h.userId !== user!.id && h.takes.length > 0);
  const hasAnything = insights.soulmate || insights.divisive.length > 0 || insights.hotTakes.some((h) => h.takes.length > 0);

  if (!hasAnything) {
    return (
      <aside className="card insights">
        <h3>🔭 Observatorio</h3>
        <p className="muted small">Cuando al menos dos personas rankeen unos cuantos ítems en común, aquí verás quién piensa igual que tú y qué ítems dividen al grupo.</p>
      </aside>
    );
  }

  const takeLine = (t: { itemId: number; delta: number }) => (
    <li key={t.itemId}>
      <strong>{itemName(t.itemId)}</strong>: {t.delta < 0 ? 'mucho más arriba' : 'mucho más abajo'} que el grupo {t.delta < 0 ? '📈' : '📉'}
    </li>
  );

  return (
    <aside className="card insights stack">
      <h3>🔭 Observatorio</h3>
      {insights.soulmate && (
        <div className="insight">
          {/* "Soulmate" only means something when there's more than one person to compare with. */}
          <span className="insight-label">{insights.opposite ? '💞 Tu alma gemela' : `🤝 Acuerdo con ${name(insights.soulmate.userId)}`}</span>
          <span>
            <strong>{name(insights.soulmate.userId)}</strong>: {pct(insights.soulmate.agreement)} de acuerdo
          </span>
        </div>
      )}
      {insights.opposite && insights.opposite.userId !== insights.soulmate?.userId && (
        <div className="insight">
          <span className="insight-label">⚡ Tu polo opuesto</span>
          <span>
            <strong>{name(insights.opposite.userId)}</strong>: {pct(insights.opposite.agreement)} de acuerdo
          </span>
        </div>
      )}
      {insights.divisive.length > 0 && (
        <div className="insight">
          <span className="insight-label">🔥 Los más polémicos</span>
          <div className="chips">
            {insights.divisive.map((d) => {
              const item = items.get(d.itemId);
              return item ? (
                <span key={d.itemId} className="chip static">
                  <ItemFace item={item} size={20} /> {item.name}
                </span>
              ) : null;
            })}
          </div>
        </div>
      )}
      {myTakes.length > 0 && (
        <div className="insight">
          <span className="insight-label">🌶️ Tus hot takes</span>
          <ul className="takes">{myTakes.map(takeLine)}</ul>
        </div>
      )}
      {otherTakes.map((h) => (
        <div className="insight" key={h.userId}>
          <span className="insight-label">🌶️ Hot takes de {name(h.userId)}</span>
          <ul className="takes">{h.takes.map(takeLine)}</ul>
        </div>
      ))}
      {insights.agreement.length > 1 && (
        <details>
          <summary className="small">Matriz de acuerdo</summary>
          <ul className="takes small">
            {[...insights.agreement]
              .sort((a, b) => b.agreement - a.agreement)
              .map((a) => (
                <li key={`${a.userA}-${a.userB}`}>
                  {name(a.userA)} ↔ {name(a.userB)}: {pct(a.agreement)} <span className="muted">({a.shared} en común)</span>
                </li>
              ))}
          </ul>
        </details>
      )}
    </aside>
  );
}

function ItemsTab({ detail, reload, onChange }: { detail: ListDetail; reload: () => void; onChange: () => void }) {
  const { user } = useSession();
  const [, navigate] = useLocation();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<number | null>(null);
  const excluded = new Set(detail.excluded);
  const active = detail.items.filter((i) => !i.archived);
  const archived = detail.items.filter((i) => i.archived);
  const canModify = (i: Item) => detail.canEdit || i.createdBy === user!.id;

  const add = async (e: FormEvent) => {
    e.preventDefault();
    const items = text.split('\n').map(parseItemLine).filter((x) => x !== null);
    if (items.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const r = await post<{ added: number; skipped: number }>(`/lists/${detail.list.id}/items`, { items });
      toast(`${pluralize(r.added, 'ítem agregado', 'ítems agregados')}${r.skipped ? ` (${r.skipped} repetidos)` : ''}`);
      setText('');
      reload();
      onChange();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      reload();
      onChange();
    } catch (err) {
      toast((err as Error).message);
    }
  };

  const deleteList = async () => {
    if (!confirm(`¿Borrar "${detail.list.title}" y todos sus votos? No se puede deshacer.`)) return;
    await del(`/lists/${detail.list.id}`);
    navigate(detail.group ? `/groups/${detail.group.id}` : '/');
  };

  return (
    <div className="stack-lg">
      <form className="card stack" onSubmit={add}>
        <label>
          <span>Agregar ítems <span className="muted">(uno por línea)</span></span>
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} placeholder={'🌭 Italiano\nDinámico'} />
        </label>
        {error && <p className="form-error">{error}</p>}
        <button className="btn btn-primary" disabled={busy || !text.trim()}>
          Agregar
        </button>
      </form>

      <section className="stack">
        <h2>
          {pluralize(active.length, 'ítem', 'ítems')}
          {excluded.size > 0 && <span className="muted small"> · {excluded.size} que no conoces</span>}
        </h2>
        <ul className="item-list">
          {active.map((item) =>
            editing === item.id ? (
              <ItemEditor
                key={item.id}
                item={item}
                onCancel={() => setEditing(null)}
                onSave={(changes) =>
                  act(async () => {
                    await patch(`/items/${item.id}`, changes);
                    setEditing(null);
                  })
                }
              />
            ) : (
              <li key={item.id} className={excluded.has(item.id) ? 'item-row dim' : 'item-row'}>
                <ItemFace item={item} size={36} />
                <span className="item-name">{item.name}</span>
                <label className="toggle small" title="Los ítems que no conoces no te aparecen en duelos ni en tu ranking">
                  <input type="checkbox" checked={excluded.has(item.id)} onChange={(e) => act(() => put(`/items/${item.id}/exclusion`, { excluded: e.target.checked }))} />
                  No lo conozco
                </label>
                {canModify(item) && (
                  <span className="row">
                    <button className="btn btn-ghost btn-sm" onClick={() => setEditing(item.id)}>
                      Editar
                    </button>
                    <button className="btn btn-ghost btn-sm" onClick={() => act(() => patch(`/items/${item.id}`, { archived: true }))}>
                      Archivar
                    </button>
                  </span>
                )}
              </li>
            ),
          )}
        </ul>
      </section>

      {archived.length > 0 && (
        <details className="stack">
          <summary>Archivados ({archived.length})</summary>
          <p className="muted small">Los archivados no aparecen en duelos ni rankings, pero sus votos se guardan.</p>
          <ul className="item-list">
            {archived.map((item) => (
              <li key={item.id} className="item-row dim">
                <ItemFace item={item} size={36} />
                <span className="item-name">{item.name}</span>
                {canModify(item) && (
                  <button className="btn btn-ghost btn-sm" onClick={() => act(() => patch(`/items/${item.id}`, { archived: false }))}>
                    Restaurar
                  </button>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}

      {detail.canEdit && (
        <section className="row">
          <button className="btn btn-ghost btn-sm danger" onClick={deleteList}>
            Borrar lista
          </button>
        </section>
      )}
    </div>
  );
}

function ItemEditor({ item, onSave, onCancel }: { item: Item; onSave: (c: { name: string; emoji: string; imageUrl: string }) => void; onCancel: () => void }) {
  const [name, setName] = useState(item.name);
  const [emoji, setEmoji] = useState(item.emoji);
  const [imageUrl, setImageUrl] = useState(item.imageUrl);
  return (
    <li className="item-row editing">
      <form
        className="item-editor"
        onSubmit={(e) => {
          e.preventDefault();
          onSave({ name, emoji, imageUrl });
        }}
      >
        <ItemFace item={{ name, emoji, imageUrl }} size={48} />
        <input aria-label="Emoji" className="emoji-input" value={emoji} onChange={(e) => setEmoji(e.target.value)} placeholder="🙂" maxLength={16} />
        <input aria-label="Nombre" value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} />
        <input aria-label="URL de imagen" value={imageUrl} onChange={(e) => setImageUrl(e.target.value)} placeholder="https://… (imagen opcional)" type="url" />
        <span className="row">
          <button className="btn btn-primary btn-sm">Guardar</button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onCancel}>
            Cancelar
          </button>
        </span>
      </form>
    </li>
  );
}
