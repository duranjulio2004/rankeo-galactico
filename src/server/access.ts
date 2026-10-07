// Authorization checks. Every route that touches a group or list goes through
// one of these. They return 404 rather than 403 for things the user can't see,
// so ids of private lists/groups aren't confirmed to exist.
import type { Db } from './db.ts';
import { notFound, forbidden } from './http.ts';
import type { ListRow } from './rankings.ts';

export function isMember(db: Db, groupId: number, userId: number): boolean {
  return db.prepare('SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?').get(groupId, userId) !== undefined;
}

export function requireMember(db: Db, groupId: number, userId: number): void {
  if (!isMember(db, groupId, userId)) throw notFound('Grupo no encontrado');
}

export function canViewList(db: Db, list: ListRow, userId: number): boolean {
  return list.group_id === null ? list.owner_id === userId : isMember(db, list.group_id, userId);
}

export function requireList(db: Db, listId: number, userId: number): ListRow {
  const list = db.prepare('SELECT * FROM lists WHERE id = ?').get(listId) as ListRow | undefined;
  if (!list || !canViewList(db, list, userId)) throw notFound('Lista no encontrada');
  return list;
}

export function requireListOwner(list: ListRow, userId: number): void {
  if (list.owner_id !== userId) throw forbidden('Solo quien creó la lista puede hacer esto');
}

export interface ItemRow {
  id: number;
  list_id: number;
  name: string;
  emoji: string;
  image_url: string;
  created_by: number;
  archived: number;
  created_at: number;
}

export function requireItem(db: Db, itemId: number, userId: number): { item: ItemRow; list: ListRow } {
  const item = db.prepare('SELECT * FROM items WHERE id = ?').get(itemId) as ItemRow | undefined;
  if (!item) throw notFound('Ítem no encontrado');
  const list = requireList(db, item.list_id, userId);
  return { item, list };
}
