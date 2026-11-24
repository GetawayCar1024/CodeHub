import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createApp } from '../src/app.js';
import { LemonError } from '../src/lemon.js';
import { parseFolderFormat, renderFolderName } from '../src/folder-names.js';

async function fixture(run) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codehub-folders-'));
  let app = createApp({ dataDir: home, log() {} });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const client = () => {
    let cookie = '';
    return async (method, endpoint, body, status = 200) => {
      const response = await fetch(`http://127.0.0.1:${app.server.address().port}` + endpoint, { method, headers: { 'X-CodeHub': '1', 'Content-Type': 'application/json', Cookie: cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
      if (response.headers.has('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
      const type = response.headers.get('content-type') || '';
      const value = type.includes('json') ? await response.json() : type.includes('zip') ? Buffer.from(await response.arrayBuffer()) : await response.text();
      assert.equal(response.status, status, `${method} ${endpoint}: ${JSON.stringify(value).slice(0, 300)}`);
      return value;
    };
  };
  const admin = client();
  try {
    await admin('POST', '/api/login', { username: 'admin', password: '123456' });
    await admin('POST', '/api/admin/users/import', { text: 'alice,test-pass,张伟,one\nbob,test-pass,张伟,one\ncarol,test-pass,Carol,one\ndave,test-pass,D/E:F,two' });
    const users = Object.fromEntries(app.ctx.data.users.map(user => [user.username, user]));
    const groups = Object.fromEntries(app.ctx.data.groups.map(group => [group.name, group.id]));
    const create = async (extra = {}) => app.ctx.contest((await admin('POST', '/api/admin/contests', { name: 'folders', startTime: Date.now() + 60000, endTime: Date.now() + 3660000, problems: [{ name: 'sum' }], ...extra })).id);
    const enter = (c, ...names) => names.forEach((name, i) => { (app.ctx.data.participants[c.id] ??= {})[users[name].id] = 1000 + i; });
    const submit = (c, name, code = '// ' + name) => {
      const file = app.ctx.submissionFile(c, name, 'sum');
      fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, code);
      ((app.ctx.data.submissions[c.id] ??= {})[users[name].id] ??= {}).sum = { time: Date.now(), size: code.length, count: 1, lang: 'C++' };
    };
    const reload = async () => {
      app.stop(); app.server.closeAllConnections(); await new Promise(resolve => app.server.close(resolve));
      app = createApp({ dataDir: home, log() {} });
      await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
      await admin('POST', '/api/login', { username: 'admin', password: '123456' });
      return app;
    };
    await run({ home, get app() { return app; }, admin, client, users, groups, create, enter, submit, reload });
  } finally { app.stop(); app.server.closeAllConnections(); await new Promise(resolve => app.server.close(resolve)); fs.rmSync(home, { recursive: true, force: true }); }
}

const zipNames = bytes => {
  const names = [];
  for (let offset = 0; offset + 46 <= bytes.length; offset++) if (bytes.readUInt32LE(offset) === 0x02014b50)
    names.push(bytes.subarray(offset + 46, offset + 46 + bytes.readUInt16LE(offset + 28)).toString('utf8'));
  return names.sort();
};

test('formats are validated and render portable folder names', () => {
  const name = (format, user = { username: 'u1', realName: '张三' }, number = 1) => renderFolderName(parseFolderFormat(format).parts, user, number);
  assert.equal(name('te{id:3}st'), 'te001st');
  assert.equal(name('te{id:3}st', undefined, 42), 'te042st');
  assert.equal(name('{id}', undefined, 1234), '1234');
  assert.equal(name('{name}-{username}'), '张三-u1');
  assert.equal(name('{name}', { username: 'u2', realName: 'A/B:C*?' }), 'A_B_C__');
  assert.equal(name('{name}', { username: 'u3', realName: 'CON' }), 'CON_');
  assert.equal(name('{name}', { username: 'u4', realName: '  ... ' }), 'u4');
  assert.equal(name('{name}', { username: 'u5', realName: '' }), 'u5');
  assert.equal([...name('{name}', { username: 'u6', realName: '长'.repeat(80) })].length, 64);
  for (const [format, message] of [['', /请填写/], ['team', /须包含/], ['{foo}', /不支持/], ['{name:3}', /不能指定位数/], ['{id:0}', /1–9/],
    ['{id:10}', /1–9/], ['a/b{id}', /不能包含/], ['{id', /成对/], ['x}{id}', /成对/], ['{name}.', /不能以点/], ['{id}'.repeat(20), /最多 64/]])
    assert.throws(() => parseFolderFormat(format), error => error.status === 400 && message.test(error.message), format);
});

test('new contests use real names, older contests keep account names, and equal names are told apart', async () => fixture(async ({ app, admin, create, enter, submit, reload, users }) => {
  const c = await create();
  assert.equal((await admin('GET', `/api/admin/contests/${c.id}`)).folderFormat, '{name}');
  enter(c, 'bob', 'alice', 'dave'); submit(c, 'alice'); submit(c, 'bob');
  const board = await admin('GET', `/api/admin/contests/${c.id}/board`);
  assert.deepEqual(Object.fromEntries(board.rows.filter(row => row.folder).map(row => [row.username, row.folder])), { bob: '张伟', alice: '张伟_2', dave: 'D_E_F' });
  assert.deepEqual(zipNames(await admin('GET', `/api/admin/contests/${c.id}/archive.zip`)),
    ['folders/D_E_F/', 'folders/张伟/', 'folders/张伟/sum.cpp', 'folders/张伟_2/', 'folders/张伟_2/sum.cpp'].sort());
  assert.equal(fs.readFileSync(app.ctx.submissionFile(c, 'alice', 'sum'), 'utf8'), '// alice', 'the local copy keeps account names');
  // a contest saved by an earlier release has no format: it keeps its account folders
  delete c.folderFormat; c.lemon = { contest: 'remote', interval: null }; app.ctx.lemon.state(c); app.ctx.store.flush();
  const upgraded = await reload();
  const legacy = upgraded.ctx.contest(c.id);
  assert.equal(legacy.folderFormat, '{username}');
  assert.deepEqual(upgraded.ctx.lemon.remoteFolders(legacy), { [users.bob.id]: 'bob', [users.alice.id]: 'alice', [users.dave.id]: 'dave' });
}));

test('numbers are given in the order of entry, kept, validated against everyone who may take part and exported as a mapping', async () => fixture(async ({ app, admin, client, create, enter, submit, reload, users, groups }) => {
  await admin('POST', '/api/admin/contests', { name: 'too-small', startTime: Date.now() + 60000, endTime: Date.now() + 3660000, problems: [{ name: 'sum' }], folderFormat: 'p{id:1}' });
  await admin('POST', '/api/admin/users/import', { text: Array.from({ length: 6 }, (_, i) => `extra${i},test-pass,,one`).join('\n') });
  const error = await admin('POST', '/api/admin/contests', { name: 'crowded', startTime: Date.now() + 60000, endTime: Date.now() + 3660000, problems: [{ name: 'sum' }], folderFormat: 'p{id:1}' }, 400);
  assert.match(error.error, /位数不足：最多 9 个编号，本场比赛可参赛 10 人/);
  const c = await create({ folderFormat: 'te{id:2}st', groups: [groups.one] });
  await admin('PUT', `/api/admin/contests/${c.id}`, { folderFormat: 'te{id:1}st', groups: [groups.one, groups.two] }, 400);
  const preview = await admin('POST', '/api/admin/folder-format/preview', { format: 'te{id:1}st', groups: [groups.one, groups.two], contest: c.id });
  assert.deepEqual(preview.examples, ['te1st', 'te2st', 'te3st']); assert.equal(preview.capacity, 9); assert.match(preview.error, /位数不足/);
  assert.match((await admin('POST', '/api/admin/folder-format/preview', { format: '{oops}' })).error, /不支持/);
  const carol = client();
  await carol('POST', '/api/login', { username: 'carol', password: 'test-pass' });
  c.startTime = Date.now() + 60000;
  await carol('POST', `/api/contests/${c.id}/join`, { confirm: true, strict: true });
  assert.deepEqual(c.folderNumbers, { [users.carol.id]: 1 }, 'the number is stored when the contestant enters');
  enter(c, 'bob'); app.ctx.data.participants[c.id][users.bob.id] = Date.now() + 1000; submit(c, 'bob');
  await admin('GET', `/api/admin/contests/${c.id}/board`);
  assert.deepEqual(c.folderNumbers, { [users.carol.id]: 1, [users.bob.id]: 2 });
  const upgraded = await reload(), again = upgraded.ctx.contest(c.id);
  assert.deepEqual(again.folderNumbers, { [users.carol.id]: 1, [users.bob.id]: 2 });
  // switching to names and back keeps the numbers
  await admin('PUT', `/api/admin/contests/${c.id}`, { folderFormat: '{username}' });
  await admin('PUT', `/api/admin/contests/${c.id}`, { folderFormat: 'te{id:2}st' });
  assert.deepEqual(zipNames(await admin('GET', `/api/admin/contests/${c.id}/archive.zip`)), ['folders/te01st/', 'folders/te02st/', 'folders/te02st/sum.cpp']);
  const csv = await admin('GET', `/api/admin/contests/${c.id}/folders.csv`);
  assert.deepEqual(csv.replace(/^\uFEFF/, '').split('\r\n'), ['文件夹,用户名,姓名,分组,编号', 'te01st,carol,Carol,one,1', 'te02st,bob,张伟,one,2']);
  // a contestant added to the group later than the format was checked: reported, never renumbered
  upgraded.ctx.data.participants[c.id] = Object.fromEntries(['carol', 'bob', 'alice', ...Array.from({ length: 6 }, (_, i) => 'extra' + i), 'dave']
    .map((name, i) => [upgraded.ctx.data.users.find(user => user.username === name).id, 2000 + i]));
  upgraded.ctx.data.users.find(user => user.username === 'dave').groups.push(groups.one);
  again.folderNumbers = { [users.carol.id]: 1, [users.bob.id]: 2 }; again.folderFormat = 'te{id:1}st';
  const board = await admin('GET', `/api/admin/contests/${c.id}/board`);
  assert.equal(board.rows.find(row => row.username === 'dave').folderError, '编号位数不足（最多 9 个编号）');
  assert.equal(board.rows.find(row => row.username === 'carol').folder, 'te1st');
  assert.match((await admin('GET', `/api/admin/contests/${c.id}/archive.zip`, undefined, 409)).error, /1 名选手无法生成文件夹名/);
}));

test('LemonServer folders are renamed: old ones removed first, code uploaded again and judged again', async () => fixture(async ({ app, admin, create, enter, submit, users }) => {
  app.ctx.data.settings.lemon = { url: 'http://lemon.invalid', publicUrl: '', apiKey: 'fixture-key' };
  const c = await create();
  enter(c, 'carol', 'dave'); submit(c, 'carol'); submit(c, 'dave');
  const calls = [];
  let busy = false, listed = new Set(['Carol']);
  app.ctx.lemon.client.call = async (method, endpoint, options = {}) => {
    const target = method === 'DELETE' ? decodeURIComponent(endpoint.split('/').pop()) : options.json?.path ?? options.query?.path;
    calls.push([method, endpoint.split('/').slice(4).join('/'), target]);
    if (method === 'DELETE' && busy) throw new LemonError(409, 'busy', { busy: true });
    if (method === 'DELETE' && !listed.has(target)) throw new LemonError(404, 'no such contestant');
    if (endpoint.endsWith('/refresh')) listed = new Set(['Carol', 'D_E_F']);
    return {};
  };
  await admin('PUT', `/api/admin/contests/${c.id}`, { lemon: { contest: 'remote', interval: null } });
  assert.equal(await app.ctx.lemon.flushUploads(c), true);
  assert.deepEqual(app.ctx.lemon.remoteFolders(c), { [users.carol.id]: 'Carol', [users.dave.id]: 'D_E_F' });
  assert.ok(calls.some(call => call[0] === 'PUT' && call[2] === 'Carol/sum.cpp'));
  app.ctx.lemon.state(c).finalDone = true;
  calls.length = 0; busy = true;
  await admin('PUT', `/api/admin/contests/${c.id}`, { folderFormat: 'te{id:3}st' });
  const waiting = await admin('GET', `/api/admin/contests/${c.id}/board`);
  assert.equal(waiting.lemon.finalDone, false, 'renamed folders are judged again after the contest');
  assert.deepEqual(waiting.rows.filter(row => row.joinedAt).map(row => [row.folder, row.cells.sum.synced]), [['te001st', false], ['te002st', false]]);
  assert.equal(await app.ctx.lemon.flushUploads(c), false, 'judging blocks the rename');
  assert.match(app.ctx.lemon.rt(c).uploadError, /评测结束后再修改文件夹名/);
  assert.ok(!calls.some(call => call[0] === 'PUT' || call[1] === 'files/mkdir'), 'nothing is uploaded under a new name before the old folder is gone');
  calls.length = 0; busy = false;
  assert.equal(await app.ctx.lemon.flushUploads(c), true);
  const deletes = calls.filter(call => call[0] === 'DELETE').map(call => call[2]);
  assert.deepEqual(deletes, ['Carol', 'D_E_F', 'D_E_F'], 'an unlisted folder is removed after a refresh');
  assert.ok(calls.findIndex(call => call[0] !== 'DELETE' && !call[1].endsWith('refresh')) > calls.findLastIndex(call => call[0] === 'DELETE'));
  assert.deepEqual(calls.filter(call => call[0] === 'PUT').map(call => call[2]).sort(), ['te001st/sum.cpp', 'te002st/sum.cpp']);
  assert.deepEqual(app.ctx.lemon.remoteFolders(c), { [users.carol.id]: 'te001st', [users.dave.id]: 'te002st' });
  assert.equal(app.ctx.lemon.state(c).finalDone, false, 'the run after the contest judges the renamed folders');
  assert.deepEqual(app.ctx.lemon.pendingOf(c), {});
}));
