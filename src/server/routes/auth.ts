import { Hono, type Context } from 'hono';
import { setCookie, deleteCookie, getCookie } from 'hono/cookie';
import { getConnInfo } from '@hono/node-server/conninfo';
import { createSession, deleteSession, FailureLimiter, issueAccessKey, safeEqual, userForAccessKey, SESSION_TTL_MS, type SessionUser } from '../auth.ts';
import { now, transaction, type Db } from '../db.ts';
import { HttpError, badRequest, readJson, requireUser, str, type AppEnv } from '../http.ts';

export const SESSION_COOKIE = 'rg_session';

export interface AuthOptions {
  secureCookies: boolean;
  /** Secret code that logs into the single admin account. Unset = no admin. */
  adminCode?: string;
  /** Take the client IP from X-Forwarded-For (only behind a trusted proxy like Railway's). */
  trustProxy?: boolean;
}

export function setSessionCookie(c: Context<AppEnv>, token: string, secure: boolean) {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'Lax',
    secure,
    path: '/',
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  });
}

export function clientIp(c: Context<AppEnv>, trustProxy: boolean): string {
  if (trustProxy) {
    // The *last* entry is the one our proxy appended (the address it saw);
    // earlier entries come from the client and can be spoofed.
    const forwarded = c.req.header('x-forwarded-for')?.split(',').at(-1)?.trim();
    if (forwarded) return forwarded;
  }
  try {
    return getConnInfo(c).remote.address ?? 'unknown';
  } catch {
    return 'unknown'; // e.g. app.request() in tests
  }
}

/** Display names are people's identity, so they're unique (case-insensitive). */
export function parseName(value: unknown): string {
  const name = str(value, 'Nombre', { min: 1, max: 30 }).replace(/\s+/g, ' ');
  if (!/\p{L}|\p{N}/u.test(name)) throw badRequest('El nombre necesita al menos una letra o número');
  return name;
}

export function nameTaken(db: Db, name: string, exceptId = 0): boolean {
  return db.prepare('SELECT 1 FROM users WHERE display_name = ? COLLATE NOCASE AND id <> ?').get(name, exceptId) !== undefined;
}

const TAKEN = 'Ese nombre ya está tomado. Si eres tú, entra con tu link de acceso (o pídeselo al admin).';

function createUser(db: Db, name: string, isAdmin = false): SessionUser {
  if (nameTaken(db, name)) throw new HttpError(409, TAKEN);
  try {
    const r = db.prepare('INSERT INTO users (display_name, is_admin, created_at) VALUES (?, ?, ?)').run(name, isAdmin ? 1 : 0, now());
    return { id: Number(r.lastInsertRowid), displayName: name, isAdmin };
  } catch (err) {
    // Lost a race with someone picking the same name at the same moment.
    if (String(err).includes('UNIQUE')) throw new HttpError(409, TAKEN);
    throw err;
  }
}

function getUser(db: Db, id: number): SessionUser {
  const row = db.prepare('SELECT id, display_name AS displayName, is_admin AS isAdmin FROM users WHERE id = ?').get(id) as
    | { id: number; displayName: string; isAdmin: number }
    | undefined;
  if (!row) throw new HttpError(404, 'Usuario no encontrado');
  return { id: row.id, displayName: row.displayName, isAdmin: row.isAdmin === 1 };
}

export function authRoutes(opts: AuthOptions) {
  const app = new Hono<AppEnv>();
  // Group codes are 72 random bits, so guessing is hopeless anyway; the limit
  // mainly protects ADMIN_CODE, which a human picked.
  const guesses = new FailureLimiter(10, 15 * 60 * 1000);

  const login = (c: Context<AppEnv>, userId: number) => setSessionCookie(c, createSession(c.get('db'), userId), opts.secureCookies);

  /**
   * Enter with a code. A group's invite code joins that group (creating you
   * with `name` if you're new here); the admin code logs into the admin account.
   */
  app.post('/enter', async (c) => {
    const db = c.get('db');
    const ip = clientIp(c, opts.trustProxy ?? false);
    if (guesses.blocked(ip)) throw new HttpError(429, 'Demasiados intentos, espera unos minutos');
    const body = await readJson(c);
    const code = typeof body.code === 'string' ? body.code.trim() : '';
    const current = c.get('user');

    if (opts.adminCode && code && safeEqual(code, opts.adminCode)) {
      const existing = db.prepare('SELECT id FROM users WHERE is_admin = 1').get() as { id: number } | undefined;
      let admin: SessionUser;
      if (existing) admin = getUser(db, existing.id);
      else if (current) {
        // First claim while already signed in: you become the admin (keeps your votes).
        db.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(current.id);
        admin = { ...current, isAdmin: true };
      } else admin = createUser(db, parseName(body.name), true);
      login(c, admin.id);
      return c.json({ user: admin, groupId: null });
    }

    const group = code ? (db.prepare('SELECT id FROM groups WHERE invite_code = ?').get(code) as { id: number } | undefined) : undefined;
    if (!group) {
      guesses.fail(ip);
      throw new HttpError(404, 'Código inválido. Revisa que esté bien escrito o pide uno nuevo.');
    }

    const user = transaction(db, () => {
      // Already here on this device: just join the group, keep your identity.
      const u = current ?? createUser(db, parseName(body.name));
      db.prepare('INSERT OR IGNORE INTO group_members (group_id, user_id, joined_at) VALUES (?, ?, ?)').run(group.id, u.id, now());
      return u;
    });
    if (!current) login(c, user.id);
    return c.json({ user, groupId: group.id }, current ? 200 : 201);
  });

  /** Log in on this device with a personal access key (from an access link). */
  app.post('/access', async (c) => {
    const db = c.get('db');
    const ip = clientIp(c, opts.trustProxy ?? false);
    if (guesses.blocked(ip)) throw new HttpError(429, 'Demasiados intentos, espera unos minutos');
    const body = await readJson(c);
    const userId = typeof body.key === 'string' && body.key ? userForAccessKey(db, body.key) : null;
    if (userId === null) {
      guesses.fail(ip);
      throw new HttpError(404, 'Este link de acceso no es válido (puede que se haya generado uno más nuevo).');
    }
    login(c, userId);
    return c.json({ user: getUser(db, userId) });
  });

  /** New personal access link for yourself; the previous one stops working. */
  app.post('/access-key', (c) => {
    const user = requireUser(c);
    return c.json({ key: issueAccessKey(c.get('db'), user.id) });
  });

  app.post('/logout', (c) => {
    const token = getCookie(c, SESSION_COOKIE);
    if (token) deleteSession(c.get('db'), token);
    deleteCookie(c, SESSION_COOKIE, { path: '/' });
    return c.json({ ok: true });
  });

  app.get('/me', (c) => c.json({ user: requireUser(c) }));

  app.patch('/me', async (c) => {
    const user = requireUser(c);
    const db = c.get('db');
    const body = await readJson(c);
    const name = parseName(body.name);
    if (nameTaken(db, name, user.id)) throw new HttpError(409, 'Ese nombre ya está tomado');
    db.prepare('UPDATE users SET display_name = ? WHERE id = ?').run(name, user.id);
    return c.json({ user: { ...user, displayName: name } });
  });

  return app;
}
