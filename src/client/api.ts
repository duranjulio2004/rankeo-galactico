// Typed fetch wrapper. Types mirror the server's JSON responses.
import { useCallback, useEffect, useState } from 'react';

export interface User {
  id: number;
  displayName: string;
  isAdmin: boolean;
}

export interface Item {
  id: number;
  name: string;
  emoji: string;
  imageUrl: string;
  archived: boolean;
  createdBy: number;
}

export interface GroupSummary {
  id: number;
  name: string;
  emoji: string;
  memberCount: number;
  listCount: number;
}

export interface ListSummary {
  id: number;
  title: string;
  emoji: string;
  description: string;
  group: { id: number; name: string; emoji: string } | null;
  itemCount: number;
  myVotes: number;
  voters: number;
  myConfidence: number;
}

export interface ListDetail {
  list: { id: number; title: string; description: string; emoji: string; ownerId: number; createdAt: number };
  group: { id: number; name: string; emoji: string } | null;
  members: User[];
  items: Item[];
  excluded: number[];
  canEdit: boolean;
}

export interface Duel {
  pair: { left: Item; right: Item } | null;
  votes: number;
  confidence: number;
  eligibleItems: number;
}

export interface RankedEntry {
  itemId: number;
  rank: number;
  rating: number;
  plusMinus: number;
  wins: number;
  losses: number;
  ties: number;
  tier: string;
}

export interface Ranking {
  ranked: RankedEntry[];
  unranked: number[];
  confidence: number;
  tiers: { label: string; itemIds: number[] }[];
}

export interface PersonalRanking extends Ranking {
  userId: number;
  votes: number;
}

export interface GroupRanking extends Ranking {
  contributors: { userId: number; votes: number; weight: number }[];
}

export interface Insights {
  agreement: { userA: number; userB: number; agreement: number; shared: number }[];
  soulmate: { userId: number; agreement: number; shared: number } | null;
  opposite: { userId: number; agreement: number; shared: number } | null;
  divisive: { itemId: number; spread: number; raters: number }[];
  hotTakes: { userId: number; takes: { itemId: number; delta: number; memberPct: number; groupPct: number }[] }[];
}

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    // Always JSON, even without a body: the server requires it on mutations (CSRF).
    headers: { 'content-type': 'application/json' },
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
    credentials: 'same-origin',
  });
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    // non-JSON (e.g. proxy error page)
  }
  if (!res.ok) {
    const msg = (data as { error?: string } | null)?.error ?? `Error ${res.status}`;
    if (res.status === 401) window.dispatchEvent(new Event('rg:unauthorized'));
    throw new ApiError(res.status, msg);
  }
  return data as T;
}

export const get = <T,>(path: string) => api<T>('GET', path);
export const post = <T,>(path: string, body?: unknown) => api<T>('POST', path, body);
export const patch = <T,>(path: string, body?: unknown) => api<T>('PATCH', path, body);
export const put = <T,>(path: string, body?: unknown) => api<T>('PUT', path, body);
export const del = <T,>(path: string) => api<T>('DELETE', path);

/** Loads `path` (null = don't load). `reload` refetches without clearing data. */
export function useApi<T>(path: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(path !== null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (path === null) return;
    let cancelled = false;
    setLoading(true);
    get<T>(path)
      .then((d) => {
        if (!cancelled) {
          setData(d);
          setError(null);
        }
      })
      .catch((e: Error) => !cancelled && setError(e.message))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [path, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { data, error, loading, reload, setData };
}
