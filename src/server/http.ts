import type { Context } from 'hono';
import type { Db } from './db.ts';
import type { SessionUser } from './auth.ts';

export type AppEnv = {
  Variables: {
    db: Db;
    user: SessionUser | null;
  };
};

export class HttpError extends Error {
  readonly status: 400 | 401 | 403 | 404 | 409 | 415 | 429;
  constructor(status: HttpError['status'], message: string) {
    super(message);
    this.status = status;
  }
}

export const badRequest = (msg: string) => new HttpError(400, msg);
export const notFound = (msg = 'No encontrado') => new HttpError(404, msg);
export const forbidden = (msg = 'No tienes acceso') => new HttpError(403, msg);

export function requireUser(c: Context<AppEnv>): SessionUser {
  const user = c.get('user');
  if (!user) throw new HttpError(401, 'Inicia sesión primero');
  return user;
}

export async function readJson(c: Context<AppEnv>): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw badRequest('JSON inválido');
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw badRequest('Se esperaba un objeto JSON');
  return body as Record<string, unknown>;
}

export function str(value: unknown, field: string, opts: { min?: number; max: number; optional?: boolean }): string {
  if (value === undefined || value === null) {
    if (opts.optional) return '';
    throw badRequest(`Falta ${field}`);
  }
  if (typeof value !== 'string') throw badRequest(`${field} debe ser texto`);
  const s = value.trim();
  if (s.length < (opts.min ?? 0)) throw badRequest(`${field} es muy corto`);
  if (s.length > opts.max) throw badRequest(`${field} es muy largo (máx. ${opts.max})`);
  return s;
}

export function intParam(value: string | undefined, field = 'id'): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) throw badRequest(`${field} inválido`);
  return n;
}

export function optionalUrl(value: unknown, field: string): string {
  const s = str(value, field, { max: 500, optional: true });
  if (!s) return '';
  let url: URL;
  try {
    url = new URL(s);
  } catch {
    throw badRequest(`${field} no es una URL válida`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw badRequest(`${field} debe ser http(s)`);
  return url.toString();
}
