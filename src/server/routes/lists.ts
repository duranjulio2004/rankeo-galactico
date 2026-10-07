import { Hono } from 'hono';
import { now, transaction, type Db } from '../db.ts';
import { readJson, requireUser, str, intParam, optionalUrl, badRequest, forbidden, type AppEnv } from '../http.ts';
import { requireList, requireListOwner, requireMember, requireItem, isMember, type ItemRow } from '../access.ts';
import { nextDuel, personalFits, rankingView, groupRanking, groupInsights, listParticipants, type DuelState, type ListRow } from '../rankings.ts';
import { rankingConfidence } from '../ranking/bradleyTerry.ts';

const MAX_ITEMS = 500;

const itemJson = (r: ItemRow) => ({ id: r.id, name: r.name, emoji: r.emoji, imageUrl: r.image_url, archived: r.archived === 1, createdBy: r.created_by });

/** Lists visible to the user (own private + their groups'), optionally scoped to one group. */
export function listSummaries(db: Db, userId: number, groupId?: number) {
  const rows = (
    groupId === undefined
      ? db
          .prepare(
            `SELECT l.*, g.name AS group_name, g.emoji AS group_emoji FROM lists l LEFT JOIN groups g ON g.id = l.group_id
             WHERE (l.group_id IS NULL AND l.owner_id = ?)
                OR l.group_id IN (SELECT group_id FROM group_members WHERE user_id = ?)
             ORDER BY l.created_at DESC`,
          )
          .all(userId, userId)
      : db.prepare(`SELECT l.*, g.name AS group_name, g.emoji AS group_emoji FROM lists l JOIN groups g ON g.id = l.group_id WHERE l.group_id = ? ORDER BY l.created_at DESC`).all(groupId)
  ) as unknown as (ListRow & { group_name: string | null; group_emoji: string | null })[];

  const counts = db.prepare(
    `SELECT (SELECT COUNT(*) FROM items WHERE list_id = ?1 AND archived = 0) AS items,
            (SELECT COUNT(*) FROM votes WHERE list_id = ?1 AND user_id = ?2) AS myVotes,
            (SELECT COUNT(DISTINCT user_id) FROM votes WHERE list_id = ?1) AS voters`,
  );
  return rows.map((l) => {
    const c = counts.get(l.id, userId) as { items: number; myVotes: number; voters: number };
    return {
      id: l.id,
      title: l.title,
      emoji: l.emoji,
      description: l.description,
      group: l.group_id === null ? null : { id: l.group_id, name: l.group_name, emoji: l.group_emoji },
      itemCount: c.items,
      myVotes: c.myVotes,
      voters: c.voters,
      myConfidence: c.myVotes > 0 ? Math.round(rankingConfidence(personalFits(db, l.id, userId)) * 100) / 100 : 0,
    };
  });
}

interface NewItem {
  name: string;
  emoji: string;
  imageUrl: string;
}

function parseItems(value: unknown): NewItem[] {
  if (!Array.isArray(value)) throw badRequest('items debe ser una lista');
  if (value.length > MAX_ITEMS) throw badRequest(`Máximo ${MAX_ITEMS} ítems`);
  return value.map((v, i) => {
    const o = (typeof v === 'string' ? { name: v } : v) as Record<string, unknown>;
    if (typeof o !== 'object' || o === null) throw badRequest(`Ítem ${i + 1} inválido`);
    return {
      name: str(o.name, `Nombre del ítem ${i + 1}`, { min: 1, max: 80 }),
      emoji: str(o.emoji, 'Emoji', { max: 16, optional: true }),
      imageUrl: optionalUrl(o.imageUrl, 'Imagen'),
    };
  });
}

/** Inserts items, skipping names already in the list (case-insensitive). Returns counts. */
function insertItems(db: Db, listId: number, userId: number, items: NewItem[]) {
  const existing = new Set(
    (db.prepare('SELECT name FROM items WHERE list_id = ?').all(listId) as { name: string }[]).map((r) => r.name.toLowerCase()),
  );
  const total = (db.prepare('SELECT COUNT(*) AS n FROM items WHERE list_id = ?').get(listId) as { n: number }).n;
  const insert = db.prepare('INSERT INTO items (list_id, name, emoji, image_url, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)');
  let added = 0;
  let skipped = 0;
  for (const item of items) {
    const key = item.name.toLowerCase();
    if (existing.has(key)) {
      skipped++;
      continue;
    }
    if (total + added >= MAX_ITEMS) throw badRequest(`Una lista puede tener máximo ${MAX_ITEMS} ítems`);
    insert.run(listId, item.name, item.emoji, item.imageUrl, userId, now());
    existing.add(key);
    added++;
  }
  return { added, skipped };
}

function duelJson(db: Db, state: DuelState) {
  const get = db.prepare('SELECT * FROM items WHERE id = ?');
  const pair = state.pair
    ? { left: itemJson(get.get(state.pair.left) as unknown as ItemRow), right: itemJson(get.get(state.pair.right) as unknown as ItemRow) }
    : null;
  return { pair, votes: state.votes, confidence: Math.round(state.confidence * 1000) / 1000, eligibleItems: state.eligibleItems };
}

export function listRoutes() {
  const app = new Hono<AppEnv>();

  app.get('/', (c) => {
    const user = requireUser(c);
    return c.json({ lists: listSummaries(c.get('db'), user.id) });
  });

  app.post('/', async (c) => {
    const user = requireUser(c);
    const db = c.get('db');
    const body = await readJson(c);
    const title = str(body.title, 'Título', { min: 1, max: 80 });
    const description = str(body.description, 'Descripción', { max: 500, optional: true });
    const emoji = str(body.emoji, 'Emoji', { max: 16, optional: true }) || '⭐';
    let groupId: number | null = null;
    if (body.groupId !== undefined && body.groupId !== null) {
      groupId = intParam(String(body.groupId), 'groupId');
      requireMember(db, groupId, user.id);
    }
    const items = body.items === undefined ? [] : parseItems(body.items);
    const result = transaction(db, () => {
      const r = db.prepare('INSERT INTO lists (title, description, emoji, group_id, owner_id, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(title, description, emoji, groupId, user.id, now());
      const id = Number(r.lastInsertRowid);
      return { id, ...insertItems(db, id, user.id, items) };
    });
    return c.json({ list: { id: result.id }, added: result.added, skipped: result.skipped }, 201);
  });

  app.get('/:id', (c) => {
    const user = requireUser(c);
    const db = c.get('db');
    const list = requireList(db, intParam(c.req.param('id')), user.id);
    const items = (db.prepare('SELECT * FROM items WHERE list_id = ? ORDER BY archived, name COLLATE NOCASE').all(list.id) as unknown as ItemRow[]).map(itemJson);
    const excluded = (
      db.prepare('SELECT e.item_id FROM exclusions e JOIN items i ON i.id = e.item_id WHERE i.list_id = ? AND e.user_id = ?').all(list.id, user.id) as { item_id: number }[]
    ).map((r) => r.item_id);
    const group = list.group_id === null ? null : db.prepare('SELECT id, name, emoji FROM groups WHERE id = ?').get(list.group_id);
    const participants = listParticipants(db, list);
    const members = db
      .prepare(`SELECT id, username, display_name AS displayName FROM users WHERE id IN (${participants.map(() => '?').join(',')})`)
      .all(...participants);
    return c.json({
      list: { id: list.id, title: list.title, description: list.description, emoji: list.emoji, ownerId: list.owner_id, createdAt: list.created_at },
      group,
      members,
      items,
      excluded,
      canEdit: list.owner_id === user.id,
    });
  });

  app.patch('/:id', async (c) => {
    const user = requireUser(c);
    const db = c.get('db');
    const list = requireList(db, intParam(c.req.param('id')), user.id);
    requireListOwner(list, user.id);
    const body = await readJson(c);
    const title = str(body.title, 'Título', { min: 1, max: 80 });
    const description = str(body.description, 'Descripción', { max: 500, optional: true });
    const emoji = str(body.emoji, 'Emoji', { max: 16, optional: true }) || '⭐';
    db.prepare('UPDATE lists SET title = ?, description = ?, emoji = ? WHERE id = ?').run(title, description, emoji, list.id);
    return c.json({ ok: true });
  });

  app.delete('/:id', (c) => {
    const user = requireUser(c);
    const db = c.get('db');
    const list = requireList(db, intParam(c.req.param('id')), user.id);
    requireListOwner(list, user.id);
    db.prepare('DELETE FROM lists WHERE id = ?').run(list.id);
    return c.json({ ok: true });
  });

  app.post('/:id/items', async (c) => {
    const user = requireUser(c);
    const db = c.get('db');
    const list = requireList(db, intParam(c.req.param('id')), user.id);
    // Group lists are collaborative; private lists only have their owner anyway.
    const body = await readJson(c);
    const result = transaction(db, () => insertItems(db, list.id, user.id, parseItems(body.items)));
    return c.json(result, 201);
  });

  app.get('/:id/duel', (c) => {
    const user = requireUser(c);
    const db = c.get('db');
    const list = requireList(db, intParam(c.req.param('id')), user.id);
    const avoid = (c.req.query('avoid') ?? '')
      .split(',')
      .map(Number)
      .filter((n) => Number.isSafeInteger(n) && n > 0)
      .slice(0, 4);
    return c.json(duelJson(db, nextDuel(db, list.id, user.id, avoid)));
  });

  app.post('/:id/votes', async (c) => {
    const user = requireUser(c);
    const db = c.get('db');
    const list = requireList(db, intParam(c.req.param('id')), user.id);
    const body = await readJson(c);
    const left = intParam(String(body.left), 'left');
    const right = intParam(String(body.right), 'right');
    const result = body.result === 'left' ? 1 : body.result === 'right' ? 0 : body.result === 'tie' ? 0.5 : null;
    if (result === null) throw badRequest('result debe ser left, right o tie');
    if (left === right) throw badRequest('Un ítem no puede competir consigo mismo');
    const rows = db
      .prepare(
        `SELECT i.id, i.archived, EXISTS(SELECT 1 FROM exclusions e WHERE e.item_id = i.id AND e.user_id = ?) AS excluded
         FROM items i WHERE i.list_id = ? AND i.id IN (?, ?)`,
      )
      .all(user.id, list.id, left, right) as { id: number; archived: number; excluded: number }[];
    if (rows.length !== 2) throw badRequest('Esos ítems no son de esta lista');
    if (rows.some((r) => r.archived)) throw badRequest('Uno de los ítems fue archivado');
    if (rows.some((r) => r.excluded)) throw badRequest('Marcaste uno de los ítems como "no lo conozco"');
    db.prepare('INSERT INTO votes (list_id, user_id, item_a, item_b, result, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(list.id, user.id, left, right, result, now());
    return c.json(duelJson(db, nextDuel(db, list.id, user.id)), 201);
  });

  app.post('/:id/votes/undo', (c) => {
    const user = requireUser(c);
    const db = c.get('db');
    const list = requireList(db, intParam(c.req.param('id')), user.id);
    const last = db.prepare('SELECT id, item_a, item_b FROM votes WHERE list_id = ? AND user_id = ? ORDER BY id DESC LIMIT 1').get(list.id, user.id) as
      | { id: number; item_a: number; item_b: number }
      | undefined;
    if (!last) throw badRequest('No hay votos para deshacer');
    db.prepare('DELETE FROM votes WHERE id = ?').run(last.id);
    // Hand the same duel back so the user can re-decide it.
    const state = nextDuel(db, list.id, user.id);
    const items = db.prepare('SELECT id, archived FROM items WHERE id IN (?, ?)').all(last.item_a, last.item_b) as { id: number; archived: number }[];
    const stillValid = items.length === 2 && items.every((i) => !i.archived);
    return c.json(duelJson(db, stillValid ? { ...state, pair: { left: last.item_a, right: last.item_b } } : state));
  });

  app.get('/:id/ranking', (c) => {
    const user = requireUser(c);
    const db = c.get('db');
    const list = requireList(db, intParam(c.req.param('id')), user.id);
    // Group members can look at each other's personal rankings of a group list.
    const target = c.req.query('user') ? intParam(c.req.query('user'), 'user') : user.id;
    if (target !== user.id && (list.group_id === null || !isMember(db, list.group_id, target))) throw forbidden('No puedes ver ese ranking');
    const votes = (db.prepare('SELECT COUNT(*) AS n FROM votes WHERE list_id = ? AND user_id = ?').get(list.id, target) as { n: number }).n;
    return c.json({ userId: target, votes, ...rankingView(personalFits(db, list.id, target)) });
  });

  app.get('/:id/group', (c) => {
    const user = requireUser(c);
    const db = c.get('db');
    const list = requireList(db, intParam(c.req.param('id')), user.id);
    if (list.group_id === null) throw badRequest('Esta lista es personal');
    const { view, contributors } = groupRanking(db, list);
    return c.json({ ...view, contributors });
  });

  app.get('/:id/insights', (c) => {
    const user = requireUser(c);
    const db = c.get('db');
    const list = requireList(db, intParam(c.req.param('id')), user.id);
    if (list.group_id === null) throw badRequest('Esta lista es personal');
    return c.json(groupInsights(db, list, user.id));
  });

  return app;
}

export function itemRoutes() {
  const app = new Hono<AppEnv>();

  app.patch('/:id', async (c) => {
    const user = requireUser(c);
    const db = c.get('db');
    const { item, list } = requireItem(db, intParam(c.req.param('id')), user.id);
    if (item.created_by !== user.id && list.owner_id !== user.id) throw forbidden('Solo quien agregó el ítem o el dueño de la lista puede editarlo');
    const body = await readJson(c);
    const name = body.name === undefined ? item.name : str(body.name, 'Nombre', { min: 1, max: 80 });
    const emoji = body.emoji === undefined ? item.emoji : str(body.emoji, 'Emoji', { max: 16, optional: true });
    const imageUrl = body.imageUrl === undefined ? item.image_url : optionalUrl(body.imageUrl, 'Imagen');
    const archived = body.archived === undefined ? item.archived : body.archived ? 1 : 0;
    if (name.toLowerCase() !== item.name.toLowerCase()) {
      const clash = db.prepare('SELECT 1 FROM items WHERE list_id = ? AND name = ? COLLATE NOCASE AND id <> ?').get(list.id, name, item.id);
      if (clash) throw badRequest('Ya hay un ítem con ese nombre');
    }
    db.prepare('UPDATE items SET name = ?, emoji = ?, image_url = ?, archived = ? WHERE id = ?').run(name, emoji, imageUrl, archived, item.id);
    return c.json({ item: itemJson({ ...item, name, emoji, image_url: imageUrl, archived }) });
  });

  app.put('/:id/exclusion', async (c) => {
    const user = requireUser(c);
    const db = c.get('db');
    const { item } = requireItem(db, intParam(c.req.param('id')), user.id);
    const body = await readJson(c);
    if (body.excluded) db.prepare('INSERT OR IGNORE INTO exclusions (user_id, item_id) VALUES (?, ?)').run(user.id, item.id);
    else db.prepare('DELETE FROM exclusions WHERE user_id = ? AND item_id = ?').run(user.id, item.id);
    return c.json({ excluded: Boolean(body.excluded) });
  });

  return app;
}
