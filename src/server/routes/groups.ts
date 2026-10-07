import { Hono } from 'hono';
import { newInviteCode } from '../auth.ts';
import { now, transaction } from '../db.ts';
import { readJson, requireUser, str, intParam, notFound, type AppEnv } from '../http.ts';
import { requireMember, isMember } from '../access.ts';
import { listSummaries } from './lists.ts';

export function groupRoutes() {
  const app = new Hono<AppEnv>();

  app.get('/', (c) => {
    const user = requireUser(c);
    const groups = c
      .get('db')
      .prepare(
        `SELECT g.id, g.name, g.emoji,
           (SELECT COUNT(*) FROM group_members m WHERE m.group_id = g.id) AS memberCount,
           (SELECT COUNT(*) FROM lists l WHERE l.group_id = g.id) AS listCount
         FROM groups g JOIN group_members gm ON gm.group_id = g.id
         WHERE gm.user_id = ? ORDER BY gm.joined_at DESC`,
      )
      .all(user.id);
    return c.json({ groups });
  });

  app.post('/', async (c) => {
    const user = requireUser(c);
    const db = c.get('db');
    const body = await readJson(c);
    const name = str(body.name, 'Nombre del grupo', { min: 1, max: 60 });
    const emoji = str(body.emoji, 'Emoji', { max: 16, optional: true }) || '🪐';
    const id = transaction(db, () => {
      const r = db.prepare('INSERT INTO groups (name, emoji, invite_code, created_by, created_at) VALUES (?, ?, ?, ?, ?)').run(name, emoji, newInviteCode(), user.id, now());
      const groupId = Number(r.lastInsertRowid);
      db.prepare('INSERT INTO group_members (group_id, user_id, joined_at) VALUES (?, ?, ?)').run(groupId, user.id, now());
      return groupId;
    });
    return c.json({ group: { id, name, emoji } }, 201);
  });

  app.get('/:id', (c) => {
    const user = requireUser(c);
    const db = c.get('db');
    const id = intParam(c.req.param('id'));
    requireMember(db, id, user.id);
    const group = db.prepare('SELECT id, name, emoji, invite_code AS inviteCode, created_by AS createdBy FROM groups WHERE id = ?').get(id);
    const members = db
      .prepare(
        `SELECT u.id, u.username, u.display_name AS displayName, m.joined_at AS joinedAt
         FROM group_members m JOIN users u ON u.id = m.user_id WHERE m.group_id = ? ORDER BY m.joined_at`,
      )
      .all(id);
    return c.json({ group, members, lists: listSummaries(db, user.id, id) });
  });

  app.patch('/:id', async (c) => {
    const user = requireUser(c);
    const db = c.get('db');
    const id = intParam(c.req.param('id'));
    requireMember(db, id, user.id);
    const body = await readJson(c);
    const name = str(body.name, 'Nombre del grupo', { min: 1, max: 60 });
    const emoji = str(body.emoji, 'Emoji', { max: 16, optional: true }) || '🪐';
    db.prepare('UPDATE groups SET name = ?, emoji = ? WHERE id = ?').run(name, emoji, id);
    return c.json({ ok: true });
  });

  app.post('/:id/invite', (c) => {
    const user = requireUser(c);
    const db = c.get('db');
    const id = intParam(c.req.param('id'));
    requireMember(db, id, user.id);
    const code = newInviteCode();
    db.prepare('UPDATE groups SET invite_code = ? WHERE id = ?').run(code, id);
    return c.json({ inviteCode: code });
  });

  app.post('/:id/leave', (c) => {
    const user = requireUser(c);
    const db = c.get('db');
    const id = intParam(c.req.param('id'));
    requireMember(db, id, user.id);
    // Votes are kept but stop counting: group rankings only use current members.
    db.prepare('DELETE FROM group_members WHERE group_id = ? AND user_id = ?').run(id, user.id);
    const left = db.prepare('SELECT COUNT(*) AS n FROM group_members WHERE group_id = ?').get(id) as { n: number };
    if (left.n === 0) db.prepare('DELETE FROM groups WHERE id = ?').run(id);
    return c.json({ ok: true });
  });

  return app;
}

export function inviteRoutes() {
  const app = new Hono<AppEnv>();

  // Preview is public so the sign-up screen can say which group you're joining.
  app.get('/:code', (c) => {
    const db = c.get('db');
    const group = db
      .prepare(
        `SELECT g.id, g.name, g.emoji, (SELECT COUNT(*) FROM group_members m WHERE m.group_id = g.id) AS memberCount
         FROM groups g WHERE g.invite_code = ?`,
      )
      .get(c.req.param('code')) as { id: number; name: string; emoji: string; memberCount: number } | undefined;
    if (!group) throw notFound('Invitación inválida o vencida');
    const user = c.get('user');
    return c.json({ group: { name: group.name, emoji: group.emoji, memberCount: group.memberCount }, alreadyMember: user ? isMember(db, group.id, user.id) : false, groupId: user && isMember(db, group.id, user.id) ? group.id : null });
  });

  app.post('/:code/join', (c) => {
    const user = requireUser(c);
    const db = c.get('db');
    const group = db.prepare('SELECT id FROM groups WHERE invite_code = ?').get(c.req.param('code')) as { id: number } | undefined;
    if (!group) throw notFound('Invitación inválida o vencida');
    db.prepare('INSERT OR IGNORE INTO group_members (group_id, user_id, joined_at) VALUES (?, ?, ?)').run(group.id, user.id, now());
    return c.json({ groupId: group.id });
  });

  return app;
}
