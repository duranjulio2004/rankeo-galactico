// No accounts or passwords (DESIGN.md §4.2): people enter with a code + name,
// and a long-lived session cookie is their identity. A personal access key
// (shown as a link) lets them get back in from another device.
import { randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { now, type Db } from './db.ts';

export const SESSION_TTL_MS = 365 * 24 * 60 * 60 * 1000;
/** Sessions are pushed back to a full TTL at most once a day while in use. */
const RENEW_AFTER_MS = 24 * 60 * 60 * 1000;

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const randomToken = () => randomBytes(32).toString('base64url');

/** Constant-time string comparison (for the admin code). */
export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(sha256(a));
  const y = Buffer.from(sha256(b));
  return timingSafeEqual(x, y);
}

export function createSession(db: Db, userId: number): string {
  const token = randomToken();
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(sha256(token), userId, now() + SESSION_TTL_MS);
  return token;
}

export interface SessionUser {
  id: number;
  displayName: string;
  isAdmin: boolean;
}

/** Looks up the session's user. `renewed` is true when the expiry was extended (refresh the cookie). */
export function userForSession(db: Db, token: string): { user: SessionUser; renewed: boolean } | null {
  const hash = sha256(token);
  const row = db
    .prepare(
      `SELECT u.id, u.display_name AS displayName, u.is_admin AS isAdmin, s.expires_at AS expiresAt
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ? AND s.expires_at > ?`,
    )
    .get(hash, now()) as { id: number; displayName: string; isAdmin: number; expiresAt: number } | undefined;
  if (!row) return null;
  const renewed = row.expiresAt - now() < SESSION_TTL_MS - RENEW_AFTER_MS;
  if (renewed) db.prepare('UPDATE sessions SET expires_at = ? WHERE token_hash = ?').run(now() + SESSION_TTL_MS, hash);
  return { user: { id: row.id, displayName: row.displayName, isAdmin: row.isAdmin === 1 }, renewed };
}

export function deleteSession(db: Db, token: string): void {
  db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
}

export function pruneSessions(db: Db): void {
  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now());
}

/**
 * Issues a new personal access key for a user, invalidating the previous one.
 * Only the hash is stored, so the key can be shown exactly once.
 */
export function issueAccessKey(db: Db, userId: number): string {
  const key = randomToken();
  db.prepare('UPDATE users SET access_key_hash = ? WHERE id = ?').run(sha256(key), userId);
  return key;
}

export function userForAccessKey(db: Db, key: string): number | null {
  const row = db.prepare('SELECT id FROM users WHERE access_key_hash = ?').get(sha256(key)) as { id: number } | undefined;
  return row?.id ?? null;
}

/**
 * Fixed-window limiter on *failed* guesses (bad code / bad access key) per
 * client. Successful entries never count, so a whole friend group joining at
 * once isn't throttled. In-memory is fine for one process.
 */
export class FailureLimiter {
  private hits = new Map<string, { count: number; resetAt: number }>();
  private readonly limit: number;
  private readonly windowMs: number;

  constructor(limit: number, windowMs: number) {
    this.limit = limit;
    this.windowMs = windowMs;
  }

  blocked(key: string): boolean {
    const entry = this.hits.get(key);
    return entry !== undefined && entry.resetAt > now() && entry.count >= this.limit;
  }

  fail(key: string): void {
    const t = now();
    const entry = this.hits.get(key);
    if (!entry || entry.resetAt <= t) {
      if (this.hits.size > 10_000) this.hits.clear(); // crude bound on memory
      this.hits.set(key, { count: 1, resetAt: t + this.windowMs });
    } else {
      entry.count++;
    }
  }
}

export function newInviteCode(): string {
  return randomBytes(9).toString('base64url');
}
