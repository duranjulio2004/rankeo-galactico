import { useState } from 'react';
import type { Item, Ranking } from '../api.ts';
import { ConfidenceBar, ItemFace } from './ui.tsx';

const TIER_COLORS: Record<string, string> = {
  S: 'var(--tier-s)',
  A: 'var(--tier-a)',
  B: 'var(--tier-b)',
  C: 'var(--tier-c)',
  D: 'var(--tier-d)',
  F: 'var(--tier-f)',
};

export function TierBadge({ tier }: { tier: string }) {
  return (
    <span className="tier-badge" style={{ background: TIER_COLORS[tier] }}>
      {tier}
    </span>
  );
}

/** Ranked list or auto tier list, for personal or group rankings. */
export function RankingView({ ranking, items, emptyHint }: { ranking: Ranking; items: Map<number, Item>; emptyHint: string }) {
  const [mode, setMode] = useState<'list' | 'tiers'>(() => (localStorageGet('rg:rankMode') as 'list' | 'tiers') ?? 'list');
  const choose = (m: 'list' | 'tiers') => {
    setMode(m);
    localStorageSet('rg:rankMode', m);
  };

  if (ranking.ranked.length === 0) return <p className="muted">{emptyHint}</p>;
  const maxRating = Math.max(...ranking.ranked.map((r) => r.rating));
  const minRating = Math.min(...ranking.ranked.map((r) => r.rating));
  const span = Math.max(1, maxRating - minRating);

  return (
    <div className="stack">
      <div className="ranking-toolbar">
        <ConfidenceBar value={ranking.confidence} />
        <div className="segmented segmented-sm" role="tablist">
          <button role="tab" aria-selected={mode === 'list'} className={mode === 'list' ? 'on' : ''} onClick={() => choose('list')}>
            Ranking
          </button>
          <button role="tab" aria-selected={mode === 'tiers'} className={mode === 'tiers' ? 'on' : ''} onClick={() => choose('tiers')}>
            Tier list
          </button>
        </div>
      </div>

      {mode === 'list' ? (
        <ol className="ranking">
          {ranking.ranked.map((r) => {
            const item = items.get(r.itemId);
            if (!item) return null;
            const pct = ((r.rating - minRating) / span) * 100;
            return (
              <li key={r.itemId} className={`rank-row rank-${r.rank <= 3 ? r.rank : 'n'}`}>
                <span className="rank-num">{r.rank <= 3 ? ['🥇', '🥈', '🥉'][r.rank - 1] : r.rank}</span>
                <ItemFace item={item} size={40} />
                <div className="rank-main">
                  <div className="rank-name">
                    {item.name} <TierBadge tier={r.tier} />
                  </div>
                  <div className="rank-bar" title={`${r.rating} ± ${r.plusMinus}`}>
                    <div className="rank-bar-fill" style={{ width: `${Math.max(4, pct)}%` }} />
                  </div>
                </div>
                <div className="rank-stats">
                  <span className="rank-rating">{r.rating}</span>
                  <span className="muted small" title="Victorias–derrotas–empates">
                    {/* Group counts are weighted (fractional); whole numbers read better. */}
                    {Math.round(r.wins)}–{Math.round(r.losses)}
                    {Math.round(r.ties) > 0 ? `–${Math.round(r.ties)}` : ''}
                  </span>
                </div>
              </li>
            );
          })}
        </ol>
      ) : (
        <div className="tierlist">
          {ranking.tiers.map((t) => (
            <div key={t.label} className="tier-row">
              <div className="tier-label" style={{ background: TIER_COLORS[t.label] }}>
                {t.label}
              </div>
              <div className="tier-items">
                {t.itemIds.map((id) => {
                  const item = items.get(id);
                  return item ? (
                    <div key={id} className="tier-item" title={item.name}>
                      <ItemFace item={item} size={52} />
                      <span>{item.name}</span>
                    </div>
                  ) : null;
                })}
              </div>
            </div>
          ))}
          <p className="muted small">Los tiers se arman solos: cortamos donde hay saltos naturales en los puntajes.</p>
        </div>
      )}

      {ranking.unranked.length > 0 && (
        <p className="muted small">
          Sin duelos todavía: {ranking.unranked.map((id) => items.get(id)?.name).filter(Boolean).join(', ')}
        </p>
      )}
    </div>
  );
}

function localStorageGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function localStorageSet(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // private mode etc.: preference just isn't remembered
  }
}
