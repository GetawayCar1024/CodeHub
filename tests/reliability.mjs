import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Store } from '../src/store.js';
import { createApp } from '../src/app.js';
import { contestNameValid } from '../src/contest-identity.js';

test('named contest keys reject inherited object properties and keep ordinary names', () => {
  for (const name of ['__proto__', 'constructor', 'prototype', 'toString', 'valueOf', 'hasOwnProperty']) assert.equal(contestNameValid(name), false);
  for (const name of ['manual', 'contests', '中文 # 比赛']) assert.equal(contestNameValid(name), true);
});

test('durable saves keep a known-good backup and recover a zeroed primary without deleting evidence', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codehub-durable-')), file = path.join(root, 'codehub.json');
  try {
    const store = new Store(file, () => {}); store.load({ users: [], groups: [], contests: [], value: 0 });
    store.flush(); store.data.value = 1; store.flush(); store.data.value = 2; store.flush();
    assert.equal(JSON.parse(fs.readFileSync(file + '.bak')).value, 1);
    const original = fs.writeFileSync;
    t.mock.method(fs, 'writeFileSync', (target, text, ...rest) => {
      if (typeof target === 'number') { original(target, text.slice(0, 12)); throw Error('simulated power interruption'); }
      return original(target, text, ...rest);
    });
    store.data.value = 3; assert.throws(() => store.flush(), /interruption/); t.mock.restoreAll();
    assert.equal(JSON.parse(fs.readFileSync(file)).value, 2);
    fs.writeFileSync(file, Buffer.alloc(4096));
    const recovered = new Store(file, () => {}); assert.equal(recovered.load({}).value, 1);
    recovered.flush(); assert.equal(JSON.parse(fs.readFileSync(file)).value, 1);
    assert.ok(fs.readdirSync(root).some(name => name.startsWith('codehub.json.corrupt-')));
  } finally { t.mock.restoreAll(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('legacy numeric contest records and attachment folders migrate to names without changing files', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codehub-names-'));
  try {
    const name = '中文 # 比赛';
    fs.mkdirSync(path.join(root, 'files/contest-7'), { recursive: true }); fs.writeFileSync(path.join(root, 'files/contest-7/down.zip'), 'PK fixture');
    fs.writeFileSync(path.join(root, 'codehub.json'), JSON.stringify({ version: 1, contests: [{ id: 7, name, problems: [{ name: 'a' }], groups: [], startTime: 1, endTime: 2 }],
      submissions: { 7: { 2: { a: { time: 1, size: 3 } } } }, participants: { 7: { 2: 1 } } }));
    const app = createApp({ dataDir: root, log() {} });
    assert.equal(app.ctx.contest(7).id, name);
    assert.equal(app.ctx.contest(name).legacyId, 7);
    assert.equal(app.ctx.data.submissions[name][2].a.size, 3);
    assert.equal(app.ctx.data.submissions[7], undefined);
    assert.equal(fs.readFileSync(app.ctx.downZipFile(app.ctx.contest(name)), 'utf8'), 'PK fixture');
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'codehub.json'))).version, 2);
    app.stop();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
