// End-to-end test of CodeHub, optionally together with a running LemonServer.
//
//   node tests/smoke.mjs                                   # CodeHub only
//   node tests/smoke.mjs http://127.0.0.1:18080 <root>     # + LemonServer (fresh config, token 123456, g++ needed)
//
// CodeHub itself is started in-process with a temporary data folder.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createApp } from '../src/app.js';

const LEMON = process.argv[2] || '';
const LEMON_ROOT = process.argv[3] || path.join(os.tmpdir(), 'codehub-lemon-contests');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codehub-test-'));
const app = createApp({ dataDir, log: () => {} });
await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
app.start();
const BASE = `http://127.0.0.1:${app.server.address().port}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const step = (s) => console.log('·', s);
// Times in the past cannot be set through the API: move a contest in time directly.
function setTimes(id, startTime, endTime) {
  const c = app.ctx.contest(id);
  Object.assign(c, { startTime, endTime });
  app.ctx.lemon.timesChanged(c);
}

function client() {
  let cookie = '';
  return async function call(method, p, body, { raw, expect = 200, header = true } = {}) {
    const headers = {};
    if (header) headers['X-CodeHub'] = '1';
    if (cookie) headers.Cookie = cookie;
    let payload;
    if (raw !== undefined) { payload = raw; headers['Content-Type'] = 'application/octet-stream'; }
    else if (body !== undefined) { payload = JSON.stringify(body); headers['Content-Type'] = 'application/json'; }
    const res = await fetch(BASE + p, { method, headers, body: payload });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const ct = res.headers.get('content-type') || '';
    const data = ct.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer());
    assert.equal(res.status, expect, `${method} ${p}: ${res.status} ${JSON.stringify(data).slice(0, 300)}`);
    return data;
  };
}

async function lemon(method, p, { json, raw, token, expect = 200, query } = {}) {
  let url = LEMON + p;
  if (query) url += '?' + new URLSearchParams(query);
  const headers = {};
  if (token) headers.Authorization = 'Bearer ' + token;
  let body;
  if (json !== undefined) { body = JSON.stringify(json); headers['Content-Type'] = 'application/json'; }
  if (raw !== undefined) { body = raw; headers['Content-Type'] = 'application/octet-stream'; }
  const res = await fetch(url, { method, headers, body });
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer());
  if (expect !== null) assert.equal(res.status, expect, `lemon ${method} ${p}: ${res.status} ${JSON.stringify(data).slice(0, 300)}`);
  return data;
}

async function waitFor(what, fn, timeout = 60000) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeout) throw new Error('timeout: ' + what);
    await sleep(500);
  }
}

try {
  const admin = client();
  const st = await admin('GET', '/api/status');
  assert.equal(st.version, '0.1.5');
  assert.equal(st.user, null);

  step('admin login, CSRF header');
  await admin('POST', '/api/login', { username: 'admin', password: 'wrong' }, { expect: 401 });
  const login = await admin('POST', '/api/login', { username: 'admin', password: '123456' });
  assert.equal(login.user.role, 'admin');
  assert.equal(login.user.defaultPassword, true);
  await admin('POST', '/api/admin/groups', { name: 'x' }, { header: false, expect: 403 });

  step('groups and user import');
  const g1 = await admin('POST', '/api/admin/groups', { name: '高一' });
  await admin('POST', '/api/admin/groups', { name: '高一' }, { expect: 409 });
  const bad = await admin('POST', '/api/admin/users/import', { text: 'a/b,1\nok,' });
  assert.equal(bad.errors.length, 2);
  const imp = await admin('POST', '/api/admin/users/import', {
    text: '用户名,密码,姓名\nSC-00001,123,张三,高一\nSC-00002,456\nSC-00003,789,王五,高二',
  });
  assert.deepEqual([imp.added, imp.updated, imp.skipped, imp.errors.length], [3, 0, 0, 0]);
  const again = await admin('POST', '/api/admin/users/import', { text: 'SC-00002,000,李四', mode: 'skip' });
  assert.equal(again.skipped, 1);
  let users = await admin('GET', '/api/admin/users');
  const byName = Object.fromEntries(users.map((u) => [u.username, u]));
  assert.equal(byName['SC-00002'].realName, 'SC-00002');
  assert.deepEqual(byName['SC-00001'].groups, [g1.id]);
  const groups = await admin('GET', '/api/admin/groups');
  const g2 = groups.find((g) => g.name === '高二');
  assert.ok(g2);
  await admin('POST', '/api/admin/users/batch', { ids: [byName['SC-00002'].id], action: 'addGroups', groups: [g1.id] });
  await admin('PUT', '/api/admin/users/' + byName['SC-00003'].id, { password: 'newpass' });
  assert.equal((await admin('POST', '/api/admin/users/import', { text: 'admin,1' })).errors.length, 1);

  const u1 = client(), u2 = client(), u3 = client();
  await u1('POST', '/api/login', { username: 'sc-00001', password: '123' });
  await u2('POST', '/api/login', { username: 'SC-00002', password: '456' });
  await u3('POST', '/api/login', { username: 'SC-00003', password: '789' }, { expect: 401 });
  await u3('POST', '/api/login', { username: 'SC-00003', password: 'newpass' });

  let lemonKey = null;
  let lemonContest = null;
  if (LEMON) {
    step('LemonServer: setup, compilers, contest with aplusb');
    const tok = (await lemon('POST', '/api/auth/login', { json: { token: '123456' } })).session;
    fs.mkdirSync(LEMON_ROOT, { recursive: true });
    await lemon('PUT', '/api/setup', { json: { contestRoot: LEMON_ROOT }, token: tok });
    if (!(await lemon('GET', '/api/compilers', { token: tok })).length)
      await lemon('PUT', '/api/compilers', { json: await lemon('GET', '/api/compilers/detect', { token: tok }), token: tok });
    lemonKey = (await lemon('POST', '/api/apikeys', { json: { name: 'codehub-test' }, token: tok })).key;
    lemonContest = 'CodeHubTest' + Date.now();
    const C = '/api/contests/' + lemonContest;
    await lemon('POST', '/api/contests', { json: { name: lemonContest }, token: lemonKey, expect: 201 });
    for (let i = 1; i <= 4; i++) {
      await lemon('PUT', C + '/files/upload', { query: { root: 'data', path: `aplusb/${i}.in` }, raw: `${i} ${i * 10}\n`, token: lemonKey });
      await lemon('PUT', C + '/files/upload', { query: { root: 'data', path: `aplusb/${i}.out` }, raw: `${i * 11}\n`, token: lemonKey });
    }
    await lemon('POST', C + '/add-tasks', { token: lemonKey });
    await lemon('PUT', C + '/down-zip', { raw: Buffer.from('PK\x05\x06' + '\0'.repeat(18), 'latin1'), token: lemonKey });

    // test connection with the values of the form, before saving
    assert.equal((await admin('POST', '/api/admin/lemon/test', {}, { expect: 400 })).error, '请填写 LemonServer 地址');
    await admin('POST', '/api/admin/lemon/test', { url: LEMON }, { expect: 400 });
    assert.equal((await admin('POST', '/api/admin/lemon/test', { url: LEMON, apiKey: 'wrong-key-123' }, { expect: 400 })).error, 'API Key 无效');
    await admin('POST', '/api/admin/lemon/test', { url: 'http://127.0.0.1:1', apiKey: lemonKey }, { expect: 502 });
    const t = await admin('POST', '/api/admin/lemon/test', { url: LEMON.replace('http://', '') + '/api/', apiKey: lemonKey });
    assert.ok(t.ok && !t.outdated, JSON.stringify(t));
    const saved = await admin('PUT', '/api/admin/settings', { lemon: { url: LEMON + '/', apiKey: lemonKey } });
    assert.equal(saved.lemon.url, LEMON);
    assert.ok((await admin('POST', '/api/admin/lemon/test', { url: LEMON })).ok); // saved key
    const lc = await admin('GET', '/api/admin/lemon/contests/' + lemonContest);
    assert.deepEqual(lc.tasks, [{ name: 'aplusb', title: 'aplusb' }]);
  }

  step('contests: visibility, early entry, groups');
  const now = Date.now();
  await admin('POST', '/api/admin/contests', { name: 'bad', startTime: now, endTime: now - 1, problems: [{ name: 'a' }] }, { expect: 400 });
  await admin('POST', '/api/admin/contests', { name: 'bad', startTime: now, endTime: now + 1000, problems: [{ name: 'a.b' }] }, { expect: 400 });
  const A = await admin('POST', '/api/admin/contests', {
    name: '测试赛', title: '测试考试', startTime: now + 10 * 60000, endTime: now + 70 * 60000,
    problems: [{ name: 'aplusb', title: 'A+B' }, { name: 'road' }], groups: [g1.id], downZipPassword: '456',
  });
  assert.equal(A.earlyMinutes, 30);
  const B = await admin('POST', '/api/admin/contests', { name: 'later', startTime: now + 60 * 60000, endTime: now + 120 * 60000, problems: [{ name: 'x' }] });
  await admin('PUT', `/api/admin/contests/${A.id}/downzip?name=down.zip`, undefined, { raw: Buffer.from('PK-test') });

  let list = await u1('GET', '/api/contests');
  assert.deepEqual(list.contests.map((c) => c.id), [A.id]);
  assert.equal(list.contests[0].phase, 'before');
  assert.equal((await u3('GET', '/api/contests')).contests.length, 0);
  await u3('GET', '/api/contests/' + A.id, undefined, { expect: 404 });
  await u1('GET', '/api/contests/' + B.id, undefined, { expect: 404 });
  let cd = await u1('GET', '/api/contests/' + A.id);
  assert.equal(cd.password, null);
  assert.equal((await u1('GET', `/api/contests/${A.id}/down.zip`)).toString(), 'PK-test');
  await u1('POST', `/api/contests/${A.id}/submit`, { problem: 'aplusb', code: 'int main(){}' }, { expect: 403 });
  assert.equal((await u1('POST', `/api/contests/${A.id}/finish`, undefined, { expect: 403 })).error, '比赛尚未开始');
  await admin('GET', '/api/contests', undefined, { expect: 403 });

  const AC = '#include <cstdio>\nint main(){freopen("aplusb.in","r",stdin);freopen("aplusb.out","w",stdout);long long a,b;scanf("%lld%lld",&a,&b);printf("%lld\\n",a+b);}\n';
  const WA = AC.replace('a+b', 'a+b+(a==2)');

  step('times cannot be set to the past');
  assert.equal((await admin('POST', '/api/admin/contests', { name: 'past', startTime: now - 2 * 3600000, endTime: now + 3600000, problems: [{ name: 'a' }] }, { expect: 400 })).error, '开始时间不能早于当前时间');
  assert.equal((await admin('PUT', '/api/admin/contests/' + A.id, { startTime: now - 2 * 3600000 }, { expect: 400 })).error, '开始时间不能早于当前时间');

  step('contest running: submit, resubmit, view source');
  setTimes(A.id, Date.now() - 10 * 60000, Date.now() + 120000); // as if it had started 10 minutes ago
  // a running contest keeps its (past) start time; the end can be moved, but not into the past
  await admin('PUT', '/api/admin/contests/' + A.id, { startTime: app.ctx.contest(A.id).startTime, endTime: Date.now() + 120000 });
  assert.equal((await admin('PUT', '/api/admin/contests/' + A.id, { endTime: Date.now() - 5 * 60000 }, { expect: 400 })).error, '结束时间不能早于当前时间');
  cd = await u1('GET', '/api/contests/' + A.id);
  assert.equal(cd.phase, 'running');
  assert.equal(cd.password, '456');
  await u1('POST', `/api/contests/${A.id}/submit`, { problem: 'nope', code: 'x' }, { expect: 404 });
  await u1('POST', `/api/contests/${A.id}/submit`, { problem: 'aplusb', code: '   ' }, { expect: 400 });
  await u1('POST', `/api/contests/${A.id}/submit`, { problem: 'aplusb', code: WA });
  const r1 = await u1('POST', `/api/contests/${A.id}/submit`, { problem: 'aplusb', code: AC });
  assert.equal(r1.submission.count, 2);
  assert.equal(r1.submission.size, Buffer.byteLength(AC));
  assert.equal((await u1('GET', `/api/contests/${A.id}/source/aplusb`)).code, AC);
  await u2('POST', `/api/contests/${A.id}/submit`, { problem: 'aplusb', code: WA });
  assert.equal(fs.readFileSync(path.join(dataDir, 'submissions', '测试赛', 'SC-00001', 'aplusb.cpp'), 'utf8'), AC);
  await admin('PUT', '/api/admin/contests/' + A.id, { subFolder: true }, { expect: 409 });
  // the admin sees the code during the contest as well
  assert.equal((await admin('GET', `/api/admin/contests/${A.id}/source/${byName['SC-00001'].id}/aplusb`)).code, AC);
  assert.equal((await admin('GET', `/api/admin/contests/${A.id}/archive.zip`)).readUInt32LE(0), 0x04034b50);

  step('contestants change their own password');
  const u1b = client();
  await u1b('POST', '/api/login', { username: 'SC-00001', password: '123' });
  await u1('PUT', '/api/password', { current: 'wrong', password: 'abcdef' }, { expect: 403 });
  await u1('PUT', '/api/password', { current: '123', password: 'abc' }, { expect: 400 });
  await u1('PUT', '/api/password', { current: '123', password: 'new-pass-1' });
  await u1('GET', '/api/contests/' + A.id); // this session stays signed in
  await u1b('GET', '/api/contests/' + A.id, undefined, { expect: 401 }); // the other one is signed out
  await client()('POST', '/api/login', { username: 'SC-00001', password: '123' }, { expect: 401 });
  await client()('POST', '/api/login', { username: 'SC-00001', password: 'new-pass-1' });
  await client()('PUT', '/api/password', { current: 'x', password: 'abcdef' }, { expect: 401 });

  let board = await admin('GET', `/api/admin/contests/${A.id}/board`);
  assert.equal(board.rows.length, 2); // users of 高一
  assert.equal(board.rows[0].cells.aplusb.size, Buffer.byteLength(AC));
  assert.equal(board.lemon.linked, false);

  step('finishing early: no more submissions, the contest page stays open; the admin sees it and can undo it');
  const fin = await u2('POST', `/api/contests/${A.id}/finish`);
  assert.ok(fin.finishedAt);
  assert.equal((await u2('POST', `/api/contests/${A.id}/finish`)).finishedAt, fin.finishedAt); // once
  assert.equal((await u2('POST', `/api/contests/${A.id}/submit`, { problem: 'aplusb', code: AC }, { expect: 403 })).error, '你已结束比赛，不能再提交');
  cd = await u2('GET', '/api/contests/' + A.id);
  assert.deepEqual([cd.phase, cd.finishedAt, cd.password], ['running', fin.finishedAt, '456']);
  assert.equal((await u2('GET', `/api/contests/${A.id}/source/aplusb`)).code, WA);
  assert.deepEqual((await u2('GET', '/api/contests')).contests.map((c) => c.id), [A.id]);
  assert.equal((await u1('GET', '/api/contests/' + A.id)).finishedAt, null); // only this contestant
  board = await admin('GET', `/api/admin/contests/${A.id}/board`);
  assert.deepEqual(board.rows.map((r) => [r.username, r.finishedAt]), [['SC-00001', null], ['SC-00002', fin.finishedAt]]);
  await admin('DELETE', `/api/admin/contests/${A.id}/finished/${byName['SC-00002'].id}`);
  assert.equal((await u2('GET', '/api/contests/' + A.id)).finishedAt, null);
  await u2('POST', `/api/contests/${A.id}/submit`, { problem: 'aplusb', code: WA }); // can submit again

  if (LEMON) {
    step('link to LemonServer afterwards (judge on every submission)');
    await admin('PUT', '/api/admin/contests/' + A.id, { problems: [{ name: 'aplusb', title: 'A+B' }], lemon: { contest: lemonContest, interval: 0 } });
    await admin('POST', `/api/admin/contests/${A.id}/downzip/from-lemon`, {});
    const C = '/api/contests/' + lemonContest;
    // LemonServer has no contest time: nothing is sent there
    await sleep(1500);
    const remote = await lemon('GET', C, { token: lemonKey });
    assert.ok(!('startTime' in remote) && !('running' in remote), JSON.stringify(remote).slice(0, 200));

    const judgedOf = (b, who) => b.rows.find((r) => r.username === who).cells.aplusb;
    // existing submissions are uploaded on linking; a new submission triggers a run
    await u2('POST', `/api/contests/${A.id}/submit`, { problem: 'aplusb', code: WA });
    board = await waitFor('first judge', async () => {
      const b = await admin('GET', `/api/admin/contests/${A.id}/board`);
      return !b.lemon.busy && judgedOf(b, 'SC-00001').judged && judgedOf(b, 'SC-00002').judged && b;
    });
    assert.equal(board.lemon.pendingUploads, 0);
    // the results during the contest, as afterwards
    assert.deepEqual([judgedOf(board, 'SC-00001').score, judgedOf(board, 'SC-00002').score], [100, 75]);
    assert.equal(board.rows.find((r) => r.username === 'SC-00001').total, 100);
    assert.equal(board.fullScores.aplusb, 100);

    step('resubmission is judged again, queued behind another contest');
    const O = '/api/contests/' + lemonContest + 'Other';
    await lemon('POST', '/api/contests', { json: { name: lemonContest + 'Other' }, token: lemonKey, expect: 201 });
    for (let i = 1; i <= 4; i++) {
      await lemon('PUT', O + '/files/upload', { query: { root: 'data', path: `aplusb/${i}.in` }, raw: '1 1\n', token: lemonKey });
      await lemon('PUT', O + '/files/upload', { query: { root: 'data', path: `aplusb/${i}.out` }, raw: '2\n', token: lemonKey });
    }
    await lemon('POST', O + '/add-tasks', { json: { tasks: [{ name: 'aplusb', timeLimit: 1000 }] }, token: lemonKey });
    for (let i = 0; i < 6; i++)
      await lemon('PUT', O + '/files/upload', { query: { root: 'source', path: `t${i}/aplusb.cpp` }, raw: 'int main(){volatile long long x=0;for(;;)x++;}', token: lemonKey });
    const other = await lemon('POST', O + '/judge', { json: { mode: 'all', refresh: true }, token: lemonKey, expect: 202 });
    assert.equal(other.job.position, 0);
    const runs = board.lemon.history.length;
    await u1('POST', `/api/contests/${A.id}/submit`, { problem: 'aplusb', code: WA });
    board = await waitFor('rejudged', async () => {
      const b = await admin('GET', `/api/admin/contests/${A.id}/board`);
      return b.lemon.history.length > runs && !b.lemon.busy && judgedOf(b, 'SC-00001').judged && b;
    });
    assert.equal(board.lemon.history[0].message, '已评测 1 项'); // only the re-submitted code
    assert.ok(board.lemon.history[0].job > other.job.id); // it was queued after the other contest
    const src = await lemon('GET', C + '/files', { query: { root: 'source', path: 'SC-00001' }, token: lemonKey });
    assert.ok(src.entries.some((e) => e.name === 'aplusb.cpp' && e.size === Buffer.byteLength(WA)));

    step('after the contest: one more run judging what is unjudged');
    await admin('PUT', '/api/admin/contests/' + A.id, { endTime: Date.now() + 6000 });
    board = await waitFor('final run', async () => {
      const b = await admin('GET', `/api/admin/contests/${A.id}/board`);
      return b.lemon.finalDone && b;
    }, 90000);
    assert.deepEqual([board.lemon.history[0].kind, board.lemon.history[0].mode], ['final', 'unjudged']);
    const res = await lemon('GET', C, { token: lemonKey });
    const scores = Object.fromEntries(res.contestants.map((x) => [x.name, x.totalScore]));
    assert.deepEqual(scores, { 'SC-00001': 75, 'SC-00002': 75 });
    const ended = app.ctx.contest(A.id);
    await admin('PUT', '/api/admin/contests/' + A.id, { endTime: ended.endTime + 60000 }, { expect: 409 });
    await admin('PUT', '/api/admin/contests/' + A.id, { startTime: ended.startTime, endTime: ended.endTime, title: '测试考试' });
  } else {
    await admin('PUT', '/api/admin/contests/' + A.id, { endTime: Date.now() + 500 });
    await sleep(700);
  }

  step('after the contest');
  assert.equal((await u1('GET', '/api/contests')).contests.length, 0);
  {
    const ended = app.ctx.contest(A.id);
    await admin('PUT', '/api/admin/contests/' + A.id, { endTime: ended.endTime + 60000 }, { expect: 409 });
    await admin('PUT', '/api/admin/contests/' + A.id, { startTime: ended.startTime - 60000 }, { expect: 409 });
    await admin('PUT', '/api/admin/contests/' + A.id, { earlyMinutes: 10 }, { expect: 409 });
    await admin('PUT', '/api/admin/contests/' + A.id, { earlyMinutes: ended.earlyMinutes });
    await admin('PUT', '/api/admin/contests/' + A.id, { startTime: ended.startTime, endTime: ended.endTime });
  }
  await u1('POST', `/api/contests/${A.id}/submit`, { problem: 'aplusb', code: AC }, { expect: 404 });
  const s = await admin('GET', `/api/admin/contests/${A.id}/source/${byName['SC-00001'].id}/aplusb`);
  assert.equal(s.code, LEMON ? WA : AC);
  const zip = await admin('GET', `/api/admin/contests/${A.id}/archive.zip`);
  assert.equal(zip.readUInt32LE(0), 0x04034b50);
  assert.ok(zip.includes(Buffer.from('测试赛/SC-00002/aplusb.cpp')));

  step('rename contest moves the folder, password change');
  await admin('PUT', '/api/admin/contests/' + A.id, { name: '测试赛2' });
  assert.ok(fs.existsSync(path.join(dataDir, 'submissions', '测试赛2', 'SC-00001', 'aplusb.cpp')));
  if (LEMON) {
    step('renamed files re-sync; post-contest judging still uses only unjudged code');
    const C = '/api/contests/' + lemonContest;
    const beforeRename = structuredClone(app.ctx.data.submissions[A.id]);
    // I/O names stay unchanged: filenames change, never contestants' source code.
    await lemon('PUT', C + '/tasks/0', { json: { sourceFileName: 'sum', problemTitle: '求和' }, token: lemonKey });
    await admin('PUT', '/api/admin/contests/' + A.id, { problems: [{ name: 'sum', previousName: 'aplusb', title: '求和' }] });
    app.ctx.lemon.rt(app.ctx.contest(A.id)).finalTriedAt = 0;
    for (const user of [byName['SC-00001'], byName['SC-00002']]) {
      assert.deepEqual(app.ctx.data.submissions[A.id][user.id].sum, beforeRename[user.id].aplusb);
      assert.equal(app.ctx.data.submissions[A.id][user.id].aplusb, undefined);
    }
    board = await waitFor('renamed files post-contest judge', async () => {
      const b = await admin('GET', `/api/admin/contests/${A.id}/board`);
      return b.lemon.finalDone && !b.lemon.busy && b.rows.every(r => r.cells.sum?.judged && r.cells.sum.synced) && b;
    });
    assert.deepEqual(board.rows.map(r => r.cells.sum.score), [75, 75]);
    assert.deepEqual([board.lemon.history[0].kind, board.lemon.history[0].mode], ['final', 'unjudged']);
    assert.equal((await admin('GET', `/api/admin/contests/${A.id}/source/${byName['SC-00001'].id}/sum`)).code, WA);
    assert.equal(fs.readFileSync(path.join(LEMON_ROOT, lemonContest, 'source', 'SC-00001', 'sum.cpp'), 'utf8'), WA);
  }
  await admin('PUT', '/api/admin/password', { current: '123456', password: '12' }, { expect: 400 });
  await admin('PUT', '/api/admin/password', { current: '123456', password: 'admin-pass' });
  assert.equal((await admin('GET', '/api/status')).user.defaultPassword, false);
  await admin('DELETE', '/api/admin/contests/' + B.id);

  step('contest lists: 20 per page; running / future by start ascending, then ended by start descending');
  const t = Date.now();
  for (let i = 0; i < 20; i++) { // future (some within the early-entry window, some running)
    const c = await admin('POST', '/api/admin/contests', { name: 'f' + i, startTime: t + 3600000, endTime: t + 100 * 3600000, problems: [{ name: 'a' }] });
    setTimes(c.id, t + (((i * 7) % 20) - 3) * 600000, t + 100 * 3600000);
  }
  for (let i = 0; i < 4; i++) { // ended
    const c = await admin('POST', '/api/admin/contests', { name: 'e' + i, startTime: t + 3600000, endTime: t + 7200000, problems: [{ name: 'a' }] });
    setTimes(c.id, t - (10 + i * 3) * 3600000, t - 3600000);
  }
  const p1 = await admin('GET', '/api/admin/contests');
  assert.deepEqual([p1.total, p1.page, p1.pages, p1.contests.length], [25, 1, 2, 20]);
  const p2 = await admin('GET', '/api/admin/contests?page=2');
  assert.equal(p2.contests.length, 5);
  const all = [...p1.contests, ...p2.contests];
  const live = all.filter((c) => c.phase !== 'ended');
  const done = all.filter((c) => c.phase === 'ended');
  assert.equal(live.length, 20);
  assert.deepEqual(all, [...live, ...done]);
  assert.deepEqual(live.map((c) => c.startTime), live.map((c) => c.startTime).sort((a, b) => a - b));
  assert.deepEqual(done.map((c) => c.startTime), done.map((c) => c.startTime).sort((a, b) => b - a));
  assert.equal((await admin('GET', '/api/admin/contests?page=99')).page, 2);
  // contestants only see what they can enter, in the same order, paginated as well
  const ul = await u3('GET', '/api/contests?pageSize=2');
  const enterable = live.filter((c) => c.startTime - 30 * 60000 <= t);
  assert.equal(ul.total, enterable.length);
  assert.deepEqual(ul.contests.map((c) => c.id), enterable.slice(0, 2).map((c) => c.id));
  assert.equal((await u3('GET', '/api/contests?pageSize=2&page=2')).contests[0].id, enterable[2].id);

  console.log('ALL OK');
} finally {
  app.stop();
  app.server.close();
  app.server.closeAllConnections();
  fs.rmSync(dataDir, { recursive: true, force: true });
}
