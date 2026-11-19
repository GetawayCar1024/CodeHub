import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createApp } from '../src/app.js';
import { LemonError } from '../src/lemon.js';

async function fixture(run) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codehub-lemon-sharing-'));
  const app = createApp({ dataDir: home, log() {} });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  let cookie = '';
  const admin = async (method, endpoint, body, status = 200) => {
    const response = await fetch(origin + endpoint, { method, headers: { 'X-CodeHub': '1', 'Content-Type': 'application/json', Cookie: cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
    if (response.headers.has('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
    const value = await response.json();
    assert.equal(response.status, status, `${method} ${endpoint}: ${JSON.stringify(value)}`);
    return value;
  };
  try {
    await admin('POST', '/api/login', { username: 'admin', password: '123456' });
    await admin('POST', '/api/admin/users/import', { text: 'alice,test-password\nbob,test-password' });
    app.ctx.data.settings.lemon = { url: 'http://lemon.invalid', publicUrl: '', apiKey: 'fixture-key' };
    await run({ home, app, admin });
  } finally { app.stop(); app.server.closeAllConnections(); await new Promise(resolve => app.server.close(resolve)); fs.rmSync(home, { recursive: true, force: true }); }
}

const contestBody = (extra = {}) => ({ name: 'shared', startTime: Date.now() + 60000, endTime: Date.now() + 3660000, problems: [{ name: 'sum' }], ...extra });

test('archived LemonServer contests are not offered and cannot be linked', async () => fixture(async ({ app, admin }) => {
  const remote = { open: { name: 'open', archived: false, tasks: [] }, old: { name: 'old', archived: true, tasks: [] } };
  app.ctx.lemon.client.call = async (method, endpoint) => {
    if (endpoint === '/api/contests') return { contests: [{ name: 'open', title: 'Open', tasks: 1, archived: false }, { name: 'old', title: 'Old', tasks: 2, archived: true }] };
    const name = decodeURIComponent(endpoint.split('/')[3]);
    if (remote[name]) return remote[name];
    throw new LemonError(404, 'Contest not found');
  };
  assert.deepEqual((await admin('GET', '/api/admin/lemon/contests')).map(item => item.name), ['open']);
  await admin('POST', '/api/admin/contests', contestBody({ lemon: { contest: 'old' } }), 409);
  assert.equal(app.ctx.data.contests.length, 0);
  const created = await admin('POST', '/api/admin/contests', contestBody({ lemon: { contest: 'open' } }));
  await admin('PUT', `/api/admin/contests/${created.id}`, { lemon: { contest: 'old' } }, 409);
  assert.equal(app.ctx.contest(created.id).lemon.contest, 'open');
  // a link made before the LemonServer contest was archived stays editable
  remote.open.archived = true;
  await admin('PUT', `/api/admin/contests/${created.id}`, { title: 'renamed', lemon: { contest: 'open', interval: null } });
}));

test('every LemonServer request identifies this CodeHub server with a persistent instance id', async t => fixture(async ({ home, app }) => {
  const id = app.ctx.data.instanceId;
  assert.match(id, /^[A-Za-z0-9_-]{16,64}$/);
  const seen = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => { seen.push(options.headers); return new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } }); });
  await app.ctx.lemon.client.call('GET', '/api/contests');
  t.mock.restoreAll();
  assert.equal(seen[0]['X-CodeHub-Instance'], id);
  const copy = createApp({ dataDir: home, log() {} });
  assert.equal(copy.ctx.data.instanceId, id); copy.stop();
}));

test('accounts owned by another CodeHub on the shared contest are reported and never block other uploads', async () => fixture(async ({ app, admin }) => {
  const created = await admin('POST', '/api/admin/contests', contestBody());
  const c = app.ctx.contest(created.id), users = Object.fromEntries(app.ctx.data.users.map(u => [u.username, u]));
  for (const name of ['alice', 'bob']) app.ctx.data.participants[c.id] = { ...app.ctx.data.participants[c.id], [users[name].id]: Date.now() };
  c.lemon = { contest: 'shared', interval: null };
  const calls = [];
  app.ctx.lemon.client.call = async (method, endpoint, options = {}) => {
    calls.push([method, endpoint, options.json?.path ?? options.query?.path]);
    if (endpoint.endsWith('/files/mkdir') && options.json.path === 'alice')
      throw new LemonError(409, 'Contestant alice belongs to another CodeHub server', { ownedByOther: true });
    return {};
  };
  // linked by an older CodeHub: the contestants are claimed once on start
  app.ctx.lemon.start(); clearInterval(app.ctx.lemon.timer);
  assert.equal(await app.ctx.lemon.flushUploads(c), true);
  assert.deepEqual(calls.map(call => call[2]).sort(), ['alice', 'bob']);
  assert.deepEqual(app.ctx.lemon.pendingOf(c), {});
  assert.deepEqual(app.ctx.lemon.conflictsOf(c), ['alice']);
  app.ctx.lemon.remote = async () => ({ tasks: [], contestants: [] });
  assert.deepEqual((await admin('GET', `/api/admin/contests/${c.id}/board`)).lemon.conflicts, ['alice']);
  calls.length = 0;
  app.ctx.lemon.start(); clearInterval(app.ctx.lemon.timer);
  assert.equal(calls.length, 0, 'claiming happens only once');
  app.ctx.lemon.client.call = async () => ({});
  app.ctx.lemon.markAllPending(c);
  await app.ctx.lemon.flushUploads(c);
  assert.deepEqual(app.ctx.lemon.conflictsOf(c), [], 'a later successful upload clears the conflict');
}));

test('jobs of other CodeHub servers on the same contest do not count as an unfinished run', async () => fixture(async ({ app, admin }) => {
  const created = await admin('POST', '/api/admin/contests', contestBody());
  const c = app.ctx.contest(created.id); c.lemon = { contest: 'shared', interval: null };
  app.ctx.lemon.rt(c).needTasks = false;
  let queue = { running: { id: 7, contest: 'shared', owner: 'another-codehub-1' }, queue: [] }, posted = 0;
  app.ctx.lemon.client.call = async (method, endpoint) => {
    if (endpoint === '/api/judge-queue') return queue;
    if (endpoint.endsWith('/judge')) { posted++; return { job: { id: 8, skipped: true } }; }
    return {};
  };
  assert.equal(await app.ctx.lemon.runTask(c, 'manual'), 'done');
  assert.equal(posted, 1);
  queue = { running: { id: 9, contest: 'shared', owner: app.ctx.data.instanceId }, queue: [] };
  assert.equal(await app.ctx.lemon.runTask(c, 'manual'), 'skipped');
  queue = { running: null, queue: [{ id: 10, contest: 'shared', owner: '' }] };
  assert.equal(await app.ctx.lemon.runTask(c, 'manual'), 'skipped', 'jobs started on LemonServer itself still count');
  assert.equal(posted, 1);
}));
