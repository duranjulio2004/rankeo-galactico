import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { fitBradleyTerry, rankingConfidence, sortFits, sigmoid, normalCdf, toRating, type Vote } from '../src/server/ranking/bradleyTerry.ts';
import { selectPair, seededRng, pairKey, type Rng } from '../src/server/ranking/pairing.ts';
import { memberWeights, fitGroup, percentiles, kendallTau, agreementMatrix, divisiveItems, hotTakes, type UserVote } from '../src/server/ranking/group.ts';
import { autoTiers, jenksBreaks } from '../src/server/ranking/tiers.ts';

const ids = (n: number) => Array.from({ length: n }, (_, i) => i + 1);
const order = (fits: ReturnType<typeof fitBradleyTerry>) => sortFits(fits).map((f) => f.id);

/** Kendall tau between a fitted order and the true order (true = ids ascending = best first). */
function tauVsTruth(fitted: number[]): number {
  const pos = new Map(fitted.map((id, k) => [id, k]));
  let c = 0;
  let d = 0;
  const xs = [...pos.keys()];
  for (let i = 0; i < xs.length; i++)
    for (let j = i + 1; j < xs.length; j++) {
      const s = Math.sign(xs[i]! - xs[j]!) * Math.sign(pos.get(xs[i]!)! - pos.get(xs[j]!)!);
      if (s > 0) c++;
      else if (s < 0) d++;
    }
  return (c - d) / ((xs.length * (xs.length - 1)) / 2);
}

/** A simulated voter whose true strengths decrease with id (item 1 is best). */
function simulatedVote(a: number, b: number, rng: Rng, spread = 0.25): Vote {
  const pa = sigmoid(-(a - b) * spread);
  return { a, b, result: rng() < pa ? 1 : 0 };
}

describe('Bradley–Terry fit', () => {
  test('no votes: every item sits at the anchor', () => {
    const fits = fitBradleyTerry(ids(4), []);
    for (const f of fits) {
      assert.equal(f.theta, 0);
      assert.equal(f.games, 0);
      assert.ok(Number.isFinite(f.sigma));
    }
    assert.ok(rankingConfidence(fits) < 1e-6);
  });

  test('a strict cycle-free chain is recovered exactly', () => {
    const votes: Vote[] = [
      { a: 1, b: 2, result: 1 },
      { a: 2, b: 3, result: 1 },
      { a: 3, b: 4, result: 1 },
      { a: 1, b: 3, result: 1 },
      { a: 2, b: 4, result: 1 },
      { a: 1, b: 4, result: 1 },
    ];
    assert.deepEqual(order(fitBradleyTerry(ids(4), votes)), [1, 2, 3, 4]);
  });

  test('vote order does not matter (unlike Elo)', () => {
    const votes: Vote[] = [
      { a: 1, b: 2, result: 1 },
      { a: 2, b: 3, result: 0 },
      { a: 1, b: 3, result: 0.5 },
      { a: 3, b: 4, result: 1 },
    ];
    const f1 = fitBradleyTerry(ids(4), votes);
    const f2 = fitBradleyTerry(ids(4), [...votes].reverse());
    f1.forEach((f, i) => assert.ok(Math.abs(f.theta - f2[i]!.theta) < 1e-6));
  });

  test('undefeated item stays finite and is shrunk by the prior', () => {
    const fits = fitBradleyTerry([1, 2], [{ a: 1, b: 2, result: 1 }]);
    const [a, b] = fits;
    assert.ok(a!.theta > 0 && Number.isFinite(a!.theta));
    assert.ok(b!.theta < 0 && Number.isFinite(b!.theta));
    // One win should not be treated as certainty.
    assert.ok(sigmoid(a!.theta - b!.theta) < 0.8);
  });

  test('ties pull items together; symmetric results give equal strength', () => {
    const fits = fitBradleyTerry([1, 2], [
      { a: 1, b: 2, result: 0.5 },
      { a: 2, b: 1, result: 0.5 },
    ]);
    assert.ok(Math.abs(fits[0]!.theta - fits[1]!.theta) < 1e-9);
    assert.equal(fits[0]!.ties, 2);
  });

  test('votes for unknown, duplicate or invalid items are ignored', () => {
    const fits = fitBradleyTerry([1, 2], [
      { a: 1, b: 99, result: 1 },
      { a: 1, b: 1, result: 1 },
      { a: 1, b: 2, result: 7 },
      { a: 1, b: 2, result: 1, weight: 0 },
    ]);
    for (const f of fits) assert.equal(f.games, 0);
  });

  test('weights scale evidence', () => {
    const light = fitBradleyTerry([1, 2], [{ a: 1, b: 2, result: 1, weight: 0.1 }]);
    const heavy = fitBradleyTerry([1, 2], [{ a: 1, b: 2, result: 1, weight: 5 }]);
    assert.ok(heavy[0]!.theta > light[0]!.theta);
    assert.ok(heavy[0]!.sigma < light[0]!.sigma);
  });

  test('more evidence shrinks uncertainty and raises confidence', () => {
    const few: Vote[] = [{ a: 1, b: 2, result: 1 }, { a: 2, b: 3, result: 1 }];
    const many: Vote[] = [];
    for (let k = 0; k < 10; k++) many.push(...few, { a: 1, b: 3, result: 1 });
    const cFew = rankingConfidence(fitBradleyTerry(ids(3), few));
    const cMany = rankingConfidence(fitBradleyTerry(ids(3), many));
    assert.ok(cMany > cFew, `${cMany} > ${cFew}`);
    assert.ok(cMany > 0.8);
  });

  test('rating scale is Elo-like', () => {
    assert.equal(toRating(0), 1500);
    assert.equal(toRating(Math.LN10), 1900);
  });

  test('normalCdf is accurate', () => {
    assert.ok(Math.abs(normalCdf(0) - 0.5) < 1e-7);
    assert.ok(Math.abs(normalCdf(1.96) - 0.975) < 1e-3);
    assert.ok(Math.abs(normalCdf(-1) - 0.158655) < 1e-5);
  });

  test('handles 300 items × 3000 votes quickly', () => {
    const rng = seededRng(7);
    const votes: Vote[] = [];
    for (let k = 0; k < 3000; k++) {
      const a = 1 + Math.floor(rng() * 300);
      const b = 1 + Math.floor(rng() * 300);
      if (a !== b) votes.push(simulatedVote(a, b, rng, 0.02));
    }
    const t0 = performance.now();
    const fits = fitBradleyTerry(ids(300), votes);
    const ms = performance.now() - t0;
    assert.ok(tauVsTruth(order(fits)) > 0.7);
    assert.ok(ms < 1000, `took ${ms}ms`);
  });
});

describe('pair selection', () => {
  test('returns null for fewer than two items', () => {
    assert.equal(selectPair({ fits: fitBradleyTerry([1], []), pairCounts: new Map() }), null);
  });

  test('every item appears once before any item repeats (cold start)', () => {
    const rng = seededRng(1);
    const items = ids(10);
    const votes: Vote[] = [];
    const seen = new Set<number>();
    for (let k = 0; k < 5; k++) {
      const fits = fitBradleyTerry(items, votes);
      const pair = selectPair({ fits, pairCounts: new Map(), rng })!;
      assert.ok(!seen.has(pair.left) || !seen.has(pair.right), 'one side must be a new item');
      seen.add(pair.left).add(pair.right);
      votes.push({ a: pair.left, b: pair.right, result: 1 });
    }
    // 5 duels with a forced unseen item each: at least 5 distinct new items.
    assert.ok(seen.size >= 6);
  });

  test('prefers close, uncertain matchups over settled ones', () => {
    // 1 >> 2 is settled; 3 vs 4 never met and are equal.
    const votes: Vote[] = [];
    for (let k = 0; k < 20; k++) votes.push({ a: 1, b: 2, result: 1 });
    votes.push({ a: 3, b: 1, result: 0 }, { a: 4, b: 2, result: 1 }, { a: 3, b: 2, result: 1 });
    const fits = fitBradleyTerry(ids(4), votes);
    const counts = new Map([[pairKey(1, 2), 20]]);
    const picks = new Map<string, number>();
    const rng = seededRng(3);
    for (let k = 0; k < 200; k++) {
      const p = selectPair({ fits, pairCounts: counts, rng, topK: 2 })!;
      const key = pairKey(p.left, p.right);
      picks.set(key, (picks.get(key) ?? 0) + 1);
    }
    assert.equal(picks.get(pairKey(1, 2)) ?? 0, 0);
    assert.ok((picks.get(pairKey(3, 4)) ?? 0) > 50);
  });

  test('avoids items from the last duel when there is a choice', () => {
    const fits = fitBradleyTerry(ids(6), [
      { a: 1, b: 2, result: 1 }, { a: 3, b: 4, result: 1 }, { a: 5, b: 6, result: 1 },
    ]);
    const rng = seededRng(5);
    for (let k = 0; k < 50; k++) {
      const p = selectPair({ fits, pairCounts: new Map(), recentItems: [1, 2], rng, topK: 1 })!;
      assert.ok(![1, 2].includes(p.left) && ![1, 2].includes(p.right));
    }
  });

  test('randomizes left/right placement', () => {
    const fits = fitBradleyTerry([1, 2], [{ a: 1, b: 2, result: 1 }]);
    const rng = seededRng(9);
    let left1 = 0;
    for (let k = 0; k < 200; k++) if (selectPair({ fits, pairCounts: new Map(), rng })!.left === 1) left1++;
    assert.ok(left1 > 60 && left1 < 140);
  });

  /** Runs a noisy simulated voter for `budget` duels; returns tau vs truth. */
  function simulate(n: number, budget: number, seed: number, strategy: 'active' | 'random', spread = 1): number {
    const rng = seededRng(seed);
    const items = ids(n);
    const votes: Vote[] = [];
    const counts = new Map<string, number>();
    let recent: number[] = [];
    for (let k = 0; k < budget; k++) {
      let a: number;
      let b: number;
      if (strategy === 'active') {
        const p = selectPair({ fits: fitBradleyTerry(items, votes), pairCounts: counts, recentItems: recent, rng })!;
        a = p.left;
        b = p.right;
      } else {
        a = 1 + Math.floor(rng() * n);
        do b = 1 + Math.floor(rng() * n);
        while (b === a);
      }
      votes.push(simulatedVote(a, b, rng, spread));
      counts.set(pairKey(a, b), (counts.get(pairKey(a, b)) ?? 0) + 1);
      recent = [a, b];
    }
    return tauVsTruth(order(fitBradleyTerry(items, votes)));
  }

  const mean = (xs: number[]) => xs.reduce((x, y) => x + y) / xs.length;
  const seeds = ids(20);

  // Measured on 2026-10-06 (20 seeds, 20 items): consistent voter (spread 1)
  // active 60 duels τ≈0.87 vs random τ≈0.76; noisy voter (spread 0.3) at 100
  // duels active τ≈0.78 vs random τ≈0.76. Thresholds leave some margin.
  test('consistent simulated voter: 60 duels over 20 items recovers the order (τ > 0.8)', () => {
    const tau = mean(seeds.map((s) => simulate(20, 60, s, 'active')));
    assert.ok(tau > 0.8, `mean tau ${tau.toFixed(3)}`);
  });

  test('active selection clearly beats random pairs for a consistent voter', () => {
    const active = mean(seeds.map((s) => simulate(20, 60, s, 'active')));
    const random = mean(seeds.map((s) => simulate(20, 60, s + 1000, 'random')));
    assert.ok(active - random > 0.05, `active ${active.toFixed(3)} vs random ${random.toFixed(3)}`);
  });

  test('active selection is no worse than random for a very noisy voter', () => {
    const active = mean(seeds.map((s) => simulate(20, 100, s, 'active', 0.3)));
    const random = mean(seeds.map((s) => simulate(20, 100, s + 1000, 'random', 0.3)));
    assert.ok(active >= random, `active ${active.toFixed(3)} vs random ${random.toFixed(3)}`);
  });
});

describe('group aggregation', () => {
  test('member weights cap heavy voters and never amplify light ones', () => {
    const w = memberWeights(new Map([[1, 10], [2, 40], [3, 400], [4, 0]]));
    assert.equal(w.get(1), 1);
    assert.equal(w.get(2), 1);
    assert.equal(w.get(3), 0.1);
    assert.equal(w.has(4), false);
  });

  test('a single heavy voter cannot override the rest of the group', () => {
    // Three friends think 1 > 2 (10 votes each); one fan votes 2 > 1 two hundred times.
    const votes: UserVote[] = [];
    for (const u of [1, 2, 3]) for (let k = 0; k < 10; k++) votes.push({ userId: u, a: 1, b: 2, result: 1 });
    for (let k = 0; k < 200; k++) votes.push({ userId: 4, a: 1, b: 2, result: 0 });
    const { fits } = fitGroup([1, 2], votes);
    assert.deepEqual(order(fits), [1, 2]);
  });

  test('a member\'s exclusions drop only their own votes on that item', () => {
    const votes: UserVote[] = [
      { userId: 1, a: 1, b: 2, result: 0 },
      { userId: 1, a: 1, b: 2, result: 0 },
      { userId: 2, a: 1, b: 2, result: 1 },
    ];
    const { fits } = fitGroup([1, 2], votes, new Map([[1, new Set([2])]]));
    assert.deepEqual(order(fits), [1, 2]);
    assert.equal(fits[0]!.games, 1);
  });

  test('percentiles ignore unvoted items', () => {
    const fits = fitBradleyTerry(ids(3), [{ a: 1, b: 2, result: 1 }]);
    const p = percentiles(fits);
    assert.deepEqual([...p.entries()].sort(), [[1, 0], [2, 1]]);
  });

  test('kendall tau: identical = 1, reversed = -1, too few shared = null', () => {
    const a = new Map([[1, 0], [2, 0.5], [3, 1]]);
    const rev = new Map([[1, 1], [2, 0.5], [3, 0]]);
    assert.equal(kendallTau(a, a), 1);
    assert.equal(kendallTau(a, rev), -1);
    assert.equal(kendallTau(a, new Map([[1, 0], [2, 1]])), null);
  });

  test('agreement, divisive items and hot takes', () => {
    const alice = new Map([[1, 0], [2, 0.5], [3, 1]]);
    const bob = new Map([[1, 0], [2, 0.5], [3, 1]]);
    const carol = new Map([[1, 1], [2, 0.5], [3, 0]]);
    const members = new Map([[1, alice], [2, bob], [3, carol]]);
    const agree = agreementMatrix(members);
    const ab = agree.find((x) => x.userA === 1 && x.userB === 2)!;
    const ac = agree.find((x) => x.userA === 1 && x.userB === 3)!;
    assert.equal(ab.agreement, 1);
    assert.equal(ac.agreement, 0);

    const div = divisiveItems(members);
    assert.equal(div.at(-1)!.itemId, 2); // everyone puts 2 in the middle
    assert.equal(div.at(-1)!.spread, 0);

    const takes = hotTakes(carol, alice);
    assert.deepEqual(takes.map((t) => t.itemId).sort(), [1, 3]);
    assert.ok(takes.find((t) => t.itemId === 3)!.delta < 0); // carol loves 3 more than the group
  });
});

describe('tiers', () => {
  test('jenks splits obvious clusters', () => {
    assert.deepEqual(jenksBreaks([10, 9.9, 9.8, 5, 4.9, 1, 0.9], 3), [0, 3, 5]);
  });

  test('no spread → one tier', () => {
    const tiers = autoTiers([1, 2, 3], () => 0);
    assert.equal(tiers.length, 1);
    assert.equal(tiers[0]!.label, 'S');
    assert.equal(tiers[0]!.items.length, 3);
  });

  test('clear clusters become labelled tiers in order', () => {
    const scores = new Map([[1, 3], [2, 2.9], [3, 0.1], [4, 0], [5, -3]]);
    const tiers = autoTiers([...scores.keys()], (id) => scores.get(id)!);
    assert.deepEqual(tiers.map((t) => t.label), ['S', 'A', 'B']);
    assert.deepEqual(tiers.map((t) => t.items), [[1, 2], [3, 4], [5]]);
  });

  test('never more than six tiers, every item placed once', () => {
    const items = ids(50);
    const tiers = autoTiers(items, (id) => Math.sin(id) * 5 + id / 10);
    assert.ok(tiers.length <= 6);
    assert.equal(tiers.flatMap((t) => t.items).length, 50);
  });
});
