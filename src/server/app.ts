import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import { userForSession } from './auth.ts';
import type { Db } from './db.ts';
import { HttpError, type AppEnv } from './http.ts';
import { authRoutes, setSessionCookie, SESSION_COOKIE } from './routes/auth.ts';
import { adminRoutes } from './routes/admin.ts';
import { groupRoutes, inviteRoutes } from './routes/groups.ts';
import { listRoutes, itemRoutes } from './routes/lists.ts';

export interface AppOptions {
  db: Db;
  secureCookies?: boolean;
  adminCode?: string;
  trustProxy?: boolean;
}

export function createApp(opts: AppOptions) {
  const app = new Hono<AppEnv>();

  app.use('/api/*', async (c, next) => {
    // CSRF defence (DESIGN.md §4.2): mutating requests must be JSON, which a
    // cross-site form can't send without a CORS preflight we never allow.
    if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) {
      const type = c.req.header('content-type') ?? '';
      if (!type.startsWith('application/json')) throw new HttpError(415, 'Content-Type debe ser application/json');
    }
    c.set('db', opts.db);
    const token = getCookie(c, SESSION_COOKIE);
    const session = token ? userForSession(opts.db, token) : null;
    c.set('user', session?.user ?? null);
    // Sliding expiry: people who keep using the app never get logged out.
    if (token && session?.renewed) setSessionCookie(c, token, opts.secureCookies ?? false);
    await next();
    c.header('Cache-Control', 'no-store');
  });

  app.route('/api/auth', authRoutes({ secureCookies: opts.secureCookies ?? false, adminCode: opts.adminCode, trustProxy: opts.trustProxy }));
  app.route('/api/admin', adminRoutes());
  app.route('/api/groups', groupRoutes());
  app.route('/api/invites', inviteRoutes());
  app.route('/api/lists', listRoutes());
  app.route('/api/items', itemRoutes());
  app.get('/api/health', (c) => c.json({ ok: true }));
  app.all('/api/*', (c) => c.json({ error: 'Ruta no encontrada' }, 404));

  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ error: err.message }, err.status);
    console.error(err);
    return c.json({ error: 'Error interno' }, 500);
  });

  return app;
}
