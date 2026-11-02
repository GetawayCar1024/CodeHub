import fs from 'node:fs';
import path from 'node:path';

import { fail, readJson, sendFile } from './http.js';
import { checkPassword, hashPassword } from './util.js';
import { VERSION } from './version.js';

const MIN = 60000;

export function contestPhase(c, now = Date.now()) {
  if (now < c.startTime - (c.earlyMinutes ?? 30) * MIN) return 'upcoming';
  if (now < c.startTime) return 'before';
  if (now < c.endTime) return 'running';
  return 'ended';
}

export function allowedFor(c, user) {
  if (!c.groups || !c.groups.length) return true;
  return (user.groups || []).some((g) => c.groups.includes(g));
}

// Running and future contests first (earliest start first), then ended ones (latest start first).
export function sortContests(list, now = Date.now()) {
  return list.slice().sort((a, b) => {
    const ea = now >= a.endTime, eb = now >= b.endTime;
    if (ea !== eb) return ea ? 1 : -1;
    return (ea ? b.startTime - a.startTime : a.startTime - b.startTime) || a.id - b.id;
  });
}

export function paginate(req, list) {
  const pageSize = Math.min(100, Math.max(1, Number.parseInt(req.query.get('pageSize'), 10) || 20));
  const total = list.length;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(pages, Math.max(1, Number.parseInt(req.query.get('page'), 10) || 1));
  return { total, page, pages, pageSize, items: list.slice((page - 1) * pageSize, page * pageSize) };
}

export function publicUser(u) {
  return { id: u.id, username: u.username, realName: u.realName, role: u.role, groups: u.groups || [] };
}

// {current, password}: the signed-in user's own password; other sessions of the user are signed out.
export async function changePassword(ctx, req) {
  const body = await readJson(req);
  if (!checkPassword(String(body.current ?? ''), req.user.passwordHash)) fail(403, '当前密码错误');
  const pw = String(body.password ?? '');
  if (pw.length < 6) fail(400, '新密码至少 6 位');
  req.user.passwordHash = req.user.role === 'admin' ? hashPassword(pw, 16384) : hashPassword(pw);
  delete req.user.defaultPassword;
  ctx.dropUserSessions(req.user.id, req.sid);
  ctx.log('password changed:', req.user.username);
  return { ok: true };
}

export function setupUserRoutes(router, ctx) {
  const { data } = ctx;

  const needUser = (req) => {
    if (!req.user) fail(401, '请先登录');
    if (req.user.role === 'admin') fail(403, '管理员不能参加比赛');
    return req.user;
  };

  // Contests a contestant can open right now: allowed group, from the early-entry time to the end.
  const openContest = (req, id) => {
    const user = needUser(req);
    const c = ctx.contest(id);
    if (!c || !allowedFor(c, user)) fail(404, '比赛不存在');
    const phase = contestPhase(c);
    if (phase === 'upcoming' || phase === 'ended') fail(404, phase === 'ended' ? '比赛已结束' : '比赛尚未开放');
    return { c, user, phase };
  };

  router.get('/api/status', (req) => ({
    version: VERSION,
    siteTitle: data.settings.siteTitle,
    manual: !!data.settings.manual,
    serverTime: Date.now(),
    user: req.user ? { ...publicUser(req.user), defaultPassword: !!req.user.defaultPassword } : null,
  }));

  router.post('/api/login', async (req, res) => {
    const body = await readJson(req);
    const username = String(body.username || '').trim();
    const user = data.users.find((u) => u.username.toLowerCase() === username.toLowerCase());
    if (!user || !checkPassword(String(body.password ?? ''), user.passwordHash)) {
      ctx.log('failed login', username, 'from', req.socket.remoteAddress);
      fail(401, '用户名或密码错误');
    }
    ctx.newSession(res, user);
    return { user: { ...publicUser(user), defaultPassword: !!user.defaultPassword } };
  });

  router.post('/api/logout', (req, res) => {
    ctx.dropSession(req, res);
    return { ok: true };
  });

  router.put('/api/password', (req) => {
    if (!req.user) fail(401, '请先登录');
    return changePassword(ctx, req);
  });

  router.get('/api/manual', (req, res) => {
    const m = data.settings.manual;
    if (!m) fail(404, '没有考生手册');
    sendFile(res, ctx.manualFile(), { name: m.name, mime: m.mime || 'application/octet-stream' });
  });

  router.get('/api/contests', (req) => {
    const user = needUser(req);
    const now = Date.now();
    const open = data.contests.filter((c) => {
      const phase = contestPhase(c, now);
      return allowedFor(c, user) && (phase === 'before' || phase === 'running');
    });
    const { items, ...pageInfo } = paginate(req, sortContests(open, now));
    const contests = items.map((c) => ({ id: c.id, title: c.title, startTime: c.startTime, endTime: c.endTime, phase: contestPhase(c, now), problems: c.problems.length }));
    return { serverTime: now, ...pageInfo, contests };
  });

  router.get('/api/contests/:id', (req, res, p) => {
    const { c, user, phase } = openContest(req, p.id);
    const subs = data.submissions[c.id]?.[user.id] || {};
    return {
      id: c.id,
      title: c.title,
      startTime: c.startTime,
      endTime: c.endTime,
      phase,
      serverTime: Date.now(),
      downZip: !!c.downZip,
      hasPassword: !!c.downZipPassword,
      password: phase === 'running' ? c.downZipPassword || '' : null,
      manual: !!data.settings.manual,
      maxCodeKiB: data.settings.maxCodeKiB,
      problems: c.problems.map((pr) => ({ name: pr.name, title: pr.title || pr.name, submission: subs[pr.name] || null })),
      user: { username: user.username, realName: user.realName, groups: (user.groups || []).map((g) => data.groups.find((x) => x.id === g)?.name).filter(Boolean) },
    };
  });

  router.get('/api/contests/:id/down.zip', (req, res, p) => {
    const { c } = openContest(req, p.id);
    if (!c.downZip) fail(404, '没有试题包');
    sendFile(res, ctx.downZipFile(c), { name: c.downZip.name || 'down.zip', mime: 'application/zip' });
  });

  router.post('/api/contests/:id/submit', async (req, res, p) => {
    const { c, user, phase } = openContest(req, p.id);
    const body = await readJson(req, data.settings.maxCodeKiB * 1024 * 2 + 4096);
    if (phase !== 'running') fail(403, phase === 'before' ? '比赛尚未开始' : '比赛已结束');
    const problem = c.problems.find((x) => x.name === body.problem);
    if (!problem) fail(404, '题目不存在');
    if (typeof body.code !== 'string' || !body.code.trim()) fail(400, '代码为空');
    const code = Buffer.from(body.code, 'utf8');
    if (code.length > data.settings.maxCodeKiB * 1024) fail(400, `代码超过 ${data.settings.maxCodeKiB} KiB`);
    const file = ctx.submissionFile(c, user.username, problem.name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file + '.tmp', code);
    fs.renameSync(file + '.tmp', file);
    const bucket = (data.submissions[c.id] ??= {});
    const mine = (bucket[user.id] ??= {});
    const prev = mine[problem.name];
    mine[problem.name] = { time: Date.now(), size: code.length, lang: 'C++', count: (prev?.count || 0) + 1 };
    ctx.store.save();
    ctx.lemon.onSubmit(c, user, problem.name);
    return { submission: mine[problem.name] };
  });

  router.get('/api/contests/:id/source/:problem', (req, res, p) => {
    const { c, user } = openContest(req, p.id);
    const sub = data.submissions[c.id]?.[user.id]?.[p.problem];
    if (!sub) fail(404, '尚未提交');
    const file = ctx.submissionFile(c, user.username, p.problem);
    if (!fs.existsSync(file)) fail(404, '文件不存在');
    return { ...sub, code: fs.readFileSync(file, 'utf8') };
  });
}
