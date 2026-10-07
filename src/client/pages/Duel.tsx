import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'wouter';
import { get, post, put, type Duel, type Item } from '../api.ts';
import { ConfidenceBar, ErrorBox, ItemFace, Spinner, toast } from '../components/ui.tsx';

type Pick = 'left' | 'right' | 'tie' | 'skip' | null;

const MILESTONES: [number, string][] = [
  [0.5, 'Tu rankeo ya está 50% seguro. Sigue así.'],
  [0.75, '75% seguro: ya puedes mirar tu ranking con confianza.'],
  [0.9, '90%: rankeo galáctico desbloqueado.'],
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function DuelView({ listId, onVoted }: { listId: number; onVoted?: () => void }) {
  const [duel, setDuel] = useState<Duel | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<Pick>(null);
  const busy = useRef(false);
  // Highest confidence seen this visit, so undo + redo doesn't re-trigger a milestone toast.
  const bestConfidence = useRef<number | null>(null);

  const apply = useCallback((d: Duel) => {
    const best = bestConfidence.current;
    if (best !== null) {
      for (const [threshold, msg] of MILESTONES) if (best < threshold && d.confidence >= threshold) toast(msg);
    }
    bestConfidence.current = Math.max(best ?? 0, d.confidence);
    setDuel(d);
    setError(null);
  }, []);

  /** Runs one action at a time; `anim` gives the pick animation time to play. */
  const run = useCallback(
    async (pick: Pick, action: () => Promise<Duel>, anim = 0) => {
      if (busy.current) return;
      busy.current = true;
      setPicked(pick);
      try {
        const [next] = await Promise.all([action(), sleep(anim)]);
        apply(next);
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setPicked(null);
        busy.current = false;
      }
    },
    [apply],
  );

  useEffect(() => {
    bestConfidence.current = null;
    void run(null, () => get<Duel>(`/lists/${listId}/duel`));
  }, [listId, run]);

  const pair = duel?.pair ?? null;

  const vote = useCallback(
    (result: 'left' | 'right' | 'tie') => {
      if (!pair) return;
      void run(result, () => post<Duel>(`/lists/${listId}/votes`, { left: pair.left.id, right: pair.right.id, result }), 260).then(() => onVoted?.());
    },
    [pair, listId, run, onVoted],
  );
  const skip = useCallback(() => {
    if (!pair) return;
    void run('skip', () => get<Duel>(`/lists/${listId}/duel?avoid=${pair.left.id},${pair.right.id}`), 150);
  }, [pair, listId, run]);
  const undo = useCallback(() => {
    if (!duel || duel.votes === 0) return;
    void run(null, () => post<Duel>(`/lists/${listId}/votes/undo`)).then(() => {
      toast('Voto deshecho');
      onVoted?.();
    });
  }, [duel, listId, run, onVoted]);
  const exclude = useCallback(
    (item: Item) => {
      void run(null, async () => {
        await put(`/items/${item.id}/exclusion`, { excluded: true });
        return get<Duel>(`/lists/${listId}/duel`);
      }).then(() => {
        toast(`Escondimos "${item.name}". Lo puedes recuperar en Ítems.`);
        onVoted?.();
      });
    },
    [listId, run, onVoted],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest('input, textarea, select') || e.metaKey || e.ctrlKey || e.altKey) return;
      const actions: Record<string, () => void> = {
        ArrowLeft: () => vote('left'),
        ArrowRight: () => vote('right'),
        ArrowDown: () => vote('tie'),
        ArrowUp: skip,
        ' ': skip,
        z: undo,
        Z: undo,
        Backspace: undo,
      };
      const action = actions[e.key];
      if (action) {
        e.preventDefault();
        action();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [vote, skip, undo]);

  if (!duel) return error ? <ErrorBox message={error} /> : <Spinner />;

  if (!pair) {
    return (
      <div className="empty">
        <h3>Faltan contendores</h3>
        <p className="muted">
          Necesitas al menos 2 ítems para un duelo
          {duel.eligibleItems < 2 && duel.eligibleItems >= 0 ? ' (sin contar los que marcaste como "no lo conozco")' : ''}.
        </p>
        <Link href={`/lists/${listId}/items`} className="btn btn-primary">
          Agregar ítems
        </Link>
      </div>
    );
  }

  const cardClass = (side: 'left' | 'right') =>
    ['duel-card', picked === side && 'won', picked && picked !== side && picked !== 'tie' && picked !== 'skip' && 'lost', picked === 'tie' && 'tied', picked === 'skip' && 'skipped']
      .filter(Boolean)
      .join(' ');

  return (
    <div className="duel">
      <div className="duel-status">
        <ConfidenceBar value={duel.confidence} />
        <span className="muted small">
          {duel.votes} {duel.votes === 1 ? 'duelo' : 'duelos'}
        </span>
      </div>

      <h2 className="duel-question">¿Cuál es mejor?</h2>

      <div className="duel-arena" key={`${pair.left.id}-${pair.right.id}-${duel.votes}`}>
        {(['left', 'right'] as const).map((side) => {
          const item = pair[side];
          return (
            <div key={side} className={`duel-slot duel-slot-${side}`}>
              <button className={cardClass(side)} onClick={() => vote(side)} aria-label={`Elegir ${item.name}`} aria-keyshortcuts={side === 'left' ? 'ArrowLeft' : 'ArrowRight'}>
                <ItemFace item={item} size={112} />
                <span className="duel-name">{item.name}</span>
                <kbd className="hide-touch">{side === 'left' ? '←' : '→'}</kbd>
              </button>
              <button className="link-btn small" onClick={() => exclude(item)}>
                No lo conozco
              </button>
            </div>
          );
        })}
        <div className="vs" aria-hidden>
          VS
        </div>
      </div>

      {error && <ErrorBox message={error} />}

      <div className="duel-actions">
        <button className="btn btn-ghost" onClick={() => vote('tie')}>
          Empate <kbd className="hide-touch">↓</kbd>
        </button>
        <button className="btn btn-ghost" onClick={skip}>
          Paso <kbd className="hide-touch">␣</kbd>
        </button>
        <button className="btn btn-ghost" onClick={undo} disabled={duel.votes === 0}>
          Deshacer <kbd className="hide-touch">Z</kbd>
        </button>
      </div>
    </div>
  );
}
