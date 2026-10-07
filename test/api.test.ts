import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server/app.ts';
import { openDb } from '../src/server/db.ts';

type App = ReturnType<typeof createApp>;

/** A logged-in (or anonymous) client that keeps its session cookie. */
class Client {
  cookie = '';
  private readonly app: App;
  constructor(app: App) {
    this.app = app;
  }

  async req(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const res = await this.app.request(path, {
      method,
      headers: { 'content-type': 'application/json', ...(this.cookie ? { cookie: this.cookie } : {}), ...headers },
      body: body === undefined ? (method === 'GET' ? undefined : '{}') : JSON.stringify(body),
    });
    const set = res.headers.get('set-cookie');
    if (set) this.cookie = set.split(';')[0]!;
    const json = (await res.json()) as any;
    return { status: res.status, json, headers: res.headers };
  }
  get = (p: string) => this.req('GET', p);
  post = (p: string, b?: unknown) => this.req('POST', p, b);
  patch = (p: string, b?: unknown) => this.req('PATCH', p, b);
  put = (p: string, b?: unknown) => this.req('PUT', p, b);
  del = (p: string) => this.req('DELETE', p);
}

let app: App;
const ADMIN = 'test-admin-code';
const freshApp = () => createApp({ db: openDb(':memory:'), adminCode: ADMIN });

/** Each app gets an admin and a "lobby" group whose code new test users enter with. */
const lobbies = new WeakMap<App, string>();
async function lobbyCode(a: App): Promise<string> {
  let code = lobbies.get(a);
  if (!code) {
    const admin = new Client(a);
    await admin.post('/api/auth/enter', { code: ADMIN, name: 'Admin' });
    const g = (await admin.post('/api/groups', { name: 'Lobby' })).json.group;
    code = (await admin.get(`/api/groups/${g.id}`)).json.group.inviteCode as string;
    lobbies.set(a, code);
  }
  return code;
}

async function register(name: string, a: App = app) {
  const c = new Client(a);
  const r = await c.post('/api/auth/enter', { code: await lobbyCode(a), name });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  return Object.assign(c, { id: r.json.user.id as number });
}

async function adminClient(a: App = app) {
  const c = new Client(a);
  assert.equal((await c.post('/api/auth/enter', { code: ADMIN, name: 'Admin' })).status, 200);
  return c;
}

beforeEach(() => {
  app = freshApp();
});

describe('entering (no accounts)', () => {
  test('code + name creates you, joins the group and keeps you signed in', async () => {
    const c = await register('julio');
    const me = (await c.get('/api/auth/me')).json.user;
    assert.equal(me.displayName, 'julio');
    assert.equal(me.isAdmin, false);
    const groups = (await c.get('/api/groups')).json.groups as { name: string }[];
    assert.deepEqual(groups.map((g) => g.name), ['Lobby']);
  });

  test('wrong code is rejected, and repeated wrong guesses get rate limited', async () => {
    const c = new Client(app);
    let status = 0;
    for (let i = 0; i < 11; i++) status = (await c.post('/api/auth/enter', { code: 'nope', name: 'x' })).status;
    assert.equal(status, 429);
  });

  test('names are unique: you cannot become someone else by typing their name', async () => {
    await register('Ana');
    const c = new Client(app);
    const r = await c.post('/api/auth/enter', { code: await lobbyCode(app), name: '  ana ' });
    assert.equal(r.status, 409);
    assert.equal((await c.get('/api/auth/me')).status, 401);
  });

  test('name validation', async () => {
    const c = new Client(app);
    const code = await lobbyCode(app);
    assert.equal((await c.post('/api/auth/enter', { code, name: '' })).status, 400);
    assert.equal((await c.post('/api/auth/enter', { code, name: '!!!' })).status, 400);
    assert.equal((await c.post('/api/auth/enter', { code, name: 'x'.repeat(31) })).status, 400);
  });

  test('entering another group code while signed in joins it as the same person', async () => {
    const julio = await register('julio');
    const ana = await register('ana');
    const g = (await ana.post('/api/groups', { name: 'Otro' })).json.group;
    const code = (await ana.get(`/api/groups/${g.id}`)).json.group.inviteCode;
    const r = await julio.post('/api/auth/enter', { code, name: 'ignored' });
    assert.equal(r.status, 200);
    assert.equal(r.json.user.id, julio.id);
    assert.equal(r.json.groupId, g.id);
  });

  test('admin code always returns to the single admin account', async () => {
    const a1 = await adminClient();
    const id = (await a1.get('/api/auth/me')).json.user.id;
    const a2 = new Client(app);
    const r = await a2.post('/api/auth/enter', { code: ADMIN, name: 'Someone else' });
    assert.equal(r.json.user.id, id);
    assert.equal(r.json.user.isAdmin, true);
  });

  test('first admin claim while signed in promotes you; later claims just log into that admin', async () => {
    const db = openDb(':memory:');
    const a = createApp({ db, adminCode: ADMIN });
    // An upgraded install: people and a group exist, but no admin yet.
    db.exec(`INSERT INTO users (id, display_name, created_at) VALUES (1, 'Seed', 0);
             INSERT INTO groups (id, name, invite_code, created_by, created_at) VALUES (1, 'G', 'seedcode', 1, 0);`);
    const julio = new Client(a);
    const joined = (await julio.post('/api/auth/enter', { code: 'seedcode', name: 'Julio' })).json.user;
    const promoted = (await julio.post('/api/auth/enter', { code: ADMIN })).json.user;
    assert.equal(promoted.id, joined.id, 'same account, now admin');
    assert.equal(promoted.isAdmin, true);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n, 2, 'no extra account created');

    const other = new Client(a);
    await other.post('/api/auth/enter', { code: 'seedcode', name: 'Otro' });
    const r = (await other.post('/api/auth/enter', { code: ADMIN })).json.user;
    assert.equal(r.id, joined.id, 'admin already exists: logs into it, does not promote Otro');
  });

  test('without an admin code configured, nothing logs in as admin', async () => {
    const a = createApp({ db: openDb(':memory:') });
    const r = await new Client(a).post('/api/auth/enter', { code: '', name: 'x' });
    assert.equal(r.status, 404);
  });

  test('access link: logs you in on another device; issuing a new one kills the old', async () => {
    const julio = await register('julio');
    const key1 = (await julio.post('/api/auth/access-key')).json.key as string;
    const phone = new Client(app);
    const r = await phone.post('/api/auth/access', { key: key1 });
    assert.equal(r.json.user.id, julio.id);
    const key2 = (await julio.post('/api/auth/access-key')).json.key as string;
    assert.notEqual(key1, key2);
    assert.equal((await new Client(app).post('/api/auth/access', { key: key1 })).status, 404);
    assert.equal((await new Client(app).post('/api/auth/access', { key: key2 })).status, 200);
  });

  test('session cookie is HttpOnly + SameSite=Lax; tokens and access keys are stored hashed', async () => {
    const db = openDb(':memory:');
    const a = createApp({ db, adminCode: ADMIN });
    const c = new Client(a);
    const r = await c.post('/api/auth/enter', { code: ADMIN, name: 'Admin' });
    assert.match(r.headers.get('set-cookie')!, /HttpOnly/);
    assert.match(r.headers.get('set-cookie')!, /SameSite=Lax/);
    const token = c.cookie.split('=')[1]!;
    assert.notEqual((db.prepare('SELECT token_hash FROM sessions').get() as { token_hash: string }).token_hash, token);
    const key = (await c.post('/api/auth/access-key')).json.key;
    assert.notEqual((db.prepare('SELECT access_key_hash FROM users').get() as { access_key_hash: string }).access_key_hash, key);
  });

  test('logout ends the session; rename keeps names unique', async () => {
    const julio = await register('julio');
    await register('ana');
    assert.equal((await julio.patch('/api/auth/me', { name: 'ANA' })).status, 409);
    assert.equal((await julio.patch('/api/auth/me', { name: 'Julio D' })).json.user.displayName, 'Julio D');
    await julio.post('/api/auth/logout');
    assert.equal((await julio.get('/api/auth/me')).status, 401);
  });

  test('mutations without JSON content-type are rejected (CSRF)', async () => {
    const c = await register('julio');
    const r = await c.req('POST', '/api/lists', { title: 'x' }, { 'content-type': 'application/x-www-form-urlencoded' });
    assert.equal(r.status, 415);
  });
});

describe('admin', () => {
  test('only the admin can use admin routes', async () => {
    const julio = await register('julio');
    assert.equal((await julio.get('/api/admin/users')).status, 403);
    const admin = await adminClient();
    const users = (await admin.get('/api/admin/users')).json.users as { displayName: string }[];
    assert.deepEqual(users.map((u) => u.displayName).sort(), ['Admin', 'julio']);
  });

  test('admin recovers a locked-out user with a new access link and can rename them', async () => {
    const julio = await register('julio');
    const admin = await adminClient();
    const key = (await admin.post(`/api/admin/users/${julio.id}/access-key`)).json.key;
    const newPhone = new Client(app);
    assert.equal((await newPhone.post('/api/auth/access', { key })).json.user.id, julio.id);
    assert.equal((await admin.patch(`/api/admin/users/${julio.id}`, { name: 'Julito' })).status, 200);
    assert.equal((await newPhone.get('/api/auth/me')).json.user.displayName, 'Julito');
  });

  test('deleting a user drops their votes and private lists but keeps shared lists', async () => {
    const julio = await register('julio');
    const ana = await register('ana');
    const g = (await julio.post('/api/groups', { name: 'G' })).json.group;
    await ana.post('/api/auth/enter', { code: (await julio.get(`/api/groups/${g.id}`)).json.group.inviteCode });
    const shared = (await julio.post('/api/lists', { title: 'Shared', groupId: g.id, items: ['A', 'B'] })).json.list.id;
    await julio.post('/api/lists', { title: 'Private', items: ['X', 'Y'] });
    const items = (await julio.get(`/api/lists/${shared}`)).json.items as { id: number }[];
    await julio.post(`/api/lists/${shared}/votes`, { left: items[0]!.id, right: items[1]!.id, result: 'left' });

    const admin = await adminClient();
    assert.equal((await admin.del(`/api/admin/users/${julio.id}`)).status, 200);
    assert.equal((await julio.get('/api/auth/me')).status, 401, 'their session is gone');
    assert.equal((await ana.get(`/api/lists/${shared}`)).status, 200, 'shared list survives');
    assert.equal((await ana.get(`/api/lists/${shared}/group`)).json.contributors.length, 0, 'their votes are gone');
    assert.equal((await admin.del(`/api/admin/users/${(await admin.get('/api/auth/me')).json.user.id}`)).status, 400);
  });
});

describe('groups and access control', () => {
  test('invite flow and membership boundaries', async () => {
    const julio = await register('julio');
    const ana = await register('ana');
    const eve = await register('eve');
    const g = (await julio.post('/api/groups', { name: 'Los del DCC', emoji: '🚀' })).json.group;
    const code = (await julio.get(`/api/groups/${g.id}`)).json.group.inviteCode;

    assert.equal((await ana.get(`/api/groups/${g.id}`)).status, 404, 'non-member cannot see group');
    const preview = await ana.get(`/api/invites/${code}`);
    assert.equal(preview.json.group.name, 'Los del DCC');
    assert.equal((await ana.post(`/api/invites/${code}/join`)).json.groupId, g.id);
    assert.equal((await ana.get(`/api/groups/${g.id}`)).json.members.length, 2);

    // Regenerating the invite kills the old link.
    await julio.post(`/api/groups/${g.id}/invite`);
    assert.equal((await eve.post(`/api/invites/${code}/join`)).status, 404);

    const list = (await julio.post('/api/lists', { title: 'Completos', groupId: g.id, items: ['Italiano', 'Dinámico', 'Chacarero'] })).json.list;
    assert.equal((await ana.get(`/api/lists/${list.id}`)).status, 200, 'member sees group list');
    assert.equal((await eve.get(`/api/lists/${list.id}`)).status, 404, 'outsider does not');
    assert.equal((await eve.get(`/api/lists/${list.id}/duel`)).status, 404);
    assert.equal((await eve.post(`/api/lists`, { title: 'x', groupId: g.id })).status, 404, 'cannot create in foreign group');
  });

  test('private lists are visible only to their owner', async () => {
    const julio = await register('julio');
    const ana = await register('ana');
    const list = (await julio.post('/api/lists', { title: 'Mis ramos', items: ['IIC2133', 'IIC2233'] })).json.list;
    assert.equal((await ana.get(`/api/lists/${list.id}`)).status, 404);
    assert.equal((await ana.get(`/api/lists/${list.id}/ranking?user=${julio.id}`)).status, 404);
    assert.equal((await julio.get('/api/lists')).json.lists.length, 1);
    assert.equal((await ana.get('/api/lists')).json.lists.length, 0);
  });

  test('leaving a group removes access and drops your votes from the group ranking', async () => {
    const julio = await register('julio');
    const ana = await register('ana');
    const g = (await julio.post('/api/groups', { name: 'G' })).json.group;
    const code = (await julio.get(`/api/groups/${g.id}`)).json.group.inviteCode;
    await ana.post(`/api/invites/${code}/join`);
    const list = (await julio.post('/api/lists', { title: 'L', groupId: g.id, items: ['A', 'B'] })).json.list;
    const items = (await julio.get(`/api/lists/${list.id}`)).json.items as { id: number; name: string }[];
    const A = items.find((i) => i.name === 'A')!.id;
    const B = items.find((i) => i.name === 'B')!.id;
    await ana.post(`/api/lists/${list.id}/votes`, { left: A, right: B, result: 'right' });
    assert.equal((await julio.get(`/api/lists/${list.id}/group`)).json.contributors.length, 1);
    await ana.post(`/api/groups/${g.id}/leave`);
    assert.equal((await ana.get(`/api/lists/${list.id}`)).status, 404);
    assert.equal((await julio.get(`/api/lists/${list.id}/group`)).json.contributors.length, 0);
  });
});

describe('lists, items and duels', () => {
  async function setup() {
    const julio = await register('julio');
    const created = await julio.post('/api/lists', {
      title: 'Pokémon iniciales',
      items: ['Bulbasaur', 'Charmander', 'Squirtle', { name: 'Pikachu', emoji: '⚡' }, 'squirtle'],
    });
    assert.equal(created.json.added, 4);
    assert.equal(created.json.skipped, 1, 'case-insensitive duplicate skipped');
    const listId = created.json.list.id as number;
    const items = (await julio.get(`/api/lists/${listId}`)).json.items as { id: number; name: string }[];
    const id = (n: string) => items.find((i) => i.name === n)!.id;
    return { julio, listId, id };
  }

  test('duel returns two distinct items of the list; voting returns the next duel', async () => {
    const { julio, listId } = await setup();
    let duel = (await julio.get(`/api/lists/${listId}/duel`)).json;
    assert.notEqual(duel.pair.left.id, duel.pair.right.id);
    assert.equal(duel.votes, 0);
    for (let k = 0; k < 6; k++) {
      const r = await julio.post(`/api/lists/${listId}/votes`, { left: duel.pair.left.id, right: duel.pair.right.id, result: 'left' });
      assert.equal(r.status, 201);
      duel = r.json;
    }
    assert.equal(duel.votes, 6);
    assert.ok(duel.confidence > 0);
  });

  test('ranking reflects votes; undo returns the same duel and removes the vote', async () => {
    const { julio, listId, id } = await setup();
    const vote = (l: string, r: string, result = 'left') => julio.post(`/api/lists/${listId}/votes`, { left: id(l), right: id(r), result });
    await vote('Charmander', 'Bulbasaur');
    await vote('Charmander', 'Squirtle');
    await vote('Squirtle', 'Bulbasaur');
    await vote('Pikachu', 'Charmander', 'tie');
    let ranking = (await julio.get(`/api/lists/${listId}/ranking`)).json;
    assert.equal(ranking.votes, 4);
    assert.equal(ranking.ranked.at(-1).itemId, id('Bulbasaur'));
    assert.deepEqual(ranking.unranked, []);
    assert.ok(ranking.tiers.length >= 1);

    const undo = (await julio.post(`/api/lists/${listId}/votes/undo`)).json;
    assert.deepEqual([undo.pair.left.id, undo.pair.right.id], [id('Pikachu'), id('Charmander')]);
    assert.equal(undo.votes, 3);
    ranking = (await julio.get(`/api/lists/${listId}/ranking`)).json;
    assert.deepEqual(ranking.unranked, [id('Pikachu')]);
  });

  test('vote validation', async () => {
    const { julio, listId, id } = await setup();
    const other = (await julio.post('/api/lists', { title: 'Otra', items: ['X', 'Y'] })).json.list.id;
    const foreign = ((await julio.get(`/api/lists/${other}`)).json.items as { id: number }[])[0]!.id;
    const post = (b: unknown) => julio.post(`/api/lists/${listId}/votes`, b);
    assert.equal((await post({ left: id('Pikachu'), right: id('Pikachu'), result: 'left' })).status, 400);
    assert.equal((await post({ left: id('Pikachu'), right: foreign, result: 'left' })).status, 400);
    assert.equal((await post({ left: id('Pikachu'), right: id('Squirtle'), result: 'both' })).status, 400);
    assert.equal((await julio.post(`/api/lists/${listId}/votes/undo`)).status, 400, 'nothing to undo');
  });

  test('"no lo conozco" removes an item from duels and the personal ranking', async () => {
    const { julio, listId, id } = await setup();
    await julio.put(`/api/items/${id('Pikachu')}/exclusion`, { excluded: true });
    for (let k = 0; k < 20; k++) {
      const duel = (await julio.get(`/api/lists/${listId}/duel`)).json;
      assert.ok(duel.pair.left.id !== id('Pikachu') && duel.pair.right.id !== id('Pikachu'));
      await julio.post(`/api/lists/${listId}/votes`, { left: duel.pair.left.id, right: duel.pair.right.id, result: 'left' });
    }
    const ranking = (await julio.get(`/api/lists/${listId}/ranking`)).json;
    assert.ok(!ranking.ranked.some((r: { itemId: number }) => r.itemId === id('Pikachu')));
    const vote = await julio.post(`/api/lists/${listId}/votes`, { left: id('Pikachu'), right: id('Squirtle'), result: 'left' });
    assert.equal(vote.status, 400);
  });

  test('archiving hides an item everywhere; un-archiving brings its votes back', async () => {
    const { julio, listId, id } = await setup();
    await julio.post(`/api/lists/${listId}/votes`, { left: id('Pikachu'), right: id('Squirtle'), result: 'left' });
    await julio.patch(`/api/items/${id('Pikachu')}`, { archived: true });
    let ranking = (await julio.get(`/api/lists/${listId}/ranking`)).json;
    assert.ok(!ranking.ranked.some((r: { itemId: number }) => r.itemId === id('Pikachu')));
    await julio.patch(`/api/items/${id('Pikachu')}`, { archived: false });
    ranking = (await julio.get(`/api/lists/${listId}/ranking`)).json;
    assert.equal(ranking.ranked[0].itemId, id('Pikachu'));
  });

  test('item edit permissions and validation', async () => {
    const julio = await register('julio');
    const ana = await register('ana');
    const g = (await julio.post('/api/groups', { name: 'G' })).json.group;
    await ana.post(`/api/invites/${(await julio.get(`/api/groups/${g.id}`)).json.group.inviteCode}/join`);
    const listId = (await julio.post('/api/lists', { title: 'L', groupId: g.id, items: ['A'] })).json.list.id;
    assert.equal((await ana.post(`/api/lists/${listId}/items`, { items: [{ name: 'B', imageUrl: 'https://example.com/b.png' }] })).status, 201);
    assert.equal((await ana.post(`/api/lists/${listId}/items`, { items: [{ name: 'C', imageUrl: 'javascript:alert(1)' }] })).status, 400);
    const items = (await ana.get(`/api/lists/${listId}`)).json.items as { id: number; name: string }[];
    const A = items.find((i) => i.name === 'A')!.id;
    const B = items.find((i) => i.name === 'B')!.id;
    assert.equal((await ana.patch(`/api/items/${A}`, { name: 'A2' })).status, 403, 'not creator nor owner');
    assert.equal((await ana.patch(`/api/items/${B}`, { name: 'B2' })).status, 200, 'creator can edit');
    assert.equal((await julio.patch(`/api/items/${B}`, { name: 'a' })).status, 400, 'name clash');
    assert.equal((await ana.patch(`/api/lists/${listId}`, { title: 'hack' })).status, 403);
    assert.equal((await ana.del(`/api/lists/${listId}`)).status, 403);
    assert.equal((await julio.del(`/api/lists/${listId}`)).status, 200);
  });
});

describe('group rankings and insights', () => {
  test('group ranking aggregates members; insights find soulmates and divisive items', async () => {
    const [julio, ana, bea, cata] = [await register('julio'), await register('ana'), await register('bea'), await register('cata')];
    const g = (await julio.post('/api/groups', { name: 'Completos' })).json.group;
    const code = (await julio.get(`/api/groups/${g.id}`)).json.group.inviteCode;
    for (const u of [ana, bea, cata]) await u.post(`/api/invites/${code}/join`);
    const listId = (await julio.post('/api/lists', { title: 'Completos', groupId: g.id, items: ['A', 'B', 'C', 'D'] })).json.list.id;
    const items = (await julio.get(`/api/lists/${listId}`)).json.items as { id: number; name: string }[];
    const id = (n: string) => items.find((i) => i.name === n)!.id;

    /** Votes every pair according to `order` (best first). */
    async function rankAs(u: Client, order: string[]) {
      for (let i = 0; i < order.length; i++)
        for (let j = i + 1; j < order.length; j++) await u.post(`/api/lists/${listId}/votes`, { left: id(order[i]!), right: id(order[j]!), result: 'left' });
    }
    await rankAs(julio, ['A', 'B', 'C', 'D']);
    await rankAs(ana, ['A', 'B', 'C', 'D']);
    await rankAs(bea, ['A', 'C', 'B', 'D']);
    await rankAs(cata, ['D', 'C', 'B', 'A']);

    const group = (await julio.get(`/api/lists/${listId}/group`)).json;
    assert.equal(group.contributors.length, 4);
    assert.equal(group.ranked[0].itemId, id('A'));

    const insights = (await julio.get(`/api/lists/${listId}/insights`)).json;
    assert.equal(insights.soulmate.userId, ana.id);
    assert.equal(insights.soulmate.agreement, 1);
    assert.equal(insights.opposite.userId, cata.id);
    assert.equal(insights.opposite.agreement, 0);
    assert.ok([id('A'), id('D')].includes(insights.divisive[0].itemId));
    const cataTakes = insights.hotTakes.find((h: { userId: number }) => h.userId === cata.id).takes;
    assert.ok(cataTakes.length > 0);

    // Members can see each other's personal rankings in a group list.
    const cataRanking = (await julio.get(`/api/lists/${listId}/ranking?user=${cata.id}`)).json;
    assert.equal(cataRanking.ranked[0].itemId, id('D'));
  });

  test('group endpoints reject personal lists', async () => {
    const julio = await register('julio');
    const listId = (await julio.post('/api/lists', { title: 'L', items: ['A', 'B'] })).json.list.id;
    assert.equal((await julio.get(`/api/lists/${listId}/group`)).status, 400);
    assert.equal((await julio.get(`/api/lists/${listId}/insights`)).status, 400);
  });
});
