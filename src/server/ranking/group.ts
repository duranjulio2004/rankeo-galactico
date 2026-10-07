// Group aggregation and social insights. See DESIGN.md §3.4–3.5.
import { fitBradleyTerry, sortFits, type ItemFit, type Vote } from './bradleyTerry.ts';

export interface UserVote extends Vote {
  userId: number;
}

function median(xs: readonly number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** w_u = min(1, median / n_u): caps heavy voters, never amplifies light ones. */
export function memberWeights(voteCounts: ReadonlyMap<number, number>): Map<number, number> {
  const counts = [...voteCounts.values()].filter((n) => n > 0);
  const weights = new Map<number, number>();
  if (counts.length === 0) return weights;
  const m = median(counts);
  for (const [user, n] of voteCounts) if (n > 0) weights.set(user, Math.min(1, m / n));
  return weights;
}

/**
 * Group fit over everyone's votes. A member's "no lo conozco" exclusions drop
 * only their own votes on that item; others' votes on it still count.
 */
export function fitGroup(
  itemIds: readonly number[],
  votes: readonly UserVote[],
  exclusions: ReadonlyMap<number, ReadonlySet<number>> = new Map(),
): { fits: ItemFit[]; weights: Map<number, number> } {
  const usable = votes.filter((v) => {
    const ex = exclusions.get(v.userId);
    return !ex || (!ex.has(v.a) && !ex.has(v.b));
  });
  const counts = new Map<number, number>();
  for (const v of usable) counts.set(v.userId, (counts.get(v.userId) ?? 0) + 1);
  const weights = memberWeights(counts);
  const weighted = usable.map((v) => ({ ...v, weight: weights.get(v.userId) ?? 0 }));
  return { fits: fitBradleyTerry(itemIds, weighted), weights };
}

/**
 * Percentile position of each *ranked* item (one the member actually voted on):
 * 0 = top, 1 = bottom. Unvoted items are omitted because their position is
 * just the prior, not an opinion.
 */
export function percentiles(fits: readonly ItemFit[]): Map<number, number> {
  const ranked = sortFits(fits.filter((f) => f.games > 0));
  const out = new Map<number, number>();
  ranked.forEach((f, k) => out.set(f.id, ranked.length > 1 ? k / (ranked.length - 1) : 0.5));
  return out;
}

/**
 * Kendall's tau-a between two percentile maps over their shared items.
 * Returns null when they share fewer than `minShared` items.
 */
export function kendallTau(a: ReadonlyMap<number, number>, b: ReadonlyMap<number, number>, minShared = 3): number | null {
  const shared = [...a.keys()].filter((id) => b.has(id));
  if (shared.length < minShared) return null;
  let concordant = 0;
  let discordant = 0;
  for (let i = 0; i < shared.length; i++) {
    for (let j = i + 1; j < shared.length; j++) {
      const da = a.get(shared[i]!)! - a.get(shared[j]!)!;
      const db = b.get(shared[i]!)! - b.get(shared[j]!)!;
      const s = Math.sign(da) * Math.sign(db);
      if (s > 0) concordant++;
      else if (s < 0) discordant++;
    }
  }
  const pairs = (shared.length * (shared.length - 1)) / 2;
  return (concordant - discordant) / pairs;
}

export interface Agreement {
  userA: number;
  userB: number;
  /** 0..1, from Kendall tau mapped as (tau + 1) / 2. */
  agreement: number;
  shared: number;
}

export function agreementMatrix(memberPercentiles: ReadonlyMap<number, ReadonlyMap<number, number>>): Agreement[] {
  const users = [...memberPercentiles.keys()].sort((x, y) => x - y);
  const out: Agreement[] = [];
  for (let i = 0; i < users.length; i++) {
    for (let j = i + 1; j < users.length; j++) {
      const pa = memberPercentiles.get(users[i]!)!;
      const pb = memberPercentiles.get(users[j]!)!;
      const tau = kendallTau(pa, pb);
      if (tau === null) continue;
      const shared = [...pa.keys()].filter((id) => pb.has(id)).length;
      out.push({ userA: users[i]!, userB: users[j]!, agreement: (tau + 1) / 2, shared });
    }
  }
  return out;
}

export interface Divisive {
  itemId: number;
  /** Standard deviation of members' percentiles (0 = consensus, ~0.5 = split). */
  spread: number;
  raters: number;
}

export function divisiveItems(memberPercentiles: ReadonlyMap<number, ReadonlyMap<number, number>>, minRaters = 2): Divisive[] {
  const byItem = new Map<number, number[]>();
  for (const pct of memberPercentiles.values()) {
    for (const [item, p] of pct) {
      const arr = byItem.get(item) ?? [];
      arr.push(p);
      byItem.set(item, arr);
    }
  }
  const out: Divisive[] = [];
  for (const [itemId, ps] of byItem) {
    if (ps.length < minRaters) continue;
    const mean = ps.reduce((s, p) => s + p, 0) / ps.length;
    const variance = ps.reduce((s, p) => s + (p - mean) ** 2, 0) / ps.length;
    out.push({ itemId, spread: Math.sqrt(variance), raters: ps.length });
  }
  return out.sort((x, y) => y.spread - x.spread || x.itemId - y.itemId);
}

export interface HotTake {
  itemId: number;
  /** member percentile − group percentile: negative = member ranks it higher than the group. */
  delta: number;
  memberPct: number;
  groupPct: number;
}

export function hotTakes(member: ReadonlyMap<number, number>, group: ReadonlyMap<number, number>, limit = 3, minDelta = 0.25): HotTake[] {
  const out: HotTake[] = [];
  for (const [itemId, memberPct] of member) {
    const groupPct = group.get(itemId);
    if (groupPct === undefined) continue;
    const delta = memberPct - groupPct;
    if (Math.abs(delta) >= minDelta) out.push({ itemId, delta, memberPct, groupPct });
  }
  return out.sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta) || x.itemId - y.itemId).slice(0, limit);
}
