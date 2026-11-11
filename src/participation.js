import fs from 'node:fs';
import path from 'node:path';
import { allowedFor, contestPhase } from './contest-time.js';

// Older releases recorded submissions/early finishes but had no explicit entry confirmation.
export function joinedAt(data, contest, uid) {
  if (data.participants[contest.id]?.[uid]) return data.participants[contest.id][uid];
  const times = Object.values(data.submissions[contest.id]?.[uid] || {}).map(sub => sub.time).filter(Number.isFinite);
  if (data.finished[contest.id]?.[uid]) times.push(data.finished[contest.id][uid]);
  return times.length ? Math.min(...times) : null;
}

export function historyBlocked(data, contest, user, now = Date.now()) {
  return contestPhase(contest, now, user.id) === 'ended' && data.contests.some(c =>
    c.strict !== false && allowedFor(c, user) && joinedAt(data, c, user.id) && !data.finished[c.id]?.[user.id]
    && ['before', 'running'].includes(contestPhase(c, now, user.id)));
}

export function joinContest(ctx, contest, user) {
  const previous = ctx.data.participants[contest.id], created = [];
  let time;
  try {
    for (const dir of [ctx.contestDir(contest), path.join(ctx.contestDir(contest), user.username)]) {
      if (fs.existsSync(dir)) {
        const info = fs.lstatSync(dir);
        if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Participant path is not a regular directory');
      } else {
        fs.mkdirSync(dir, { recursive: true }); created.push(dir);
      }
    }
    time = joinedAt(ctx.data, contest, user.id) || Date.now();
    ctx.data.participants[contest.id] = { ...previous, [user.id]: time };
    ctx.store.flush();
  } catch (error) {
    if (previous === undefined) delete ctx.data.participants[contest.id]; else ctx.data.participants[contest.id] = previous;
    for (const dir of created.reverse()) { try { fs.rmdirSync(dir); } catch { /* never remove unexpected content */ } }
    throw error;
  }
  ctx.lemon.onJoin(contest, user);
  return time;
}
