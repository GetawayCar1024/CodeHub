// Real HTTP regressions for staged contest materials. Date.now is fixed, not browser time.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createApp } from '../src/app.js';

const MINUTE = 60000;
const PASSWORD = 'release-test-secret';
const ZIP = Buffer.from('PK\x05\x06' + '\0'.repeat(18), 'binary');

async function fixture(t, run, { materials = true, schedule = {} } = {}) {
  let clock = Date.UTC(2030, 0, 1);
  t.mock.method(Date, 'now', () => clock);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codehub-release-'));
  const app = createApp({ dataDir: home, log() {} });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  const client = () => {
    let cookie = '';
    return async (method, endpoint, body, { status = 200, raw, headers = {} } = {}) => {
      const response = await fetch(origin + endpoint, {
        method, headers: { 'X-CodeHub': '1', Cookie: cookie, 'Content-Type': raw ? 'application/octet-stream' : 'application/json', ...headers },
        body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
      });
      if (response.headers.has('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
      const value = method === 'HEAD' ? null : response.headers.get('content-type')?.includes('json') ? await response.json() : Buffer.from(await response.arrayBuffer());
      assert.equal(response.status, status, `${method} ${endpoint}: ${JSON.stringify(value).slice(0, 300)}`);
      return { value, headers: response.headers };
    };
  };
  try {
    const admin = client(), student = client(), outsider = client(), anonymous = client();
    await admin('POST', '/api/login', { username: 'admin', password: '123456' });
    await admin('POST', '/api/admin/users/import', { text: 'student,student-password,Student,allowed\noutsider,outsider-password,Outsider,other' });
    await student('POST', '/api/login', { username: 'student', password: 'student-password' });
    await outsider('POST', '/api/login', { username: 'outsider', password: 'outsider-password' });
    const group = app.ctx.data.groups.find(item => item.name === 'allowed');
    const start = clock + 60 * MINUTE;
    const body = { name: 'staged-materials', startTime: start, endTime: start + 60 * MINUTE, earlyMinutes: 30,
      downZipReleaseMinutes: 20, passwordReleaseMinutes: 10, problems: [{ name: 'sum' }], groups: [group.id],
      downZipPassword: materials ? PASSWORD : '', ...schedule };
    const { value: created } = await admin('POST', '/api/admin/contests', body);
    const c = app.ctx.contest(created.id), adminPath = `/api/admin/contests/${c.id}`, publicPath = `/api/contests/${c.id}`;
    if (materials) await admin('PUT', adminPath + '/downzip?name=down.zip', undefined, { raw: ZIP });
    await run({ admin, student, outsider, anonymous, app, home, c, created, body, start, adminPath, publicPath, at: value => { clock = value; } });
  } finally {
    app.stop(); app.server.closeAllConnections();
    await new Promise(resolve => app.server.close(resolve));
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test('materials can be prepared early but are released only at their own server-side deadlines', async t => fixture(t, async ({ admin, student, start, adminPath, publicPath, at }) => {
  assert.deepEqual((await admin('GET', adminPath + '/downzip')).value, ZIP);
  assert.equal((await admin('GET', adminPath)).value.downZipPassword, PASSWORD);
  at(start - 30 * MINUTE - 1);
  await student('GET', publicPath, undefined, { status: 404 });
  await student('GET', publicPath + '/down.zip', undefined, { status: 404 });
  at(start - 30 * MINUTE);
  let response = await student('GET', publicPath);
  assert.deepEqual([response.value.downZipState, response.value.passwordState], ['pending', 'pending']);
  assert.deepEqual([response.value.downZip, response.value.hasDownZip, response.value.hasPassword, response.value.password], [false, true, true, null]);
  assert.equal(response.value.downZipReleaseAt, start - 20 * MINUTE);
  assert.equal(response.value.passwordReleaseAt, start - 10 * MINUTE);
  assert.equal(response.value.problemsReleaseAt, start - 10 * MINUTE);
  assert.equal(response.value.problemsReleased, false);
  assert.deepEqual(response.value.problems, []);
  assert.equal(JSON.stringify(response.value).includes(PASSWORD), false);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  await student('GET', publicPath + '/down.zip', undefined, { status: 403, headers: { Range: 'bytes=0-5', Date: new Date(start).toUTCString() } });
  await student('HEAD', publicPath + '/down.zip', undefined, { status: 403 });
  at(start - 20 * MINUTE - 1);
  await student('GET', publicPath + '/down.zip', undefined, { status: 403 });
  at(start - 20 * MINUTE);
  response = await student('GET', publicPath);
  assert.deepEqual([response.value.downZipState, response.value.passwordState, response.value.password], ['available', 'pending', null]);
  const download = await student('GET', publicPath + '/down.zip');
  assert.deepEqual(download.value, ZIP);
  assert.equal(download.headers.get('cache-control'), 'no-store');
  at(start - 10 * MINUTE - 1);
  assert.equal((await student('GET', publicPath)).value.password, null);
  at(start - 10 * MINUTE);
  response = await student('GET', publicPath);
  assert.deepEqual([response.value.passwordState, response.value.password, response.value.phase], ['available', PASSWORD, 'before']);
  assert.equal(response.value.problemsReleased, true);
  assert.equal(response.value.problems[0].name, 'sum');
  await student('POST', publicPath + '/submit', { problem: 'sum', code: 'int main(){}' }, { status: 403 });
  at(start);
  assert.equal((await student('GET', publicPath)).value.password, PASSWORD);
  await student('POST', publicPath + '/submit', { problem: 'sum', code: 'int main(){}' });
}));

test('missing materials remain unset, not pending or falsely published', async t => fixture(t, async ({ admin, student, start, adminPath, publicPath, at }) => {
  at(start - 25 * MINUTE);
  let value = (await student('GET', publicPath)).value;
  assert.deepEqual([value.downZipState, value.passwordState, value.password], ['unset', 'unset', null]);
  assert.deepEqual([value.hasDownZip, value.hasPassword, value.downZip], [false, false, false]);
  await student('GET', publicPath + '/down.zip', undefined, { status: 404 });
  at(start);
  value = (await student('GET', publicPath)).value;
  assert.deepEqual([value.downZipState, value.passwordState], ['unset', 'unset']);
  // Late preparation takes effect immediately once the configured time has passed.
  await admin('PUT', adminPath + '/downzip', undefined, { raw: ZIP });
  await admin('PUT', adminPath, { downZipPassword: PASSWORD });
  value = (await student('GET', publicPath)).value;
  assert.deepEqual([value.downZipState, value.passwordState, value.password], ['available', 'available', PASSWORD]);
  await admin('DELETE', adminPath + '/downzip');
  await admin('PUT', adminPath, { downZipPassword: '' });
  value = (await student('GET', publicPath)).value;
  assert.deepEqual([value.downZipState, value.passwordState], ['unset', 'unset']);
}, { materials: false }));

test('the whole schedule is validated atomically on creation and editing', async t => fixture(t, async ({ admin, app, c, body, adminPath }) => {
  const before = structuredClone(c);
  for (const patch of [
    { earlyMinutes: 19 }, { downZipReleaseMinutes: 31 }, { downZipReleaseMinutes: 9 }, { passwordReleaseMinutes: 21 },
    { downZipReleaseMinutes: -1 }, { passwordReleaseMinutes: -1 }, { downZipReleaseMinutes: 1.5 }, { passwordReleaseMinutes: 1.5 },
    { downZipReleaseMinutes: 10081 }, { passwordReleaseMinutes: 10081 }, { downZipReleaseMinutes: 'invalid' },
    { passwordReleaseMinutes: null }, { downZipReleaseMinutes: [] }, { passwordReleaseMinutes: false },
  ]) {
    await admin('PUT', adminPath, { title: 'must-not-change', ...patch }, { status: 400 });
    assert.deepEqual(c, before);
    await admin('POST', '/api/admin/contests', { ...body, name: 'invalid-schedule', ...patch }, { status: 400 });
    assert.equal(app.ctx.data.contests.length, 1);
  }
  const { value } = await admin('PUT', adminPath, { earlyMinutes: 20, downZipReleaseMinutes: 20, passwordReleaseMinutes: 20 });
  assert.deepEqual([value.earlyMinutes, value.downZipReleaseMinutes, value.passwordReleaseMinutes], [20, 20, 20]);
}));

test('zero minutes releases both materials exactly at the start', async t => fixture(t, async ({ student, start, publicPath, at }) => {
  at(start - 1);
  assert.deepEqual((({ downZipState, passwordState }) => [downZipState, passwordState])((await student('GET', publicPath)).value), ['pending', 'pending']);
  await student('GET', publicPath + '/down.zip', undefined, { status: 403 });
  at(start);
  const { value } = await student('GET', publicPath);
  assert.deepEqual([value.downZipState, value.passwordState, value.password], ['available', 'available', PASSWORD]);
  assert.deepEqual((await student('GET', publicPath + '/down.zip')).value, ZIP);
}, { schedule: { downZipReleaseMinutes: 0, passwordReleaseMinutes: 0 } }));

test('legacy contests keep their original early-download and start-time-password defaults', async t => fixture(t, async ({ admin, student, c, start, adminPath, publicPath, at }) => {
  delete c.downZipReleaseMinutes; delete c.passwordReleaseMinutes;
  const { value: settings } = await admin('GET', adminPath);
  assert.deepEqual([settings.downZipReleaseMinutes, settings.passwordReleaseMinutes], [30, 0]);
  at(start - 30 * MINUTE);
  const { value } = await student('GET', publicPath);
  assert.deepEqual([value.downZipState, value.passwordState], ['available', 'pending']);
  assert.deepEqual((await student('GET', publicPath + '/down.zip')).value, ZIP);
  at(start - 1); assert.equal((await student('GET', publicPath)).value.password, null);
  at(start); assert.equal((await student('GET', publicPath)).value.password, PASSWORD);
}));

test('schedule changes apply to the API and direct downloads, and survive persistence', async t => fixture(t, async ({ admin, student, app, home, c, start, adminPath, publicPath, at }) => {
  at(start - 15 * MINUTE);
  assert.deepEqual((await student('GET', publicPath + '/down.zip')).value, ZIP);
  await admin('PUT', adminPath, { downZipReleaseMinutes: 10, passwordReleaseMinutes: 5 });
  assert.deepEqual((({ downZipState, passwordState }) => [downZipState, passwordState])((await student('GET', publicPath)).value), ['pending', 'pending']);
  await student('GET', publicPath + '/down.zip', undefined, { status: 403 });
  const stored = JSON.parse(fs.readFileSync(path.join(home, 'codehub.json'), 'utf8')).contests.find(item => item.id === c.id);
  assert.deepEqual([stored.downZipReleaseMinutes, stored.passwordReleaseMinutes], [10, 5]);
  at(start + 60 * MINUTE);
  await admin('PUT', adminPath, { passwordReleaseMinutes: 0 }, { status: 409 });
  assert.equal(app.ctx.contest(c.id).passwordReleaseMinutes, 5);
}));

test('resource release does not bypass authentication or contest groups', async t => fixture(t, async ({ student, outsider, anonymous, c, start, publicPath, at }) => {
  at(start);
  assert.equal((await student('GET', publicPath)).value.password, PASSWORD);
  await anonymous('GET', publicPath, undefined, { status: 401 });
  await anonymous('GET', publicPath + '/down.zip', undefined, { status: 401 });
  await outsider('GET', publicPath, undefined, { status: 404 });
  await outsider('GET', publicPath + '/down.zip', undefined, { status: 404 });
  await student('GET', `/api/admin/contests/${c.id}`, undefined, { status: 403 });
  await student('GET', `/files/contest-${c.id}/down.zip`, undefined, { status: 404 });
}));

test('problem names follow the password schedule even without a password, including direct source access', async t => fixture(t, async ({ admin, student, app, c, start, adminPath, publicPath, at }) => {
  c.problems[0].title = '尚未公布的题目';
  const user = app.ctx.data.users.find(item => item.username === 'student');
  const code = '// previously submitted code\nint main(){}\n';
  app.ctx.data.submissions[c.id] = { [user.id]: { sum: { time: start - 3600000, count: 1, size: Buffer.byteLength(code), lang: 'C++' } } };
  const file = app.ctx.submissionFile(c, user.username, 'sum');
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, code);

  at(start - 10 * MINUTE - 1);
  let value = (await student('GET', publicPath)).value;
  assert.equal(value.hasPassword, false);
  assert.equal(value.passwordState, 'unset');
  assert.equal(value.problemsReleased, false);
  assert.equal(value.problemsReleaseAt, start - 10 * MINUTE);
  assert.deepEqual(value.problems, []);
  assert.equal(JSON.stringify(value).includes('尚未公布的题目'), false);
  assert.equal(JSON.stringify(value).includes('"sum"'), false);
  assert.equal((await student('GET', '/api/contests')).value.contests[0].problems, 1, 'the list may show the count but not names');
  await student('GET', publicPath + '/source/sum', undefined, { status: 403 });
  await student('GET', publicPath + '/source/guessed-name', undefined, { status: 403 });
  assert.equal((await admin('GET', adminPath)).value.problems[0].title, '尚未公布的题目');
  assert.equal((await admin('GET', `${adminPath}/source/${user.id}/sum`)).value.code, code);

  at(start - 10 * MINUTE);
  value = (await student('GET', publicPath)).value;
  assert.equal(value.password, null);
  assert.equal(value.passwordState, 'unset');
  assert.equal(value.problemsReleased, true);
  assert.deepEqual(value.problems.map(problem => [problem.name, problem.title]), [['sum', '尚未公布的题目']]);
  assert.equal((await student('GET', publicPath + '/source/sum')).value.code, code);

  await admin('PUT', adminPath, { passwordReleaseMinutes: 0 });
  value = (await student('GET', publicPath)).value;
  assert.equal(value.problemsReleased, false, 'changing the schedule must also change name visibility');
  assert.deepEqual(value.problems, []);
  await student('GET', publicPath + '/source/sum', undefined, { status: 403 });
  at(start);
  assert.equal((await student('GET', publicPath)).value.problemsReleased, true);
}, { materials: false }));
