// Glue between the database and the pure ranking engine.
// Everything here is computed from raw votes on each call (DESIGN.md §3).
import type { Db } from './db.ts';
import { fitBradleyTerry, rankingConfidence, sortFits, toRating, type ItemFit } from './ranking/bradleyTerry.ts';
import { selectPair, pairKey, type Pair } from './ranking/pairing.ts';
import { fitGroup, percentiles, agreementMatrix, divisiveItems, hotTakes, type UserVote } from './ranking/group.ts';
import { autoTiers } from './ranking/tiers.ts';

export interface ListRow {
  id: number;
  title: string;
  description: string;
  emoji: string;
  group_id: number | null;
  owner_id: number;
  created_at: number;
}

function activeItemIds(db: Db, listId: number): number[] {
  return (db.prepare('SELECT id FROM items WHERE list_id = ? AND archived = 0 ORDER BY id').all(listId) as { id: number }[]).map((r) => r.id);
}

function userExclusions(db: Db, listId: number, userId: number): Set<number> {
  const rows = db
    .prepare('SELECT e.item_id FROM exclusions e JOIN items i ON i.id = e.item_id WHERE i.list_id = ? AND e.user_id = ?')
    .all(listId, userId) as { item_id: number }[];
  return new Set(rows.map((r) => r.item_id));
}

function userVotes(db: Db, listId: number, userId: number): UserVote[] {
  return db
    .prepare('SELECT user_id AS userId, item_a AS a, item_b AS b, result FROM votes WHERE list_id = ? AND user_id = ? ORDER BY id')
    .all(listId, userId) as unknown as UserVote[];
}

/** Members whose votes count for a list: the group's current members, or just the owner. */
export function listParticipants(db: Db, list: ListRow): number[] {
  if (list.group_id === null) return [list.owner_id];
  return (db.prepare('SELECT user_id FROM group_members WHERE group_id = ? ORDER BY user_id').all(list.group_id) as { user_id: number }[]).map((r) => r.user_id);
}

export function personalFits(db: Db, listId: number, userId: number): ItemFit[] {
  const excluded = userExclusions(db, listId, userId);
  const items = activeItemIds(db, listId).filter((id) => !excluded.has(id));
  return fitBradleyTerry(items, userVotes(db, listId, userId));
}

export interface DuelState {
  pair: Pair | null;
  votes: number;
  confidence: number;
  eligibleItems: number;
}

export function nextDuel(db: Db, listId: number, userId: number, avoid: readonly number[] = []): DuelState {
  const fits = personalFits(db, listId, userId);
  const votes = userVotes(db, listId, userId);
  const pairCounts = new Map<string, number>();
  for (const v of votes) {
    const k = pairKey(v.a, v.b);
    pairCounts.set(k, (pairCounts.get(k) ?? 0) + 1);
  }
  // Recently shown items: explicit "avoid" (skipped duel) plus the last two votes.
  const recent = [...avoid];
  for (const v of votes.slice(-2).reverse()) recent.push(v.a, v.b);
  return {
    pair: selectPair({ fits, pairCounts, recentItems: recent }),
    votes: votes.length,
    confidence: rankingConfidence(fits),
    eligibleItems: fits.length,
  };
}

export interface RankedEntry {
  itemId: number;
  rank: number;
  rating: number;
  /** Half-width of a ~95 % interval, in rating points. */
  plusMinus: number;
  wins: number;
  losses: number;
  ties: number;
  tier: string;
}

export interface RankingView {
  ranked: RankedEntry[];
  /** Eligible items nobody (in this scope) has dueled yet. */
  unranked: number[];
  confidence: number;
  tiers: { label: string; itemIds: number[] }[];
}

const RATING_PER_THETA = 400 / Math.LN10;

export function rankingView(fits: readonly ItemFit[]): RankingView {
  const ranked = sortFits(fits.filter((f) => f.games > 0));
  const tiers = autoTiers(ranked, (f) => f.theta);
  const tierOf = new Map<number, string>();
  for (const t of tiers) for (const f of t.items) tierOf.set(f.id, t.label);
  const round1 = (x: number) => Math.round(x * 10) / 10;
  return {
    ranked: ranked.map((f, k) => ({
      itemId: f.id,
      rank: k + 1,
      rating: toRating(f.theta),
      plusMinus: Math.round(1.96 * f.sigma * RATING_PER_THETA),
      wins: round1(f.wins),
      losses: round1(f.losses),
      ties: round1(f.ties),
      tier: tierOf.get(f.id)!,
    })),
    unranked: fits.filter((f) => f.games === 0).map((f) => f.id),
    // Over all eligible items, so it matches the duel screen's progress bar:
    // an item nobody has dueled is genuinely unplaced.
    confidence: rankingConfidence(fits),
    tiers: tiers.map((t) => ({ label: t.label, itemIds: t.items.map((f) => f.id) })),
  };
}

/** All votes on the list by current participants, plus everyone's exclusions. */
function groupInputs(db: Db, list: ListRow) {
  const members = new Set(listParticipants(db, list));
  const votes = (
    db.prepare('SELECT user_id AS userId, item_a AS a, item_b AS b, result FROM votes WHERE list_id = ? ORDER BY id').all(list.id) as unknown as UserVote[]
  ).filter((v) => members.has(v.userId));
  const exclusions = new Map<number, Set<number>>();
  const rows = db
    .prepare('SELECT e.user_id, e.item_id FROM exclusions e JOIN items i ON i.id = e.item_id WHERE i.list_id = ?')
    .all(list.id) as { user_id: number; item_id: number }[];
  for (const r of rows) {
    if (!members.has(r.user_id)) continue;
    const set = exclusions.get(r.user_id) ?? new Set<number>();
    set.add(r.item_id);
    exclusions.set(r.user_id, set);
  }
  return { members: [...members], votes, exclusions };
}

export function groupRanking(db: Db, list: ListRow) {
  const { votes, exclusions } = groupInputs(db, list);
  const { fits, weights } = fitGroup(activeItemIds(db, list.id), votes, exclusions);
  const counts = new Map<number, number>();
  for (const v of votes) counts.set(v.userId, (counts.get(v.userId) ?? 0) + 1);
  return {
    view: rankingView(fits),
    fits,
    contributors: [...counts.entries()].map(([userId, votes]) => ({ userId, votes, weight: Math.round((weights.get(userId) ?? 0) * 100) / 100 })),
  };
}

export function groupInsights(db: Db, list: ListRow, viewerId: number) {
  const { members, votes, exclusions } = groupInputs(db, list);
  const items = activeItemIds(db, list.id);
  const { fits: groupFits } = fitGroup(items, votes, exclusions);
  const groupPct = percentiles(groupFits);

  const memberPct = new Map<number, Map<number, number>>();
  for (const userId of members) {
    const ex = exclusions.get(userId) ?? new Set<number>();
    const mine = votes.filter((v) => v.userId === userId);
    if (mine.length === 0) continue;
    memberPct.set(userId, percentiles(fitBradleyTerry(items.filter((id) => !ex.has(id)), mine)));
  }

  const agreement = agreementMatrix(memberPct).map((a) => ({ ...a, agreement: Math.round(a.agreement * 100) / 100 }));
  const mine = agreement
    .filter((a) => a.userA === viewerId || a.userB === viewerId)
    .map((a) => ({ userId: a.userA === viewerId ? a.userB : a.userA, agreement: a.agreement, shared: a.shared }))
    .sort((x, y) => y.agreement - x.agreement);
  const r2 = (x: number) => Math.round(x * 100) / 100;

  return {
    agreement,
    soulmate: mine[0] ?? null,
    opposite: mine.length > 1 ? mine.at(-1)! : null,
    divisive: divisiveItems(memberPct)
      .slice(0, 5)
      .filter((d) => d.spread > 0.15)
      .map((d) => ({ ...d, spread: r2(d.spread) })),
    hotTakes: [...memberPct.entries()].map(([userId, pct]) => ({
      userId,
      takes: hotTakes(pct, groupPct).map((t) => ({ itemId: t.itemId, delta: r2(t.delta), memberPct: r2(t.memberPct), groupPct: r2(t.groupPct) })),
    })),
  };
}
