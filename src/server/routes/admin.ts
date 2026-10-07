// The single admin (logged in with ADMIN_CODE) can recover people who lost
// their device, fix names, and remove users. Everything else is the same as
// for any member.
import { Hono, type Context } from 'hono';
import { issueAccessKey } from '../auth.ts';
import { transaction } from '../db.ts';
import { HttpError, intParam, readJson, requireUser, type AppEnv } from '../http.ts';
import { nameTaken, parseName } from './auth.ts';

function requireAdmin(c: Context<AppEnv>) {
  const user = requireUser(c);
  if (!user.isAdmin) throw new HttpError(403, 'Solo el admin puede hacer esto');
  return user;
}

function requireUserRow(c: Context<AppEnv>) {
  const id = intParam(c.req.param('id'));
  if (!c.get('db').prepare('SELECT 1 FROM users WHERE id = ?').get(id)) throw new HttpError(404, 'Usuario no encontrado');
  return id;
}

export function adminRoutes() {
  const app = new Hono<AppEnv>();

  app.get('/users', (c) => {
    requireAdmin(c);
    const users = c
      .get('db')
      .prepare(
        `SELECT u.id, u.display_name AS displayName, u.is_admin AS isAdmin, u.created_at AS createdAt,
           (SELECT COUNT(*) FROM votes v WHERE v.user_id = u.id) AS votes,
           (SELECT group_concat(g.name, ', ') FROM group_members m JOIN groups g ON g.id = m.group_id WHERE m.user_id = u.id) AS groups,
           (SELECT MAX(expires_at) FROM sessions s WHERE s.user_id = u.id) AS sessionExpiresAt
         FROM users u ORDER BY u.created_at`,
      )
      .all()
      .map((r) => ({ ...r, isAdmin: r.isAdmin === 1, groups: r.groups ?? '' }));
    return c.json({ users });
  });

  /** New access link for someone who lost their device; their old link stops working. */
  app.post('/users/:id/access-key', (c) => {
    requireAdmin(c);
    const id = requireUserRow(c);
    return c.json({ key: issueAccessKey(c.get('db'), id) });
  });

  app.patch('/users/:id', async (c) => {
    requireAdmin(c);
    const id = requireUserRow(c);
    const db = c.get('db');
    const name = parseName((await readJson(c)).name);
    if (nameTaken(db, name, id)) throw new HttpError(409, 'Ese nombre ya está tomado');
    db.prepare('UPDATE users SET display_name = ? WHERE id = ?').run(name, id);
    return c.json({ ok: true });
  });

  /**
   * Removes a user with their votes, memberships and private lists. Group
   * lists, items and groups they created are handed to the admin, so friends
   * don't lose shared lists.
   */
  app.delete('/users/:id', (c) => {
    const admin = requireAdmin(c);
    const id = requireUserRow(c);
    if (id === admin.id) throw new HttpError(400, 'No puedes borrarte a ti mismo');
    const db = c.get('db');
    transaction(db, () => {
      db.prepare('DELETE FROM lists WHERE owner_id = ? AND group_id IS NULL').run(id);
      db.prepare('UPDATE lists SET owner_id = ? WHERE owner_id = ?').run(admin.id, id);
      db.prepare('UPDATE items SET created_by = ? WHERE created_by = ?').run(admin.id, id);
      db.prepare('UPDATE groups SET created_by = ? WHERE created_by = ?').run(admin.id, id);
      db.prepare('DELETE FROM users WHERE id = ?').run(id); // cascades: votes, sessions, memberships, exclusions
    });
    return c.json({ ok: true });
  });

  return app;
}
