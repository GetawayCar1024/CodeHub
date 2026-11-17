import fs from 'node:fs';
import path from 'node:path';
import { isValidName } from './util.js';

const reserved = new Set([...Object.getOwnPropertyNames(Object.prototype), 'prototype'].map(name => name.toLowerCase()));
export const contestNameValid = name => isValidName(name) && !reserved.has(name.toLowerCase());
export const contestStateKeys = ['submissions', 'participants', 'finished', 'lemonState', 'lemonPending'];

// Names are the canonical keys on disk and in URLs. Numeric aliases only keep old bookmarks working.
export function migrateContestNames(ctx) {
  const { data } = ctx;
  const previous = structuredClone(data), undo = [];
  const names = new Set();
  try {
    for (const contest of data.contests) {
      if (!contestNameValid(contest.name) || names.has(contest.name.toLowerCase())) throw Error('比赛名无效或重复，未迁移配置');
      names.add(contest.name.toLowerCase());
    }
    const remapped = Object.fromEntries(contestStateKeys.map(key => [key, Object.fromEntries(Object.entries(data[key] || {}).map(([id, value]) => {
      const contest = data.contests.find(c => String(c.id) === id || c.name === id);
      if (!contest) return [id, value];
      return [contest.name, value];
    }))]));
    for (const contest of data.contests) {
      const oldId = contest.id;
      if (typeof oldId === 'number') contest.legacyId = oldId;
      const after = path.join(ctx.filesDir, 'contests', contest.name);
      const candidate = path.join(ctx.filesDir, 'contest-' + (contest.legacyId ?? oldId));
      const before = fs.existsSync(candidate) && fs.statSync(candidate).isDirectory() ? candidate : null;
      if (before && path.resolve(before) !== path.resolve(after)) {
        if (fs.existsSync(after)) throw Error('比赛题包目录冲突，未覆盖：' + contest.name);
        fs.mkdirSync(path.dirname(after), { recursive: true });
        fs.renameSync(before, after); undo.push(() => fs.renameSync(after, before));
      }
      contest.id = contest.name;
    }
    Object.assign(data, remapped, { version: 2 });
    ctx.store.flush();
  } catch (error) {
    for (const key of Object.keys(data)) delete data[key];
    Object.assign(data, previous);
    for (const rollback of undo.reverse()) rollback();
    throw error;
  }
}
