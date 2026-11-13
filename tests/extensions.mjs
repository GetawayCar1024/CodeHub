import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createApp } from '../src/app.js';

async function fixture(t, run) {
  let now = Date.UTC(2030, 0, 1);
  t.mock.method(Date, 'now', () => now);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codehub-extension-'));
  const app = createApp({ dataDir: home, log() {} });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  const client = () => {
    let cookie = '';
    return async (method, route, body, expected = 200) => {
      const response = await fetch(origin + route, { method, headers: { 'X-CodeHub': '1', Cookie: cookie, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
      if (response.headers.has('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
      const value = response.headers.get('content-type')?.includes('json') ? await response.json() : Buffer.from(await response.arrayBuffer());
      assert.equal(response.status, expected, `${method} ${route}: ${JSON.stringify(value)}`);
      return value;
    };
  };
  try {
    const admin = client(), alice = client(), bob = client(), outsider = client();
    await admin('POST', '/api/login', { username: 'admin', password: '123456' });
    await admin('POST', '/api/admin/users/import', { text: 'alice,test-password,Alice,allowed\nbob,test-password,Bob,allowed\noutsider,test-password,Outsider,other' });
    for (const [username, call] of [['alice', alice], ['bob', bob], ['outsider', outsider]]) await call('POST', '/api/login', { username, password: 'test-password' });
    const start = now + 600000, end = start + 3600000;
    const group = app.ctx.data.groups.find(group => group.name === 'allowed');
    const created = await admin('POST', '/api/admin/contests', { name: 'extra-time', startTime: start, endTime: end, earlyMinutes: 10, passwordReleaseMinutes: 0, downZipReleaseMinutes: 0, problems: [{ name: 'sum' }], groups: [group.id] });
    const c = app.ctx.contest(created.id), uid = app.ctx.data.users.find(user => user.username === 'alice').id;
    await alice('POST', `/api/contests/${c.id}/join`, { confirm: true, strict: true });
    await run({ app, home, admin, alice, bob, outsider, c, uid, start, end, clock: value => { now = value; }, base: `/api/admin/contests/${c.id}`, publicBase: `/api/contests/${c.id}` });
  } finally { app.stop(); app.server.closeAllConnections(); await new Promise(resolve => app.server.close(resolve)); fs.rmSync(home, { recursive: true, force: true }); }
}

test('extra time applies only to the selected contestant, including deadlines and direct submission routes', async t => fixture(t, async ({ admin, alice, bob, outsider, c, uid, start, end, clock, base, publicBase }) => {
  await admin('PUT', base + '/extensions/' + uid, { minutes: 15 });
  assert.equal(c.endTime, end, 'the original contest schedule must not change');
  clock(start - 1);
  const hidden = await alice('GET', publicBase);
  assert.equal(hidden.problemsReleased, false); assert.deepEqual(hidden.problems, []);
  assert.equal(hidden.endTime, end + 15 * 60000);
  clock(end + 1);
  assert.equal((await alice('GET', publicBase)).phase, 'running');
  assert.equal((await alice('GET', '/api/contests')).contests[0].endTime, end + 15 * 60000);
  assert.equal((await bob('GET', '/api/contests')).contests[0].phase, 'ended');
  assert.equal((await bob('GET', publicBase)).phase, 'ended'); await outsider('GET', publicBase, undefined, 404);
  await alice('POST', publicBase + '/submit', { problem: 'sum', code: 'int main(){}' });
  assert.equal((await alice('GET', publicBase + '/source/sum')).code, 'int main(){}');
  clock(end + 15 * 60000);
  await alice('POST', publicBase + '/submit', { problem: 'sum', code: 'int main(){}' }, 403);
  assert.equal((await alice('GET', publicBase)).phase, 'ended');
}));

test('extensions accumulate only while a contestant has not finished, and survive persistence', async t => fixture(t, async ({ app, home, admin, alice, bob, c, uid, start, end, clock, base, publicBase }) => {
  clock(start + 1);
  await alice('POST', publicBase + '/finish');
  await admin('PUT', base + '/extensions/' + uid, { minutes: 20 }, 409);
  await alice('POST', publicBase + '/submit', { problem: 'sum', code: 'x' }, 403);
  await admin('DELETE', base + '/finished/' + uid);
  await admin('PUT', base + '/extensions/' + uid, { minutes: 20 });
  clock(end + 5 * 60000);
  await admin('PUT', base + '/extensions/' + uid, { minutes: 30 });
  assert.equal((await alice('GET', publicBase)).endTime, end + 30 * 60000);
  assert.equal((await bob('GET', publicBase)).phase, 'ended');
  const bobId = app.ctx.data.users.find(user => user.username === 'bob').id;
  await admin('PUT', base + '/extensions/' + bobId, { minutes: 30 }, 409);
  const copy = createApp({ dataDir: home, log() {} });
  assert.equal(copy.ctx.contest(c.id).extraMinutes[uid], 30); copy.stop();
  clock(end + 30 * 60000);
  await admin('PUT', base + '/extensions/' + uid, { minutes: 40 }, 409);
  assert.equal((await alice('GET', publicBase)).phase, 'ended');
  assert.equal((await admin('GET', base + '/board')).rows.find(row => row.id === uid).extraMinutes, 30);
  assert.equal(app.ctx.contest(c.id).endTime, end);
}));

test('past contests retain only the caller’s materials and code, with a result link only when Lemon is public', async t => fixture(t, async ({ app, admin, alice, bob, outsider, c, start, end, clock, publicBase }) => {
  c.downZipPassword = 'fixture-password';
  const bytes = Buffer.from('PK fixture');
  fs.mkdirSync(path.dirname(app.ctx.downZipFile(c)), { recursive: true }); fs.writeFileSync(app.ctx.downZipFile(c), bytes);
  c.downZip = { name: 'down.zip', size: bytes.length };
  clock(start + 1);
  await alice('POST', publicBase + '/submit', { problem: 'sum', code: '// my code\nint main(){}' });
  clock(end + 1);
  const detail = await alice('GET', publicBase);
  assert.equal(detail.phase, 'ended'); assert.equal(detail.password, 'fixture-password');
  assert.equal(detail.downZipState, 'available'); assert.deepEqual(await alice('GET', publicBase + '/down.zip'), bytes);
  assert.equal((await alice('GET', publicBase + '/source/sum')).code, '// my code\nint main(){}');
  await bob('GET', publicBase + '/source/sum', undefined, 404);
  await outsider('GET', publicBase, undefined, 404);
  await alice('POST', publicBase + '/submit', { problem: 'sum', code: 'changed' }, 403);
  c.lemon = { contest: '公开比赛', interval: null };
  app.ctx.data.settings.lemon = { url: 'https://judge.example', publicUrl: 'https://results.example', apiKey: 'test-only' };
  app.ctx.lemon.remote = async () => ({ public: false });
  assert.equal((await alice('GET', publicBase)).lemonResultsLink, null);
  app.ctx.lemon.remote = async () => ({ public: true });
  assert.equal((await alice('GET', publicBase)).lemonResultsLink, 'https://results.example/#/contest/%E5%85%AC%E5%BC%80%E6%AF%94%E8%B5%9B/results');
}));

test('extra time validates participants and writes atomically', async t => fixture(t, async ({ app, admin, alice, uid, base }) => {
  await alice('PUT', base + '/extensions/' + uid, { minutes: 10 }, 403);
  for (const minutes of [-1, 1.5, 10081, true, '5', null]) await admin('PUT', base + '/extensions/' + uid, { minutes }, 400);
  await admin('PUT', base + '/extensions/1', { minutes: 10 }, 404);
  const outsiderId = app.ctx.data.users.find(user => user.username === 'outsider').id;
  await admin('PUT', base + '/extensions/' + outsiderId, { minutes: 10 }, 400);
  await admin('PUT', base + '/extensions/' + uid, { minutes: 5 });
  assert.equal((await admin('PUT', base + '/extensions/' + uid, { minutes: 3 })).minutes, 3, 'the value replaces the previous one and may be smaller');
  await admin('PUT', base + '/extensions/' + uid, { minutes: 5 });
  const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (from, to) => { if (to === app.ctx.store.file) throw Error('injected disk failure'); return rename(from, to); });
  await admin('PUT', base + '/extensions/' + uid, { minutes: 12 }, 500);
  assert.equal(app.ctx.contest(1).extraMinutes[uid], 5);
  t.mock.restoreAll();
}));

test('extra time is set directly, may be reduced only to a future deadline, and can be set for several contestants at once', async t => fixture(t, async ({ app, admin, alice, bob, c, uid, end, clock, base, publicBase }) => {
  const bobId = app.ctx.data.users.find(user => user.username === 'bob').id;
  await bob('POST', publicBase + '/join', { confirm: true, strict: true });
  const batch = await admin('POST', base + '/extensions', { ids: [uid, bobId], minutes: 20 });
  assert.deepEqual(batch.users.map(user => [user.id, user.minutes, user.endTime]), [[uid, 20, end + 20 * 60000], [bobId, 20, end + 20 * 60000]]);
  await admin('PUT', base + '/extensions/' + uid, { minutes: 20 });
  assert.equal(c.extraMinutes[uid], 20, 'setting the same value again does not add to it');
  clock(end + 10 * 60000);
  await admin('PUT', base + '/extensions/' + uid, { minutes: 10 }, 400);
  await admin('POST', base + '/extensions', { ids: [uid, bobId], minutes: 5 }, 400);
  assert.deepEqual([c.extraMinutes[uid], c.extraMinutes[bobId]], [20, 20], 'a rejected batch changes nobody');
  await admin('POST', base + '/extensions', { ids: [uid, bobId], minutes: 11 });
  assert.equal((await alice('GET', publicBase)).endTime, end + 11 * 60000);
  await admin('PUT', base + '/extensions/' + bobId, { minutes: 30 });
  await alice('POST', publicBase + '/finish');
  await admin('POST', base + '/extensions', { ids: [uid, bobId], minutes: 40 }, 409);
  assert.equal(c.extraMinutes[bobId], 30);
  for (const ids of [[], 'x', [99999]]) await admin('POST', base + '/extensions', { ids, minutes: 5 }, Array.isArray(ids) && ids.length ? 404 : 400);
  await alice('POST', base + '/extensions', { ids: [uid], minutes: 5 }, 403);
  clock(end + 12 * 60000);
  await admin('PUT', base + '/extensions/' + bobId, { minutes: 0 }, 400);
  await admin('PUT', base + '/extensions/' + bobId, { minutes: 15 });
  assert.equal(c.endTime, end);
}));

test('the original judging policy runs until the final contestant deadline, then judges only unjudged code', async t => fixture(t, async ({ app, admin, c, uid, start, end, clock, base }) => {
  await admin('PUT', base + '/extensions/' + uid, { minutes: 10 });
  c.lemon = { contest: 'remote', interval: null };
  app.ctx.lemon.client.configured = () => true;
  app.ctx.lemon.rt(c).needTasks = false;
  const calls = [];
  app.ctx.lemon.runTask = async (contest, kind, mode = 'unjudged') => { calls.push({ kind, mode }); return 'done'; };
  clock(end); await app.ctx.lemon.tick(); await Promise.resolve();
  assert.deepEqual(calls, []);
  clock(end + 1); await app.ctx.lemon.tick(); assert.equal(calls.length, 0);
  clock(end + 10 * 60000); await app.ctx.lemon.tick(); await Promise.resolve();
  assert.deepEqual(calls, [{ kind: 'final', mode: 'unjudged' }]);
  assert.equal(app.ctx.data.lemonState[c.id].finalDone, true);
}));
