import { Hono, type Context } from 'hono';
import { setCookie, deleteCookie, getCookie } from 'hono/cookie';
import { getConnInfo } from '@hono/node-server/conninfo';
import { hashPassword, verifyPassword, createSession, deleteSession, RateLimiter, SESSION_TTL_MS } from '../auth.ts';
import { now } from '../db.ts';
import { HttpError, badRequest, readJson, requireUser, str, type AppEnv } from '../http.ts';

export const SESSION_COOKIE = 'rg_session';
const USERNAME_RE = /^[a-z0-9_.]{3,24}$/i;

export interface AuthOptions {
  secureCookies: boolean;
  /** If set, registering requires this code or a valid group invite code. */
  signupCode?: string;
}

export function authRoutes(opts: AuthOptions) {
  const app = new Hono<AppEnv>();
  const loginLimiter = new RateLimiter(10, 15 * 60 * 1000);

  const startSession = (c: Context<AppEnv>, userId: number) => {
    const token = createSession(c.get('db'), userId);
    setCookie(c, SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'Lax',
      secure: opts.secureCookies,
      path: '/',
      maxAge: Math.floor(SESSION_TTL_MS / 1000),
    });
  };

  const clientIp = (c: Context<AppEnv>) => {
    try {
      return getConnInfo(c).remote.address ?? 'unknown';
    } catch {
      return 'unknown'; // e.g. app.request() in tests
    }
  };

  app.post('/register', async (c) => {
    const db = c.get('db');
    const body = await readJson(c);
    const username = str(body.username, 'Usuario', { min: 3, max: 24 });
    if (!USERNAME_RE.test(username)) throw badRequest('Usuario: solo letras, números, "_" y "." (3–24)');
    const displayName = str(body.displayName, 'Nombre', { min: 1, max: 40, optional: true }) || username;
    const password = typeof body.password === 'string' ? body.password : '';
    if (password.length < 8) throw badRequest('La contraseña debe tener al menos 8 caracteres');
    if (password.length > 200) throw badRequest('Contraseña muy larga');

    if (opts.signupCode) {
      const code = typeof body.code === 'string' ? body.code.trim() : '';
      const validInvite = code !== '' && db.prepare('SELECT 1 FROM groups WHERE invite_code = ?').get(code) !== undefined;
      if (code !== opts.signupCode && !validInvite) throw new HttpError(403, 'Necesitas un link de invitación para registrarte');
    }

    const hash = await hashPassword(password);
    let id: number;
    try {
      const r = db.prepare('INSERT INTO users (username, display_name, password_hash, created_at) VALUES (?, ?, ?, ?)').run(username, displayName, hash, now());
      id = Number(r.lastInsertRowid);
    } catch (err) {
      if (String(err).includes('UNIQUE')) throw new HttpError(409, 'Ese usuario ya existe');
      throw err;
    }
    startSession(c, id);
    return c.json({ user: { id, username, displayName } }, 201);
  });

  app.post('/login', async (c) => {
    const db = c.get('db');
    const body = await readJson(c);
    const username = typeof body.username === 'string' ? body.username.trim() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    const key = `${username.toLowerCase()}|${clientIp(c)}`;
    if (!loginLimiter.attempt(key)) throw new HttpError(429, 'Demasiados intentos, espera unos minutos');
    const row = db.prepare('SELECT id, username, display_name AS displayName, password_hash AS hash FROM users WHERE username = ?').get(username) as
      | { id: number; username: string; displayName: string; hash: string }
      | undefined;
    // Verify against a dummy hash when the user doesn't exist, so timing doesn't reveal valid usernames.
    const ok = await verifyPassword(password.slice(0, 200), row?.hash ?? DUMMY_HASH);
    if (!row || !ok) throw new HttpError(401, 'Usuario o contraseña incorrectos');
    loginLimiter.reset(key);
    startSession(c, row.id);
    return c.json({ user: { id: row.id, username: row.username, displayName: row.displayName } });
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
    const body = await readJson(c);
    const displayName = str(body.displayName, 'Nombre', { min: 1, max: 40 });
    c.get('db').prepare('UPDATE users SET display_name = ? WHERE id = ?').run(displayName, user.id);
    return c.json({ user: { ...user, displayName } });
  });

  return app;
}

// scrypt hash of a random throwaway password; only used to equalize timing.
const DUMMY_HASH = 'scrypt$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
