import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createApp } from '../src/app.js';
import { checkPassword } from '../src/util.js';

async function fixture(run) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codehub-participation-'));
  const app = createApp({ dataDir: home, log() {} });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  const client = () => {
    let cookie = '';
    return async (method, endpoint, body, status = 200) => {
      const response = await fetch(origin + endpoint, { method, headers: { 'X-CodeHub': '1', 'Content-Type': 'application/json', Cookie: cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
      if (response.headers.has('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
      const value = response.headers.get('content-type')?.includes('json') ? await response.json() : await response.text();
      assert.equal(response.status, status, `${method} ${endpoint}: ${JSON.stringify(value)}`);
      return value;
    };
  };
  try {
    const admin = client(), alice = client(), anonymous = client();
    await admin('POST', '/api/login', { username: 'admin', password: '123456' });
    await admin('POST', '/api/admin/users/import', { text: 'alice,test-password,Alice,one\nbob,test-password,Bob,two\nplain,test-password' });
    await alice('POST', '/api/login', { username: 'alice', password: 'test-password' });
    const create = async (name, extra = {}) => {
      const value = await admin('POST', '/api/admin/contests', { name, startTime: Date.now() + 60000, endTime: Date.now() + 3660000, problems: [{ name: 'sum' }], downZipPassword: 'secret', ...extra });
      return app.ctx.contest(value.id);
    };
    const join = (c, strict = c.strict !== false) => alice('POST', `/api/contests/${c.id}/join`, { confirm: true, strict });
    await run({ home, app, admin, alice, anonymous, create, join, user: app.ctx.data.users.find(user => user.username === 'alice') });
  } finally { app.stop(); app.server.closeAllConnections(); await new Promise(resolve => app.server.close(resolve)); fs.rmSync(home, { recursive: true, force: true }); }
}

test('entry confirmation protects materials, creates an empty participant folder and persists once', async () => fixture(async ({ home, app, admin, alice, anonymous, create, join, user }) => {
  const c = await create('confirm'), base = `/api/contests/${c.id}`;
  assert.equal(c.strict, true);
  const preview = await alice('GET', base);
  assert.equal(preview.requiresConfirmation, true); assert.equal(preview.strict, true); assert.equal(preview.durationMinutes, 60);
  for (const key of ['password', 'problems', 'downZip', 'finishedAt']) assert.equal(preview[key], undefined);
  assert.equal(fs.existsSync(path.join(app.ctx.contestDir(c), user.username)), false);
  for (const resource of ['/down.zip', '/source/sum']) await alice('GET', base + resource, undefined, 403);
  await alice('POST', base + '/submit', { problem: 'sum', code: 'int main(){}' }, 403);
  await alice('POST', base + '/join', { confirm: false, strict: true }, 400);
  await alice('POST', base + '/join', { confirm: true, strict: false }, 409);
  await anonymous('POST', base + '/join', { confirm: true, strict: true }, 401);
  await admin('POST', base + '/join', { confirm: true, strict: true }, 403);
  const first = await join(c);
  assert.deepEqual(await join(c), first);
  assert.deepEqual(fs.readdirSync(path.join(app.ctx.contestDir(c), user.username)), []);
  assert.equal((await alice('GET', base)).requiresConfirmation, false);
  const reloaded = createApp({ dataDir: home, log() {} });
  assert.equal(reloaded.ctx.data.participants[c.id][user.id], first.joinedAt); reloaded.stop();
  c.endTime = Date.now() - 1; c.startTime = c.endTime - 60000;
  await alice('POST', base + '/join', { confirm: true, strict: true }, 409);
}));

test('empty participant synchronization retries failures without creating submissions or judging on entry', async () => fixture(async ({ app, create, join, user }) => {
  const c = await create('empty-sync'); c.lemon = { contest: 'remote', interval: 0 };
  app.ctx.data.settings.lemon = { url: 'http://fixture.invalid', apiKey: 'fixture' };
  let fail = true; const requests = [];
  app.ctx.lemon.client.call = async (method, path, options) => { requests.push({ method, path, options }); if (fail) throw Error('offline'); return {}; };
  await join(c); await app.ctx.lemon.rt(c).chain;
  assert.ok(app.ctx.lemon.pendingOf(c)[user.id + '|']);
  fail = false; await app.ctx.lemon.flushUploads(c);
  assert.deepEqual(app.ctx.lemon.pendingOf(c), {});
  assert.ok(requests.every(request => request.method === 'POST' && request.path.endsWith('/files/mkdir') && request.options.json.path === 'alice'));
  assert.equal(app.ctx.data.submissions[c.id], undefined);
  assert.equal(app.ctx.lemon.rt(c).pending, false);
}));

test('existing submissions acquire participation when old data is loaded', async () => fixture(async ({ home, app, create, user }) => {
  const c = await create('legacy-entry');
  app.ctx.data.submissions[c.id] = { [user.id]: { sum: { time: Date.now() - 2000, count: 1, size: 5 } } };
  app.ctx.store.flush();
  const upgraded = createApp({ dataDir: home, log() {} });
  assert.equal(upgraded.ctx.data.participants[c.id][user.id], app.ctx.data.submissions[c.id][user.id].sum.time);
  upgraded.stop();
}));

test('multiple participation and strict-mode history restrictions use individual deadlines and early finish', async () => fixture(async ({ app, admin, alice, create, join, user }) => {
  const history = await create('history'); history.endTime = Date.now() - 1; history.startTime = history.endTime - 60000;
  const a = await create('strict-a'), b = await create('strict-b'), casual = await create('casual', { strict: false });
  const old = `/api/contests/${history.id}`, active = c => `/api/contests/${c.id}`;
  await alice('GET', old); await join(casual); await alice('GET', old);
  await join(a);
  for (const resource of ['', '/down.zip', '/source/sum']) await alice('GET', old + resource, undefined, 403);
  assert.equal((await alice('GET', '/api/contests')).contests.find(c => c.id === history.id).historyBlocked, true);
  await join(b);
  for (const c of [a, b]) c.startTime = Date.now() - 1000;
  await alice('POST', active(a) + '/finish');
  await alice('GET', old, undefined, 403);
  await alice('POST', active(b) + '/finish');
  await alice('GET', old);
  await admin('DELETE', `/api/admin/contests/${a.id}/finished/${user.id}`);
  a.endTime = Date.now() - 1; a.extraMinutes = { [user.id]: 10 };
  await alice('GET', old, undefined, 403);
  a.extraMinutes[user.id] = 0;
  await alice('GET', old);
  b.strict = false; delete app.ctx.data.finished[b.id][user.id];
  await alice('GET', old);
  await admin('PUT', `/api/admin/contests/${b.id}`, { strict: true });
  await alice('GET', old, undefined, 403);
  await admin('PUT', `/api/admin/contests/${b.id}`, { strict: 'false' }, 400);
}));

test('a confirmed strict contest blocks ended contests even before it starts, but never running or upcoming ones', async () => fixture(async ({ alice, create, join }) => {
  const history = await create('old'); history.endTime = Date.now() - 1; history.startTime = history.endTime - 60000;
  const strict = await create('strict-later'), other = await create('other-running', { strict: false });
  other.startTime = Date.now() - 1000;
  await join(strict);
  await alice('GET', `/api/contests/${history.id}`, undefined, 403);
  // the start moves later: the contest is no longer open, but the confirmation still counts
  strict.startTime = Date.now() + 7 * 24 * 3600000; strict.endTime = strict.startTime + 3600000;
  await alice('GET', `/api/contests/${strict.id}`, undefined, 404);
  await alice('GET', `/api/contests/${history.id}`, undefined, 403);
  assert.equal((await alice('GET', `/api/contests/${other.id}`)).phase, 'running');
  await join(other);
  assert.equal((await alice('GET', `/api/contests/${other.id}`)).requiresConfirmation, false);
  strict.endTime = Date.now() - 1; strict.startTime = strict.endTime - 60000;
  await alice('GET', `/api/contests/${history.id}`);
}));

test('failed confirmation rolls back both participant state and newly created folders', async () => fixture(async ({ app, alice, create, user }) => {
  const c = await create('failed-confirmation');
  const flush = app.ctx.store.flush;
  app.ctx.store.flush = () => { throw Error('fixture write failure'); };
  try {
    await alice('POST', `/api/contests/${c.id}/join`, { confirm: true, strict: true }, 500);
    assert.equal(app.ctx.data.participants[c.id], undefined);
    assert.equal(fs.existsSync(path.join(app.ctx.contestDir(c), user.username)), false);
  } finally { app.ctx.store.flush = flush; }
}));

test('exports select users before groups and support CSV, TSV, TXT and JSON without secrets', async () => fixture(async ({ app, admin, alice, anonymous, user }) => {
  const group = app.ctx.data.groups.find(group => group.name === 'two').id;
  const endpoint = '/api/admin/users/export';
  const selected = await admin('GET', endpoint + `?format=json&group=${group}&ids=${user.id}`);
  assert.deepEqual(selected.map(row => row.username), ['alice']);
  assert.deepEqual((await admin('GET', endpoint + `?format=json&group=${group}`)).map(row => row.username), ['bob']);
  assert.deepEqual((await admin('GET', endpoint + '?format=json&group=none')).map(row => row.username), ['plain']);
  assert.equal((await admin('GET', endpoint + '?format=json')).length, 3);
  user.realName = '=formula,"quoted"\nline';
  for (const format of ['csv', 'tsv', 'txt']) {
    const body = await admin('GET', endpoint + `?format=${format}&ids=${user.id}`);
    assert.ok(body.includes('alice') && !body.includes('bob') && !body.includes('passwordHash'));
    assert.ok(body.includes("'=formula,")); assert.ok(body.includes('""quoted""'));
  }
  assert.ok((await admin('GET', '/api/admin/users/export.csv')).replace(/^\uFEFF/, '').startsWith('用户名,密码,真实姓名,分组\r\n'));
  await admin('GET', endpoint + '?format=xlsx', undefined, 400);
  await admin('GET', endpoint + '?ids=99999', undefined, 400);
  await alice('GET', endpoint, undefined, 403); await anonymous('GET', endpoint, undefined, 401);
}));

test('exported CSV, TSV and TXT files import back unchanged, keeping passwords; old exports are read by header', async () => fixture(async ({ app, admin, alice }) => {
  const user = app.ctx.data.users.find(item => item.username === 'alice');
  await admin('POST', '/api/admin/groups', { name: 'g,1' });
  await admin('POST', '/api/admin/users/batch', { ids: [user.id], action: 'addGroups', groups: [app.ctx.data.groups.find(g => g.name === 'g,1').id] });
  const snapshot = () => app.ctx.data.users.filter(u => u.role !== 'admin').map(u => ({ username: u.username, realName: u.realName, groups: [...u.groups].sort(), hash: u.passwordHash }));
  for (const [name, realName] of [['plain', 'Plain'], ['alice', '-张,三 "A"\n二行'], ['bob', '=SUM(1)']]) app.ctx.data.users.find(u => u.username === name).realName = realName;
  const before = snapshot();
  for (const format of ['csv', 'tsv', 'txt']) {
    const text = await admin('GET', `/api/admin/users/export?format=${format}`);
    const result = await admin('POST', '/api/admin/users/import', { text, mode: 'overwrite' });
    assert.deepEqual([result.errors, result.added, result.updated], [[], 0, 3], format);
    assert.deepEqual(snapshot(), before, `${format} round trip must not change names, groups or passwords`);
    const skipped = await admin('POST', '/api/admin/users/import', { text });
    assert.deepEqual([skipped.added, skipped.skipped], [0, 3]);
  }
  await alice('GET', '/api/contests'); // the session survives a re-import without passwords
  const old = '\uFEFF用户名,真实姓名,分组\r\nalice,Alice Again,one\r\nnew-user,New,one';
  const rejected = await admin('POST', '/api/admin/users/import', { text: old, mode: 'overwrite' });
  assert.deepEqual(rejected.errors, [{ line: 3, message: '密码为空（新用户须填写密码）' }]);
  const header = await admin('POST', '/api/admin/users/import', { text: '账号\t姓名\t密码\nnew-user\t新 用户\tpw-123456\nalice\tAlice Again\t', mode: 'overwrite' });
  assert.deepEqual([header.errors, header.added, header.updated], [[], 1, 1]);
  const created = app.ctx.data.users.find(u => u.username === 'new-user');
  assert.equal(created.realName, '新 用户');
  assert.ok(checkPassword('pw-123456', created.passwordHash));
  assert.equal(user.realName, 'Alice Again');
  const quoted = await admin('POST', '/api/admin/users/import', { text: 'quoted,"p,w","Q ""uote""","x;y"', mode: 'overwrite' });
  assert.deepEqual(quoted.errors, []);
  const q = app.ctx.data.users.find(u => u.username === 'quoted');
  assert.equal(q.realName, 'Q "uote"');
  assert.deepEqual(q.groups.map(id => app.ctx.data.groups.find(g => g.id === id).name), ['x', 'y']);
}));
