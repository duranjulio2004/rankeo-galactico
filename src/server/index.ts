import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createApp } from './app.ts';
import { openDb } from './db.ts';
import { pruneSessions } from './auth.ts';

const production = process.env.NODE_ENV === 'production';
const port = Number(process.env.PORT ?? 3000);
const dbPath = process.env.DATABASE_PATH ?? './data/rankeo.db';
const clientDir = join(import.meta.dirname, '../../dist/client');

const db = openDb(dbPath);
pruneSessions(db);
setInterval(() => pruneSessions(db), 6 * 60 * 60 * 1000).unref();

const app = createApp({
  db,
  // Behind Railway's TLS proxy in production; plain http locally.
  secureCookies: production,
  signupCode: process.env.SIGNUP_CODE || undefined,
});

if (existsSync(clientDir)) {
  app.use('/assets/*', async (c, next) => {
    await next();
    c.header('Cache-Control', 'public, max-age=31536000, immutable'); // hashed filenames
  });
  app.use('/*', serveStatic({ root: clientDir }));
  const indexHtml = readFileSync(join(clientDir, 'index.html'), 'utf8');
  // SPA fallback: any non-API path renders the app, which routes client-side.
  app.get('*', (c) => c.html(indexHtml));
} else if (production) {
  console.warn(`No client build at ${clientDir}; run "npm run build".`);
}

const server = serve({ fetch: app.fetch, port }, (info) => {
  console.log(`Rankeo Galáctico listening on http://localhost:${info.port} (db: ${dbPath})`);
});

const shutdown = () => {
  server.close();
  db.close();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
