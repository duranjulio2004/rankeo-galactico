import { scrypt, randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { now, type Db } from './db.ts';

const scryptAsync = promisify(scrypt) as (pw: string, salt: Buffer, keylen: number, opts: object) => Promise<Buffer>;
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const KEYLEN = 32;
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, KEYLEN, SCRYPT);
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, saltB64, keyB64] = stored.split('$');
  if (scheme !== 'scrypt' || !saltB64 || !keyB64) return false;
  const expected = Buffer.from(keyB64, 'base64');
  const key = await scryptAsync(password, Buffer.from(saltB64, 'base64'), expected.length, SCRYPT);
  return timingSafeEqual(key, expected);
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export function createSession(db: Db, userId: number): string {
  const token = randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(sha256(token), userId, now() + SESSION_TTL_MS);
  return token;
}

export interface SessionUser {
  id: number;
  username: string;
  displayName: string;
}

export function userForSession(db: Db, token: string): SessionUser | null {
  const row = db
    .prepare(
      `SELECT u.id, u.username, u.display_name AS displayName
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ? AND s.expires_at > ?`,
    )
    .get(sha256(token), now()) as SessionUser | undefined;
  return row ? { ...row } : null;
}

export function deleteSession(db: Db, token: string): void {
  db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
}

export function pruneSessions(db: Db): void {
  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now());
}

/** Fixed-window limiter for login attempts; in-memory is fine for one process. */
export class RateLimiter {
  private hits = new Map<string, { count: number; resetAt: number }>();
  private readonly limit: number;
  private readonly windowMs: number;

  constructor(limit: number, windowMs: number) {
    this.limit = limit;
    this.windowMs = windowMs;
  }

  /** Returns true if this attempt is allowed. */
  attempt(key: string): boolean {
    const t = now();
    const entry = this.hits.get(key);
    if (!entry || entry.resetAt <= t) {
      if (this.hits.size > 10_000) this.hits.clear(); // crude bound on memory
      this.hits.set(key, { count: 1, resetAt: t + this.windowMs });
      return true;
    }
    entry.count++;
    return entry.count <= this.limit;
  }

  reset(key: string): void {
    this.hits.delete(key);
  }
}

export function newInviteCode(): string {
  return randomBytes(9).toString('base64url');
}
