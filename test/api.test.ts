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
const freshApp = (opts: { signupCode?: string } = {}) => createApp({ db: openDb(':memory:'), ...opts });

async function register(name: string, a: App = app, extra: Record<string, unknown> = {}) {
  const c = new Client(a);
  const r = await c.post('/api/auth/register', { username: name, password: 'password123', displayName: name.toUpperCase(), ...extra });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  return Object.assign(c, { id: r.json.user.id as number });
}

beforeEach(() => {
  app = freshApp();
});

describe('auth', () => {
  test('register, me, logout, login', async () => {
    const c = await register('julio');
    assert.equal((await c.get('/api/auth/me')).json.user.username, 'julio');
    await c.post('/api/auth/logout');
    assert.equal((await c.get('/api/auth/me')).status, 401);
    const bad = await c.post('/api/auth/login', { username: 'julio', password: 'nope-nope' });
    assert.equal(bad.status, 401);
    const ok = await c.post('/api/auth/login', { username: 'JULIO', password: 'password123' });
    assert.equal(ok.status, 200);
    assert.equal((await c.get('/api/auth/me')).status, 200);
  });

  test('session cookie is HttpOnly + SameSite=Lax and token is not stored in plain text', async () => {
    const db = openDb(':memory:');
    const a = createApp({ db });
    const c = new Client(a);
    const r = await c.post('/api/auth/register', { username: 'ana', password: 'password123' });
    const header = r.headers.get('set-cookie')!;
    assert.match(header, /HttpOnly/);
    assert.match(header, /SameSite=Lax/);
    const token = c.cookie.split('=')[1]!;
    const row = db.prepare('SELECT token_hash FROM sessions').get() as { token_hash: string };
    assert.notEqual(row.token_hash, token);
  });

  test('validation: duplicate user, short password, bad username', async () => {
    await register('julio');
    const c = new Client(app);
    assert.equal((await c.post('/api/auth/register', { username: 'Julio', password: 'password123' })).status, 409);
    assert.equal((await c.post('/api/auth/register', { username: 'pedro', password: 'short' })).status, 400);
    assert.equal((await c.post('/api/auth/register', { username: 'a b', password: 'password123' })).status, 400);
  });

  test('login is rate limited', async () => {
    await register('julio');
    const c = new Client(app);
    let last = 0;
    for (let i = 0; i < 11; i++) last = (await c.post('/api/auth/login', { username: 'julio', password: 'wrong-pass' })).status;
    assert.equal(last, 429);
  });

  test('mutations without JSON content-type are rejected (CSRF)', async () => {
    const c = await register('julio');
    const r = await c.req('POST', '/api/lists', { title: 'x' }, { 'content-type': 'application/x-www-form-urlencoded' });
    assert.equal(r.status, 415);
  });

  test('signup code: required when configured; a group invite also works', async () => {
    const a = freshApp({ signupCode: 'galaxia' });
    const anon = new Client(a);
    assert.equal((await anon.post('/api/auth/register', { username: 'x1x', password: 'password123' })).status, 403);
    const owner = await register('owner', a, { code: 'galaxia' });
    const g = await owner.post('/api/groups', { name: 'Amigos' });
    const { group } = (await owner.get(`/api/groups/${g.json.group.id}`)).json;
    await register('friend', a, { code: group.inviteCode });
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
