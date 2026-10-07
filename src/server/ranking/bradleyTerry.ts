// Bradley–Terry model fitted by Hunter's MM algorithm, with a weak prior.
// See DESIGN.md §3.1 for the reasoning behind each choice here.

export interface Vote {
  a: number;
  b: number;
  /** 1 = a wins, 0 = b wins, 0.5 = tie */
  result: number;
  /** Defaults to 1. Used by group aggregation to cap heavy voters. */
  weight?: number;
}

export interface ItemFit {
  id: number;
  /** Log-strength. 0 is the "average" virtual anchor. */
  theta: number;
  /** Approximate posterior standard deviation of theta. */
  sigma: number;
  /** Weighted counts of real (non-prior) games. */
  wins: number;
  losses: number;
  ties: number;
  games: number;
}

export interface FitOptions {
  /** Virtual games against the anchor: this many wins and as many losses. */
  priorGames?: number;
  maxIterations?: number;
  tolerance?: number;
}

const ELO_SCALE = 400 / Math.LN10;

export function toRating(theta: number): number {
  return Math.round(1500 + ELO_SCALE * theta);
}

/**
 * Fits strengths for `itemIds` from `votes`. Votes referencing items outside
 * `itemIds` (archived, excluded) are ignored, so callers can pass raw votes.
 * Returns fits in the same order as `itemIds`.
 */
export function fitBradleyTerry(itemIds: readonly number[], votes: readonly Vote[], opts: FitOptions = {}): ItemFit[] {
  const prior = opts.priorGames ?? 1;
  const maxIterations = opts.maxIterations ?? 5000;
  const tolerance = opts.tolerance ?? 1e-9;
  const n = itemIds.length;
  const index = new Map<number, number>();
  itemIds.forEach((id, i) => index.set(id, i));

  // Win totals and per-pair game weights (symmetric sparse adjacency).
  const wins = new Float64Array(n);
  const losses = new Float64Array(n);
  const ties = new Float64Array(n);
  const neighbours: Map<number, number>[] = Array.from({ length: n }, () => new Map());

  for (const v of votes) {
    const i = index.get(v.a);
    const j = index.get(v.b);
    if (i === undefined || j === undefined || i === j) continue;
    const w = v.weight ?? 1;
    if (!(w > 0)) continue;
    if (v.result === 0.5) {
      ties[i]! += w;
      ties[j]! += w;
    } else if (v.result === 1) {
      wins[i]! += w;
      losses[j]! += w;
    } else if (v.result === 0) {
      wins[j]! += w;
      losses[i]! += w;
    } else {
      continue;
    }
    const pairTotal = (neighbours[i]!.get(j) ?? 0) + w;
    neighbours[i]!.set(j, pairTotal);
    neighbours[j]!.set(i, pairTotal);
  }

  // Effective wins: real wins + half the ties + prior virtual wins.
  const W = new Float64Array(n);
  for (let i = 0; i < n; i++) W[i] = wins[i]! + ties[i]! / 2 + prior;

  const gamma = new Float64Array(n).fill(1);
  for (let iter = 0; iter < maxIterations; iter++) {
    let maxDelta = 0;
    for (let i = 0; i < n; i++) {
      const gi = gamma[i]!;
      let denom = (2 * prior) / (gi + 1); // virtual games vs anchor (γ = 1)
      for (const [j, nij] of neighbours[i]!) denom += nij / (gi + gamma[j]!);
      if (denom <= 0) continue; // no prior and no games: leave at 1
      const next = W[i]! / denom;
      // Without a prior, a winless item would collapse to 0; clamp so logs stay finite.
      const clamped = Math.min(Math.max(next, 1e-12), 1e12);
      const delta = Math.abs(Math.log(clamped) - Math.log(gi));
      if (delta > maxDelta) maxDelta = delta;
      gamma[i] = clamped; // in-place (cyclic) update converges faster and stays monotone
    }
    if (maxDelta < tolerance) break;
  }

  return itemIds.map((id, i) => {
    const theta = Math.log(gamma[i]!);
    let info = 0;
    const pAnchor = sigmoid(theta);
    info += 2 * prior * pAnchor * (1 - pAnchor);
    for (const [j, nij] of neighbours[i]!) {
      const p = sigmoid(theta - Math.log(gamma[j]!));
      info += nij * p * (1 - p);
    }
    return {
      id,
      theta,
      sigma: info > 0 ? 1 / Math.sqrt(info) : Infinity,
      wins: wins[i]!,
      losses: losses[i]!,
      ties: ties[i]!,
      games: wins[i]! + losses[i]! + ties[i]!,
    };
  });
}

export function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

/** Standard normal CDF (Abramowitz–Stegun 7.1.26 erf approximation, |err| < 1.5e-7). */
export function normalCdf(x: number): number {
  const z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * z);
  const erf = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z);
  return x >= 0 ? (1 + erf) / 2 : (1 - erf) / 2;
}

/** Sorts fits best-first; ties broken by more games, then id for determinism. */
export function sortFits(fits: readonly ItemFit[]): ItemFit[] {
  return [...fits].sort((x, y) => y.theta - x.theta || y.games - x.games || x.id - y.id);
}

/**
 * Ranking confidence in [0, 1]: the mean, over all pairs, of the probability
 * that the pair is in the right order, rescaled from [0.5, 1]. That is roughly the
 * expected Kendall τ between this ranking and the user's "true" one.
 * See DESIGN.md §3.2 for why not adjacent pairs only.
 */
export function rankingConfidence(fits: readonly ItemFit[]): number {
  if (fits.length < 2) return fits.length === 1 ? 1 : 0;
  let total = 0;
  for (let i = 0; i < fits.length; i++) {
    for (let j = i + 1; j < fits.length; j++) {
      const x = fits[i]!;
      const y = fits[j]!;
      const sd = Math.sqrt(x.sigma ** 2 + y.sigma ** 2);
      total += Number.isFinite(sd) && sd > 0 ? normalCdf(Math.abs(x.theta - y.theta) / sd) : 0.5;
    }
  }
  const mean = total / ((fits.length * (fits.length - 1)) / 2);
  return Math.max(0, Math.min(1, (mean - 0.5) * 2));
}
