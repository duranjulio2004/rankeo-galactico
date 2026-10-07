// Active pair selection: pick the duel that teaches the model the most.
// See DESIGN.md §3.3.
import { sigmoid, type ItemFit } from './bradleyTerry.ts';

export type Rng = () => number;

/** Small seeded PRNG (mulberry32) so selection is reproducible in tests. */
export function seededRng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function pairKey(a: number, b: number): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

export interface PairContext {
  /** Fits for the items eligible for this user's duels (not archived, not excluded). */
  fits: readonly ItemFit[];
  /** How many times this user has already judged each pair (key from pairKey). */
  pairCounts: ReadonlyMap<string, number>;
  /** Items shown in the user's most recent duels, newest first. */
  recentItems?: readonly number[];
  rng?: Rng;
  /** Sample among this many best candidates. */
  topK?: number;
}

export interface Pair {
  left: number;
  right: number;
}

const REPEAT_DECAY = 0.5;
const RECENT_PENALTY = 0.15;

export function pairScore(x: ItemFit, y: ItemFit, timesCompared: number, recent: ReadonlySet<number>): number {
  const p = sigmoid(x.theta - y.theta);
  const sx = Number.isFinite(x.sigma) ? x.sigma : 10;
  const sy = Number.isFinite(y.sigma) ? y.sigma : 10;
  let score = p * (1 - p) * (sx * sx + sy * sy);
  score *= REPEAT_DECAY ** timesCompared;
  if (recent.has(x.id)) score *= RECENT_PENALTY;
  if (recent.has(y.id)) score *= RECENT_PENALTY;
  return score;
}

export function selectPair(ctx: PairContext): Pair | null {
  const { fits, pairCounts } = ctx;
  if (fits.length < 2) return null;
  const rng = ctx.rng ?? Math.random;
  const topK = ctx.topK ?? 5;
  const recent = new Set(ctx.recentItems ?? []);
  const count = (a: number, b: number) => pairCounts.get(pairKey(a, b)) ?? 0;

  // Cold start: if some items have never been in a duel, force one of them in,
  // so a new item is seen right away instead of waiting for its score to win.
  const unseen = fits.filter((f) => f.games === 0);
  let anchors: readonly ItemFit[] = fits;
  if (unseen.length > 0) {
    const fresh = unseen.filter((f) => !recent.has(f.id));
    const pool = fresh.length > 0 ? fresh : unseen;
    anchors = [pool[Math.floor(rng() * pool.length)]!];
  }

  const candidates: { x: ItemFit; y: ItemFit; score: number }[] = [];
  for (const x of anchors) {
    for (const y of fits) {
      if (x.id === y.id) continue;
      // When scanning all pairs, visit each unordered pair once.
      if (anchors === fits && y.id < x.id) continue;
      candidates.push({ x, y, score: pairScore(x, y, count(x.id, y.id), recent) });
    }
  }
  candidates.sort((u, v) => v.score - u.score);
  const top = candidates.slice(0, topK);
  const total = top.reduce((s, c) => s + c.score, 0);
  let pick = top[0]!;
  if (total > 0) {
    let r = rng() * total;
    for (const c of top) {
      r -= c.score;
      if (r <= 0) {
        pick = c;
        break;
      }
    }
  }
  // Randomize sides to cancel any left/right position bias.
  return rng() < 0.5 ? { left: pick.x.id, right: pick.y.id } : { left: pick.y.id, right: pick.x.id };
}
