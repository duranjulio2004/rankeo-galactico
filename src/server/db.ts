import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type Db = DatabaseSync;

// Append-only list of migrations; the index + 1 is the schema version.
export const MIGRATIONS: string[] = [
  `
  CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    display_name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX sessions_user ON sessions(user_id);

  CREATE TABLE groups (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    emoji TEXT NOT NULL DEFAULT '🪐',
    invite_code TEXT NOT NULL UNIQUE,
    created_by INTEGER NOT NULL REFERENCES users(id),
    created_at INTEGER NOT NULL
  );
  CREATE TABLE group_members (
    group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    joined_at INTEGER NOT NULL,
    PRIMARY KEY (group_id, user_id)
  );
  CREATE INDEX group_members_user ON group_members(user_id);

  CREATE TABLE lists (
    id INTEGER PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    emoji TEXT NOT NULL DEFAULT '⭐',
    group_id INTEGER REFERENCES groups(id) ON DELETE CASCADE,
    owner_id INTEGER NOT NULL REFERENCES users(id),
    created_at INTEGER NOT NULL
  );
  CREATE INDEX lists_group ON lists(group_id);
  CREATE INDEX lists_owner ON lists(owner_id);

  CREATE TABLE items (
    id INTEGER PRIMARY KEY,
    list_id INTEGER NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    emoji TEXT NOT NULL DEFAULT '',
    image_url TEXT NOT NULL DEFAULT '',
    created_by INTEGER NOT NULL REFERENCES users(id),
    archived INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX items_list ON items(list_id);

  CREATE TABLE votes (
    id INTEGER PRIMARY KEY,
    list_id INTEGER NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    item_a INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    item_b INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    result REAL NOT NULL CHECK (result IN (0, 0.5, 1)),
    created_at INTEGER NOT NULL,
    CHECK (item_a <> item_b)
  );
  CREATE INDEX votes_list_user ON votes(list_id, user_id, id);

  CREATE TABLE exclusions (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    PRIMARY KEY (user_id, item_id)
  );
  `,
  // v2: no accounts. People enter with a code + name; no username/password.
  // Rebuilds users keeping ids (so votes/groups stay attached); clashing
  // display names get the id appended so the new UNIQUE constraint holds.
  `
  CREATE TABLE users_new (
    id INTEGER PRIMARY KEY,
    display_name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    is_admin INTEGER NOT NULL DEFAULT 0,
    access_key_hash TEXT UNIQUE,
    created_at INTEGER NOT NULL
  );
  INSERT INTO users_new (id, display_name, created_at)
    SELECT id,
           CASE WHEN EXISTS (SELECT 1 FROM users o WHERE o.display_name = u.display_name COLLATE NOCASE AND o.id < u.id)
                THEN u.display_name || ' ' || u.id ELSE u.display_name END,
           created_at
    FROM users u;
  DROP TABLE users;
  ALTER TABLE users_new RENAME TO users;
  `,
];

export function openDb(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
  migrate(db);
  return db;
}

function migrate(db: Db): void {
  const { user_version: version } = db.prepare('PRAGMA user_version').get() as { user_version: number };
  if (version >= MIGRATIONS.length) return;
  // Table rebuilds (v2) must not cascade-delete rows that reference the old
  // table, so foreign keys are off during migrations (it can't be changed
  // inside a transaction) and checked afterwards.
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    for (let v = version; v < MIGRATIONS.length; v++) {
      transaction(db, () => {
        db.exec(MIGRATIONS[v]!);
        db.exec(`PRAGMA user_version = ${v + 1}`);
      });
    }
    const broken = db.prepare('PRAGMA foreign_key_check').all();
    if (broken.length > 0) throw new Error(`Migration left ${broken.length} broken foreign keys`);
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

export function transaction<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export const now = () => Date.now();
