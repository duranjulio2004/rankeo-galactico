import { useMemo, useState, type FormEvent } from 'react';
import { useLocation, useSearch } from 'wouter';
import { post, useApi, type GroupSummary } from '../api.ts';
import { parseItemLine } from '../components/ui.tsx';

const TEMPLATES: { title: string; emoji: string; items: string }[] = [
  {
    title: 'Sánguches chilenos',
    emoji: '🥪',
    items: ['Barros Luco', 'Barros Jarpa', 'Chacarero', 'Italiano', 'Lomito', 'As', 'Churrasco', 'Ave palta', 'Ave mayo', 'Chemilico', 'Mechada', 'Completo'].join('\n'),
  },
  {
    title: 'Snacks del kiosko',
    emoji: '🍫',
    items: ['🍫 Super 8', '🍫 Sahne-Nuss', '🍪 Tritón', '🍪 Frac', '🍪 Chocman', '🍬 Negrita', '🍫 Trencito', '🥨 Ramitas', '🥔 Papas Lays', '🍬 Ambrosoli', '🍪 Morocha', '🍫 Costa Rama'].join('\n'),
  },
  {
    title: 'Películas de Pixar',
    emoji: '🎬',
    items: ['Toy Story', 'Buscando a Nemo', 'Monsters, Inc.', 'Los Increíbles', 'Ratatouille', 'WALL·E', 'Up', 'Toy Story 3', 'Intensa-Mente', 'Coco', 'Soul', 'Cars'].join('\n'),
  },
  {
    title: 'Lenguajes de programación',
    emoji: '💻',
    items: ['Python', 'TypeScript', 'Rust', 'Go', 'C', 'C++', 'Java', 'Haskell', 'Ruby', 'Kotlin', 'Elixir', 'Zig'].join('\n'),
  },
];

const LIST_EMOJIS = ['⭐', '🍔', '🎬', '🎮', '🎵', '📚', '⚽', '🍺', '🌭', '💻', '🏔️', '🧉'];

export function NewListPage() {
  const [, navigate] = useLocation();
  const search = useSearch();
  const groups = useApi<{ groups: GroupSummary[] }>('/groups');
  const presetGroup = new URLSearchParams(search).get('group');
  const [title, setTitle] = useState('');
  const [emoji, setEmoji] = useState('⭐');
  const [description, setDescription] = useState('');
  const [groupId, setGroupId] = useState<string>(presetGroup ?? '');
  const [itemsText, setItemsText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const items = useMemo(() => itemsText.split('\n').map(parseItemLine).filter((x) => x !== null), [itemsText]);

  const applyTemplate = (t: (typeof TEMPLATES)[number]) => {
    setTitle(t.title);
    setEmoji(t.emoji);
    setItemsText(t.items);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await post<{ list: { id: number } }>('/lists', { title, emoji, description, groupId: groupId ? Number(groupId) : null, items });
      navigate(`/lists/${r.list.id}`);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <form className="stack-lg narrow" onSubmit={submit}>
      <h1>Nueva lista</h1>

      <div className="stack">
        <span className="muted small">¿Sin ideas? Parte con una plantilla:</span>
        <div className="chips">
          {TEMPLATES.map((t) => (
            <button type="button" key={t.title} className="chip" onClick={() => applyTemplate(t)}>
              {t.emoji} {t.title}
            </button>
          ))}
        </div>
      </div>

      <div className="card stack">
        <label>
          Título
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Los mejores completos de Santiago" required maxLength={80} />
        </label>
        <div className="emoji-picker" role="radiogroup" aria-label="Emoji de la lista">
          {LIST_EMOJIS.map((em) => (
            <button type="button" key={em} role="radio" aria-checked={em === emoji} className={em === emoji ? 'on' : ''} onClick={() => setEmoji(em)}>
              {em}
            </button>
          ))}
        </div>
        <label>
          <span>Descripción <span className="muted">(opcional)</span></span>
          <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="¿Qué criterio usamos?" maxLength={500} />
        </label>
        <label>
          ¿De quién es?
          <select value={groupId} onChange={(e) => setGroupId(e.target.value)}>
            <option value="">🔒 Solo mía (personal)</option>
            {groups.data?.groups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.emoji} {g.name}: ranking grupal
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="card stack">
        <label>
          <span>Ítems <span className="muted">(uno por línea; puedes partir con un emoji: "🌭 Italiano")</span></span>
          <textarea value={itemsText} onChange={(e) => setItemsText(e.target.value)} rows={10} placeholder={'Italiano\nDinámico\nChacarero\n…'} />
        </label>
        <span className="muted small">
          {items.length} ítems{items.length > 0 && items.length < 2 ? '. Necesitas al menos 2 para un duelo' : ''}
          {groupId ? '. Los miembros del grupo también pueden agregar más después.' : '.'}
        </span>
      </div>

      {error && <p className="form-error">{error}</p>}
      <button className="btn btn-primary btn-block" disabled={busy || !title.trim()}>
        {busy ? 'Creando…' : 'Crear lista y empezar'}
      </button>
    </form>
  );
}
