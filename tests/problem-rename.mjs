// Actual HTTP + on-disk regressions for renaming a problem with existing submissions.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createApp } from '../src/app.js';

async function fixture(subFolder, run) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codehub-rename-'));
  const app = createApp({ dataDir: home, log() {} });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const client = () => {
    let cookie = '';
    return async (method, endpoint, body, status = 200) => {
      const response = await fetch(base + endpoint, { method, headers: { 'Content-Type': 'application/json', 'X-CodeHub': '1', Cookie: cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
      if (response.headers.has('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
      const value = response.headers.get('content-type')?.includes('json') ? await response.json() : Buffer.from(await response.arrayBuffer());
      assert.equal(response.status, status, `${method} ${endpoint}: ${JSON.stringify(value).slice(0, 300)}`);
      return value;
    };
  };
  try {
    const admin = client();
    await admin('POST', '/api/login', { username: 'admin', password: '123456' });
    await admin('POST', '/api/admin/users/import', { text: 'alice,alice-password\nbob,bob-password' });
    const alice = client(), bob = client();
    await alice('POST', '/api/login', { username: 'alice', password: 'alice-password' });
    await bob('POST', '/api/login', { username: 'bob', password: 'bob-password' });
    const contest = await admin('POST', '/api/admin/contests', {
      name: 'rename-test', title: '改名测试', subFolder,
      startTime: Date.now() + 3600000, endTime: Date.now() + 7200000,
      problems: [{ name: 'alpha', title: '甲' }, { name: 'beta', title: '乙' }],
    });
    const c = app.ctx.contest(contest.id);
    c.startTime = Date.now() - 1000;
    const endpoint = `/api/admin/contests/${c.id}`;
    const userEndpoint = `/api/contests/${c.id}`;
    const users = Object.fromEntries(app.ctx.data.users.map(user => [user.username, user]));
    const file = (user, problem) => app.ctx.submissionFile(c, user, problem);
    const alpha = 'int main(){return 0;} // alpha\r\n';
    const beta = 'int main(){return 1;} // beta\n';
    await alice('POST', userEndpoint + '/submit', { problem: 'alpha', code: '// first\n' });
    const submitted = (await alice('POST', userEndpoint + '/submit', { problem: 'alpha', code: alpha })).submission;
    await bob('POST', userEndpoint + '/submit', { problem: 'alpha', code: '// bob\n' });
    await alice('POST', userEndpoint + '/submit', { problem: 'beta', code: beta });
    await run({ home, app, admin, alice, bob, c, endpoint, userEndpoint, users, file, alpha, beta, submitted });
  } finally {
    app.stop(); app.server.closeAllConnections();
    await new Promise(resolve => app.server.close(resolve));
    fs.rmSync(home, { recursive: true, force: true });
  }
}

for (const subFolder of [false, true]) {
  test(`rename preserves submissions, downloads and counts (subFolder=${subFolder})`, async () => fixture(subFolder, async ({ home, app, admin, alice, bob, c, endpoint, userEndpoint, users, file, alpha, submitted }) => {
    const old = file('alice', 'alpha');
    if (subFolder) fs.writeFileSync(path.join(path.dirname(old), 'notes.txt'), 'keep this file');
    await admin('PUT', endpoint, { problems: [{ name: 'renamed', previousName: 'alpha', title: '新名称' }, { name: 'beta', previousName: 'beta', title: '乙' }] });
    assert.equal(fs.existsSync(old), false);
    assert.equal(fs.readFileSync(file('alice', 'renamed'), 'utf8'), alpha);
    assert.equal(fs.readFileSync(file('bob', 'renamed'), 'utf8'), '// bob\n');
    if (subFolder) {
      assert.equal(fs.existsSync(path.dirname(old)), false);
      assert.equal(fs.readFileSync(path.join(path.dirname(file('alice', 'renamed')), 'notes.txt'), 'utf8'), 'keep this file');
    }
    const mine = await alice('GET', userEndpoint + '/source/renamed');
    assert.deepEqual(mine, { ...submitted, code: alpha });
    assert.equal((await bob('GET', userEndpoint + '/source/renamed')).count, 1);
    await alice('GET', userEndpoint + '/source/alpha', undefined, 404);
    assert.equal((await admin('GET', `${endpoint}/source/${users.alice.id}/renamed`)).code, alpha);
    const board = await admin('GET', endpoint + '/board');
    assert.equal(board.rows.find(row => row.username === 'alice').cells.renamed.count, 2);
    const zip = await admin('GET', endpoint + '/archive.zip');
    assert.ok(zip.includes(Buffer.from(app.ctx.submissionRelPath(c, 'alice', 'renamed'))));
    assert.equal(zip.includes(Buffer.from('/alpha.cpp')), false);
    const saved = JSON.parse(fs.readFileSync(path.join(home, 'codehub.json'), 'utf8'));
    assert.deepEqual(saved.submissions[c.id][users.alice.id].renamed, submitted);
    assert.equal(saved.submissions[c.id][users.alice.id].alpha, undefined);
    assert.equal((await alice('POST', userEndpoint + '/submit', { problem: 'renamed', code: alpha })).submission.count, 3);
    // Reordering and display-only changes must not rename any files.
    await admin('PUT', endpoint, { problems: [{ name: 'beta', title: '显示名' }, { name: 'renamed', title: '其他显示名' }] });
    assert.equal(fs.readFileSync(file('alice', 'renamed'), 'utf8'), alpha);
  }));
}

test('swaps, case-only names, and simultaneous contest-folder renames', async () => fixture(true, async ({ admin, alice, c, endpoint, userEndpoint, file, alpha, beta }) => {
  await admin('PUT', endpoint, { name: 'renamed-contest', problems: [{ name: 'beta', previousName: 'alpha' }, { name: 'alpha', previousName: 'beta' }] });
  assert.equal(c.name, 'renamed-contest');
  assert.equal(fs.readFileSync(file('alice', 'beta'), 'utf8'), alpha);
  assert.equal(fs.readFileSync(file('alice', 'alpha'), 'utf8'), beta);
  assert.equal((await alice('GET', userEndpoint + '/source/beta')).count, 2);
  await admin('PUT', endpoint, { problems: [{ name: 'BETA', previousName: 'beta' }, { name: 'alpha' }] });
  assert.equal(fs.readFileSync(file('alice', 'BETA'), 'utf8'), alpha);
  assert.deepEqual(fs.readdirSync(path.dirname(path.dirname(file('alice', 'BETA')))).sort(), ['BETA', 'alpha']);
}));

test('one unambiguous rename remains compatible with older API clients', async () => fixture(false, async ({ admin, endpoint, file, alpha }) => {
  await admin('PUT', endpoint, { problems: [{ name: 'beta' }, { name: 'gamma' }] });
  assert.equal(fs.readFileSync(file('alice', 'gamma'), 'utf8'), alpha);
}));

test('destination conflicts and missing files reject the entire batch', async () => fixture(false, async ({ admin, app, c, endpoint, file, alpha }) => {
  const before = structuredClone(c);
  fs.writeFileSync(file('bob', 'renamed'), 'unrelated file');
  await admin('PUT', endpoint, { name: 'must-not-move', problems: [{ name: 'renamed', previousName: 'alpha' }, { name: 'beta' }] }, 409);
  assert.deepEqual(c, before);
  assert.equal(fs.readFileSync(file('alice', 'alpha'), 'utf8'), alpha);
  assert.equal(fs.readFileSync(file('bob', 'renamed'), 'utf8'), 'unrelated file');
  fs.unlinkSync(file('bob', 'renamed'));
  fs.unlinkSync(file('bob', 'alpha'));
  await admin('PUT', endpoint, { problems: [{ name: 'renamed', previousName: 'alpha' }, { name: 'beta' }] }, 409);
  assert.deepEqual(c, before);
  assert.equal(fs.readFileSync(file('alice', 'alpha'), 'utf8'), alpha);
  assert.equal(Object.keys(app.ctx.data.submissions[c.id]).length, 2);
}));

test('failed state-file persistence rolls back file moves and in-memory records', async () => fixture(false, async ({ home, admin, app, c, endpoint, file, alpha }) => {
  app.ctx.store.flush();
  const before = structuredClone(c), submissions = structuredClone(app.ctx.data.submissions[c.id]);
  const stateFile = path.join(home, 'codehub.json'), backup = path.join(home, 'state-backup.json');
  fs.renameSync(stateFile, backup); fs.mkdirSync(stateFile);
  try {
    await admin('PUT', endpoint, { name: 'not-saved', problems: [{ name: 'renamed', previousName: 'alpha' }, { name: 'beta' }] }, 500);
    assert.deepEqual(c, before);
    assert.deepEqual(app.ctx.data.submissions[c.id], submissions);
    assert.equal(fs.readFileSync(file('alice', 'alpha'), 'utf8'), alpha);
    assert.equal(fs.existsSync(file('alice', 'renamed')), false);
  } finally { fs.rmdirSync(stateFile); fs.renameSync(backup, stateFile); }
  await admin('PUT', endpoint, { problems: [{ name: 'renamed', previousName: 'alpha' }, { name: 'beta' }] });
  assert.equal(fs.readFileSync(file('alice', 'renamed'), 'utf8'), alpha);
}));

test('a mid-batch file error rolls back files already renamed', async t => fixture(false, async ({ admin, app, c, endpoint, file, alpha }) => {
  const before = structuredClone(c), submissions = structuredClone(app.ctx.data.submissions[c.id]);
  const rename = fs.renameSync.bind(fs);
  let injected = false;
  const mocked = t.mock.method(fs, 'renameSync', (from, to) => {
    if (!injected && to === file('bob', 'renamed')) {
      injected = true;
      throw Object.assign(new Error('Injected file-write failure'), { code: 'EACCES' });
    }
    return rename(from, to);
  });
  try {
    await admin('PUT', endpoint, { problems: [{ name: 'renamed', previousName: 'alpha' }, { name: 'beta' }] }, 500);
    assert.equal(injected, true);
    assert.deepEqual(c, before);
    assert.deepEqual(app.ctx.data.submissions[c.id], submissions);
    assert.equal(fs.readFileSync(file('alice', 'alpha'), 'utf8'), alpha);
    assert.equal(fs.readFileSync(file('bob', 'alpha'), 'utf8'), '// bob\n');
    assert.equal(fs.existsSync(file('alice', 'renamed')), false);
    assert.ok(fs.readdirSync(path.dirname(file('alice', 'alpha'))).every(name => !name.startsWith('.codehub-rename-')));
  } finally { mocked.mock.restore(); }
}));

test('invalid/stale origins and existing archived submissions cannot be overwritten', async () => fixture(false, async ({ admin, app, c, endpoint, file, users, alpha }) => {
  await admin('PUT', endpoint, { problems: [{ name: 'renamed', previousName: 'missing' }, { name: 'beta' }] }, 409);
  await admin('PUT', endpoint, { problems: [{ name: 'first', previousName: 'alpha' }, { name: 'second', previousName: 'alpha' }] }, 400);
  await admin('PUT', endpoint, { problems: [{ name: 'first' }, { name: 'second' }] }, 409);
  const records = app.ctx.data.submissions[c.id][users.alice.id];
  records.archived = { ...records.alpha, count: 7 };
  await admin('PUT', endpoint, { problems: [{ name: 'archived', previousName: 'alpha' }, { name: 'beta' }] }, 409);
  assert.equal(records.archived.count, 7);
  assert.equal(fs.readFileSync(file('alice', 'alpha'), 'utf8'), alpha);
}));

test('renames are deferred while uploads run, then re-upload under the new name', async () => fixture(false, async ({ admin, app, c, endpoint, file, users, alpha }) => {
  app.ctx.data.settings.lemon = { url: 'http://127.0.0.1:1', apiKey: 'test-fixture' };
  c.lemon = { contest: 'remote', interval: null };
  const uploads = [];
  let finishUpload;
  app.ctx.lemon.client.call = async (method, url, options) => {
    assert.equal(method, 'PUT');
    uploads.push({ path: options.query.path, code: options.raw.toString() });
    if (uploads.length === 1) await new Promise(resolve => { finishUpload = resolve; });
  };
  app.ctx.lemon.pendingOf(c)[users.alice.id + '|alpha'] = 1;
  const uploading = app.ctx.lemon.flushUploads(c);
  await new Promise(resolve => setImmediate(resolve));
  try {
    // Non-file edits remain available; they must not replace an in-flight queue's object.
    await admin('PUT', endpoint, { title: 'new display title' });
    await admin('PUT', endpoint, { problems: [{ name: 'renamed', previousName: 'alpha' }, { name: 'beta' }] }, 409);
    assert.equal(fs.readFileSync(file('alice', 'alpha'), 'utf8'), alpha);
  } finally { finishUpload(); await uploading; }
  assert.deepEqual(app.ctx.lemon.pendingOf(c), {}, 'a display-only edit must not restore a completed upload');
  app.ctx.lemon.state(c).finalDone = true;
  await admin('PUT', endpoint, { problems: [{ name: 'renamed', previousName: 'alpha' }, { name: 'beta' }] });
  await app.ctx.lemon.flushUploads(c);
  assert.ok(uploads.some(upload => upload.path === 'alice/renamed.cpp' && upload.code === alpha));
  assert.ok(uploads.some(upload => upload.path === 'bob/renamed.cpp'));
  assert.equal(app.ctx.lemon.state(c).finalDone, false);
  assert.deepEqual(app.ctx.lemon.pendingOf(c), {});
}));
