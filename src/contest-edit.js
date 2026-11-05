import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fail } from './http.js';

function problemRenames(contest, next, rows) {
  const renames = new Map(), used = new Set(), unknown = [];
  if (!rows) return renames;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i], name = next.problems[i].name;
    const explicit = Object.hasOwn(row, 'previousName');
    if (explicit && row.previousName === null) continue; // explicitly added, not renamed
    const old = explicit
      ? contest.problems.find(problem => problem.name === row.previousName)
      : contest.problems.find(problem => problem.name.toLowerCase() === name.toLowerCase());
    if (!old) {
      if (explicit) fail(409, '原题目已改变，请刷新后重试');
      unknown.push(name);
      continue;
    }
    if (used.has(old.name)) fail(400, '不能把同一道原题目改名多次');
    used.add(old.name);
    if (old.name !== name) renames.set(old.name, name);
  }
  // Older clients do not send previousName. Infer only one unambiguous replacement,
  // never match by row position (rows may also have been reordered).
  const removed = contest.problems.filter(problem => !used.has(problem.name));
  if (next.problems.length === contest.problems.length && removed.length === 1 && unknown.length === 1)
    renames.set(removed[0].name, unknown[0]);
  else if (unknown.length && removed.length && next.problems.length === contest.problems.length)
    fail(409, '同时修改多道题目文件名时须提供 previousName（原题目名），请刷新后重试');
  return renames;
}

function entry(file) {
  try { return fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function sameEntry(a, b) {
  return fs.realpathSync.native(a) === fs.realpathSync.native(b);
}

// Validated contest settings + their file moves are committed together. All destinations
// are checked first; staging every source allows swaps and case-only renames on Windows.
// On an ordinary I/O/save error the moves and in-memory records are rolled back.
export function commitContestEdit(ctx, contest, next, rows) {
  const renames = problemRenames(contest, next, rows);
  const folderChanged = contest.name !== next.name;
  const rt = ctx.lemon.rt(contest);
  if ((renames.size || folderChanged) && (rt.busy || rt.uploads))
    fail(409, '正在同步或评测，请完成后再修改文件名');

  const data = ctx.data, id = contest.id;
  const oldContest = { ...contest }, oldSubmissions = data.submissions[id];
  const oldPending = data.lemonPending[id], oldState = data.lemonState[id];
  const submissions = oldSubmissions && { ...oldSubmissions };
  const pending = oldPending && {};
  const moves = [];
  for (const [uid, problems] of Object.entries(oldSubmissions || {})) {
    for (const [from, to] of renames) {
      if (!Object.hasOwn(problems, from)) continue;
      if (Object.keys(problems).some(name => name.toLowerCase() === to.toLowerCase() && !renames.has(name)))
        fail(409, `目标题目“${to}”已有提交，未覆盖任何文件`);
      const user = ctx.user(uid);
      if (!user) fail(409, '提交对应的用户不存在，未修改文件');
      const file = ctx.submissionFile(contest, user.username, from);
      const target = ctx.submissionFile(contest, user.username, to);
      const fileEntry = entry(file);
      if (!fileEntry?.isFile() || fileEntry.isSymbolicLink())
        fail(409, `找不到可改名的提交：${user.username}/${from}.cpp`);
      const source = contest.subFolder ? path.dirname(file) : file;
      const destination = contest.subFolder ? path.dirname(target) : target;
      if (entry(path.dirname(source))?.isSymbolicLink() || entry(source)?.isSymbolicLink())
        fail(409, '提交目录包含链接，未修改文件');
      if (contest.subFolder) {
        const innerTarget = path.join(source, to + '.cpp');
        if (entry(innerTarget) && !sameEntry(innerTarget, file))
          fail(409, `目标文件已存在：${user.username}/${to}.cpp`);
      }
      moves.push({ source, destination, from, to, temporary: path.join(path.dirname(source), '.codehub-rename-' + randomUUID()) });
    }
    submissions[uid] = Object.fromEntries(Object.entries(problems).map(([name, value]) => [renames.get(name) || name, value]));
  }
  const sources = new Set(moves.map(move => fs.realpathSync.native(move.source)));
  for (const move of moves) {
    if (entry(move.destination) && !sources.has(fs.realpathSync.native(move.destination)))
      fail(409, `目标文件或目录已存在：${path.basename(move.destination)}，未覆盖任何文件`);
  }
  const fromFolder = ctx.contestDir(contest), toFolder = ctx.contestDir(next);
  if (folderChanged && entry(fromFolder)) {
    if (!entry(fromFolder).isDirectory() || entry(fromFolder).isSymbolicLink()) fail(409, '比赛目录不是普通文件夹');
    if (entry(toFolder) && !sameEntry(fromFolder, toFolder)) fail(409, '目标比赛文件夹已存在');
  }

  if (pending) {
    for (const [key, value] of Object.entries(oldPending)) {
      const [uid, name] = key.split('|');
      pending[uid + '|' + (renames.get(name) || name)] = value;
    }
  }
  const nextPending = pending || {};
  if (ctx.lemon.linked(next)) {
    for (const [uid, problems] of Object.entries(oldSubmissions || {}))
      for (const [from, to] of renames)
        if (Object.hasOwn(problems, from)) nextPending[uid + '|' + to] = Date.now() + Math.random();
  }

  const undo = [];
  const move = (from, to) => { fs.renameSync(from, to); undo.push(() => fs.renameSync(to, from)); };
  try {
    for (const item of moves) {
      move(item.source, item.temporary);
      if (contest.subFolder) move(path.join(item.temporary, item.from + '.cpp'), path.join(item.temporary, item.to + '.cpp'));
    }
    for (const item of moves) {
      if (entry(item.destination)) fail(409, '目标位置已出现文件，已取消改名');
      move(item.temporary, item.destination);
    }
    if (folderChanged && entry(fromFolder)) {
      const temporary = path.join(ctx.storageRoot(), '.codehub-rename-' + randomUUID());
      move(fromFolder, temporary);
      if (entry(toFolder)) fail(409, '目标比赛文件夹已存在');
      move(temporary, toFolder);
    }
    Object.assign(contest, next);
    if (submissions) data.submissions[id] = submissions;
    if (oldPending || (ctx.lemon.linked(contest) && renames.size)) data.lemonPending[id] = nextPending;
    if (ctx.lemon.linked(contest) && renames.size) data.lemonState[id] = { ...ctx.lemon.state(contest), finalDone: false };
    ctx.store.flush();
  } catch (error) {
    Object.assign(contest, oldContest);
    for (const [name, value] of [['submissions', oldSubmissions], ['lemonPending', oldPending], ['lemonState', oldState]]) {
      if (value === undefined) delete data[name][id]; else data[name][id] = value;
    }
    let rollbackFailed = false;
    for (const rollback of undo.reverse()) {
      try { rollback(); } catch (rollbackError) {
        ctx.log('contest rename rollback failed:', rollbackError.message);
        rollbackFailed = true;
      }
    }
    if (rollbackFailed) fail(500, '改名回滚失败，请保留 .codehub-rename-* 文件并检查服务器日志');
    throw error;
  }
  return renames;
}
