// Auto tier list: optimal 1-D partition of scores (Jenks natural breaks via
// dynamic programming), with the number of tiers chosen as the smallest k
// whose goodness-of-variance-fit reaches a threshold. See DESIGN.md §3.6.

export const TIER_LABELS = ['S', 'A', 'B', 'C', 'D', 'F'] as const;

export interface Tier<T> {
  label: string;
  items: T[];
}

/**
 * Splits values (any order) into contiguous classes, minimizing within-class
 * sum of squared deviations. Returns class boundaries as start indices into
 * the descending-sorted array.
 */
export function jenksBreaks(sortedDesc: readonly number[], k: number): number[] {
  const n = sortedDesc.length;
  if (k <= 1 || n <= 1) return [0];
  k = Math.min(k, n);
  // Prefix sums for O(1) SSD of any range [i, j).
  const s1 = new Float64Array(n + 1);
  const s2 = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) {
    s1[i + 1] = s1[i]! + sortedDesc[i]!;
    s2[i + 1] = s2[i]! + sortedDesc[i]! ** 2;
  }
  const ssd = (i: number, j: number) => {
    const m = j - i;
    const sum = s1[j]! - s1[i]!;
    return s2[j]! - s2[i]! - (sum * sum) / m;
  };
  // cost[c][j]: best cost of splitting the first j values into c classes.
  const cost: Float64Array[] = Array.from({ length: k + 1 }, () => new Float64Array(n + 1).fill(Infinity));
  const back: Int32Array[] = Array.from({ length: k + 1 }, () => new Int32Array(n + 1));
  cost[0]![0] = 0;
  for (let c = 1; c <= k; c++) {
    for (let j = c; j <= n; j++) {
      for (let i = c - 1; i < j; i++) {
        const v = cost[c - 1]![i]! + ssd(i, j);
        if (v < cost[c]![j]!) {
          cost[c]![j] = v;
          back[c]![j] = i;
        }
      }
    }
  }
  const starts: number[] = [];
  let j = n;
  for (let c = k; c >= 1; c--) {
    const i = back[c]![j]!;
    starts.unshift(i);
    j = i;
  }
  return starts;
}

function totalSsd(xs: readonly number[]): number {
  const mean = xs.reduce((s, x) => s + x, 0) / xs.length;
  return xs.reduce((s, x) => s + (x - mean) ** 2, 0);
}

function classSsd(xs: readonly number[], starts: readonly number[]): number {
  let total = 0;
  for (let c = 0; c < starts.length; c++) {
    const part = xs.slice(starts[c], starts[c + 1] ?? xs.length);
    total += totalSsd(part);
  }
  return total;
}

/**
 * Groups items into S/A/B/... tiers by score. `minSpread` is the score range
 * below which everything is considered one tier (e.g. no votes yet).
 */
export function autoTiers<T>(items: readonly T[], score: (t: T) => number, opts: { gvf?: number; minSpread?: number } = {}): Tier<T>[] {
  const gvfTarget = opts.gvf ?? 0.85;
  const minSpread = opts.minSpread ?? 0.2;
  const sorted = [...items].sort((a, b) => score(b) - score(a));
  if (sorted.length === 0) return [];
  const xs = sorted.map(score);
  const total = totalSsd(xs);
  let starts = [0];
  if (xs[0]! - xs[xs.length - 1]! >= minSpread && total > 0) {
    const maxK = Math.min(TIER_LABELS.length, xs.length);
    for (let k = 2; k <= maxK; k++) {
      starts = jenksBreaks(xs, k);
      if (1 - classSsd(xs, starts) / total >= gvfTarget) break;
    }
  }
  return starts.map((start, c) => ({
    label: TIER_LABELS[c]!,
    items: sorted.slice(start, starts[c + 1] ?? sorted.length),
  }));
}
