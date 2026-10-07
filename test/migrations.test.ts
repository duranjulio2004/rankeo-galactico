import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MIGRATIONS, openDb } from '../src/server/db.ts';

test('v1 → v2 drops accounts but keeps every user, vote, membership and session', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rg-mig-'));
  try {
    const path = join(dir, 'old.db');
    const old = new DatabaseSync(path);
    old.exec('PRAGMA foreign_keys = ON');
    old.exec(MIGRATIONS[0]!);
    old.exec('PRAGMA user_version = 1');
    old.exec(`
      INSERT INTO users (id, username, display_name, password_hash, created_at) VALUES
        (1, 'julio', 'Julio', 'scrypt$x$y', 1), (2, 'ana', 'Ana', 'scrypt$x$y', 2), (3, 'ana2', 'ana', 'scrypt$x$y', 3);
      INSERT INTO sessions VALUES ('tokhash', 1, 9999999999999);
      INSERT INTO groups (id, name, invite_code, created_by, created_at) VALUES (1, 'G', 'code', 1, 1);
      INSERT INTO group_members VALUES (1, 1, 1), (1, 2, 1), (1, 3, 1);
      INSERT INTO lists (id, title, group_id, owner_id, created_at) VALUES (1, 'L', 1, 1, 1);
      INSERT INTO items (id, list_id, name, created_by, created_at) VALUES (1, 1, 'A', 1, 1), (2, 1, 'B', 2, 1);
      INSERT INTO votes (list_id, user_id, item_a, item_b, result, created_at) VALUES (1, 1, 1, 2, 1, 1), (1, 3, 1, 2, 0, 1);
    `);
    old.close();

    const db = openDb(path);
    const users = db.prepare('SELECT id, display_name AS name, is_admin AS admin FROM users ORDER BY id').all();
    assert.deepEqual(users.map((u) => ({ ...u })), [
      { id: 1, name: 'Julio', admin: 0 },
      { id: 2, name: 'Ana', admin: 0 },
      { id: 3, name: 'ana 3', admin: 0 }, // case-insensitive clash with "Ana" gets its id appended
    ]);
    const cols = (db.prepare('PRAGMA table_info(users)').all() as { name: string }[]).map((c) => c.name);
    assert.ok(!cols.includes('password_hash') && !cols.includes('username'));
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM votes').get() as { n: number }).n, 2);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM group_members').get() as { n: number }).n, 3);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }).n, 1, 'still logged in after upgrade');
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    // Foreign keys are enforced again afterwards, and still point at the new users table.
    assert.throws(() => db.prepare("INSERT INTO votes (list_id, user_id, item_a, item_b, result, created_at) VALUES (1, 99, 1, 2, 1, 1)").run());
    db.prepare('DELETE FROM users WHERE id = 3').run();
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM votes').get() as { n: number }).n, 1, 'cascade still works');
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
