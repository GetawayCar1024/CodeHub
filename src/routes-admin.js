import fs from 'node:fs';
import path from 'node:path';

import { fail, readJson, receiveFile, sendBuffer, sendFile } from './http.js';
import { allowedFor, changePassword, contestPhase, paginate, sortContests } from './routes-user.js';
import { hashPassword, isValidName, isValidProblemName, sameName, toMs } from './util.js';
import { createZip } from './zip.js';
import { normalizeUrl } from './lemon.js';

const MAX_UPLOAD = 1024 * 1024 * 1024;
const collator = new Intl.Collator('zh-CN', { numeric: true });

export function setupAdminRoutes(router, ctx) {
  const { data } = ctx;

  const route = (method, p, handler) => router.add(method, p, (req, res, params) => {
    if (!req.user) fail(401, '请先登录');
    if (req.user.role !== 'admin') fail(403, '需要管理员权限');
    return handler(req, res, params);
  });

  const getContest = (id) => ctx.contest(id) || fail(404, '比赛不存在');
  const getUser = (id) => {
    const u = ctx.user(id);
    if (!u || u.role === 'admin') fail(404, '用户不存在');
    return u;
  };
  const lemonCall = async (...args) => {
    try { return await ctx.lemon.client.call(...args); } catch (e) { fail(e.status === 400 ? 400 : 502, e.message); }
  };
  const checkUrl = (v, message) => {
    const url = normalizeUrl(v);
    if (url && !/^https?:\/\/[^\s/]+(\/[^\s]*)?$/i.test(url)) fail(400, message);
    return url;
  };
  const hasSubmissions = (c) => Object.values(data.submissions[c.id] || {}).some((s) => Object.keys(s).length);
  const groupIds = (v) => {
    if (!Array.isArray(v)) fail(400, '分组格式错误');
    const ids = [...new Set(v.map(Number))];
    for (const id of ids) if (!data.groups.some((g) => g.id === id)) fail(400, '分组不存在');
    return ids;
  };

  // ------------------------------------------------------------------ account

  route('PUT', '/api/admin/password', (req) => changePassword(ctx, req));

  // ------------------------------------------------------------------ settings

  const settingsJson = () => {
    const s = data.settings;
    return {
      siteTitle: s.siteTitle,
      storageRoot: s.storageRoot,
      effectiveStorageRoot: ctx.storageRoot(),
      maxCodeKiB: s.maxCodeKiB,
      manual: s.manual,
      lemon: {
        url: s.lemon.url,
        publicUrl: s.lemon.publicUrl,
        apiKeySet: !!s.lemon.apiKey,
        apiKeyHint: s.lemon.apiKey ? s.lemon.apiKey.slice(0, 6) + '…' : '',
      },
    };
  };

  route('GET', '/api/admin/settings', () => settingsJson());

  route('PUT', '/api/admin/settings', async (req) => {
    const body = await readJson(req);
    const s = data.settings;
    if ('siteTitle' in body) {
      const t = String(body.siteTitle).trim();
      if (!t || t.length > 60) fail(400, '站点名称无效');
      s.siteTitle = t;
    }
    if ('maxCodeKiB' in body) {
      const n = Number(body.maxCodeKiB);
      if (!Number.isInteger(n) || n < 1 || n > 4096) fail(400, '代码长度上限应为 1–4096 KiB');
      s.maxCodeKiB = n;
    }
    if ('storageRoot' in body) {
      const root = String(body.storageRoot || '').trim();
      if (root && !path.isAbsolute(root)) fail(400, '请使用绝对路径');
      const oldRoot = ctx.storageRoot();
      const newRoot = root || path.join(ctx.dataDir, 'submissions');
      if (path.resolve(oldRoot) !== path.resolve(newRoot)) {
        try { fs.mkdirSync(newRoot, { recursive: true }); } catch { fail(400, '无法创建文件夹'); }
        // bring the existing submissions along
        for (const c of data.contests) {
          const from = path.join(oldRoot, c.name);
          const to = path.join(newRoot, c.name);
          if (!fs.existsSync(from) || fs.existsSync(to)) continue;
          try { fs.renameSync(from, to); } catch {
            fs.cpSync(from, to, { recursive: true });
            fs.rmSync(from, { recursive: true, force: true });
          }
        }
      }
      s.storageRoot = root;
    }
    if (body.lemon && typeof body.lemon === 'object') {
      const l = body.lemon;
      const before = s.lemon.url + '\n' + s.lemon.apiKey;
      if ('url' in l) s.lemon.url = checkUrl(l.url, 'LemonServer 地址无效');
      if ('publicUrl' in l) s.lemon.publicUrl = checkUrl(l.publicUrl, '网页地址无效');
      if ('apiKey' in l && l.apiKey !== null) s.lemon.apiKey = String(l.apiKey).trim();
      if (before !== s.lemon.url + '\n' + s.lemon.apiKey)
        for (const c of data.contests) if (c.lemon?.contest) ctx.lemon.relink(c);
    }
    ctx.store.save();
    return settingsJson();
  });

  route('PUT', '/api/admin/manual', async (req) => {
    const name = String(req.query.get('name') || 'manual.pdf').split(/[\\/]/).pop();
    const size = await receiveFile(req, ctx.manualFile(), MAX_UPLOAD);
    const mime = /\.pdf$/i.test(name) ? 'application/pdf' : 'application/octet-stream';
    data.settings.manual = { name, size, mime, uploadedAt: Date.now() };
    ctx.store.save();
    return settingsJson();
  });

  route('DELETE', '/api/admin/manual', () => {
    fs.rmSync(ctx.manualFile(), { force: true });
    data.settings.manual = null;
    ctx.store.save();
    return settingsJson();
  });

  // ------------------------------------------------------------------ LemonServer

  // Test the values in the form (not saved yet); an empty API key means the saved one.
  route('POST', '/api/admin/lemon/test', async (req) => {
    const body = await readJson(req);
    const saved = data.settings.lemon;
    const cfg = {
      url: 'url' in body ? checkUrl(body.url, 'LemonServer 地址无效') : saved.url,
      apiKey: String(body.apiKey || '').trim() || saved.apiKey,
    };
    const st = await lemonCall('GET', '/api/auth/status', { cfg });
    if (!st.authenticated) fail(400, 'API Key 无效');
    const list = await lemonCall('GET', '/api/contests', { cfg });
    // the judging queue (0.1.3) and no contest time hiding the results from the admin (0.1.6) are needed
    const [a = 0, b = 0, c = 0] = String(st.version || '').split('.').map(Number);
    const outdated = a * 1e6 + b * 1e3 + c < 1006;
    return { ok: true, version: st.version, outdated, contests: list.contests.length, setupRequired: st.setupRequired };
  });


  route('GET', '/api/admin/lemon/contests', async () => {
    const list = await lemonCall('GET', '/api/contests');
    return list.contests.map((x) => ({ name: x.name, title: x.title, tasks: x.tasks }));
  });

  route('POST', '/api/admin/lemon/contests', async (req) => {
    const body = await readJson(req);
    const name = String(body.name || '');
    if (!isValidName(name, 128)) fail(400, '比赛名无效');
    const r = await lemonCall('POST', '/api/contests', { json: { name, title: body.title || name } });
    return { name: r.name };
  });

  route('GET', '/api/admin/lemon/contests/:name', async (req, res, p) => {
    const r = await lemonCall('GET', ctx.lemon.client.contestPath(p.name));
    return {
      name: r.name,
      title: r.title,
      tasks: r.tasks.map((t) => ({ name: t.sourceFileName, title: t.problemTitle })),
      downZip: r.downZip || null,
    };
  });

  // Before linking a contest to another LemonServer contest: it must exist.
  const checkLemonLink = async (c, body) => {
    const name = String(body.lemon?.contest ?? '').trim();
    if (!('lemon' in body) || !name || name === (c?.lemon?.contest || '') || !ctx.lemon.client.configured()) return;
    await lemonCall('GET', ctx.lemon.client.contestPath(name));
  };

  // ------------------------------------------------------------------ groups

  const groupsJson = () => data.groups.map((g) => ({
    id: g.id, name: g.name, users: data.users.filter((u) => (u.groups || []).includes(g.id)).length,
  }));

  const validGroupName = (name, self) => {
    name = String(name || '').trim();
    if (!name || name.length > 40) fail(400, '分组名无效');
    if (data.groups.some((g) => g !== self && sameName(g.name, name))) fail(409, '分组已存在');
    return name;
  };

  route('GET', '/api/admin/groups', () => groupsJson());

  route('POST', '/api/admin/groups', async (req) => {
    const body = await readJson(req);
    const g = { id: ctx.newId('group'), name: validGroupName(body.name) };
    data.groups.push(g);
    ctx.store.save();
    return g;
  });

  route('PUT', '/api/admin/groups/:id', async (req, res, p) => {
    const g = data.groups.find((x) => x.id === Number(p.id)) || fail(404, '分组不存在');
    const body = await readJson(req);
    g.name = validGroupName(body.name, g);
    ctx.store.save();
    return g;
  });

  route('DELETE', '/api/admin/groups/:id', (req, res, p) => {
    const id = Number(p.id);
    if (!data.groups.some((g) => g.id === id)) fail(404, '分组不存在');
    data.groups = data.groups.filter((g) => g.id !== id);
    for (const u of data.users) u.groups = (u.groups || []).filter((x) => x !== id);
    for (const c of data.contests) c.groups = (c.groups || []).filter((x) => x !== id);
    ctx.store.save();
    return { ok: true };
  });

  // ------------------------------------------------------------------ users

  const userJson = (u) => ({ id: u.id, username: u.username, realName: u.realName, groups: u.groups || [], createdAt: u.createdAt });

  route('GET', '/api/admin/users', () =>
    data.users.filter((u) => u.role !== 'admin').sort((a, b) => collator.compare(a.username, b.username)).map(userJson));

  // Lines of "username,password[,real name[,group;group]]" (comma or tab separated).
  route('POST', '/api/admin/users/import', async (req) => {
    const body = await readJson(req, 16 << 20);
    const overwrite = body.mode === 'overwrite';
    const extraGroups = body.groups ? groupIds(body.groups) : [];
    const lines = String(body.text || '').replace(/^\uFEFF/, '').split(/\r?\n/);
    const errors = [];
    const rows = [];
    const seen = new Set();
    lines.forEach((line, i) => {
      if (!line.trim()) return;
      const cells = line.split(/\t|,|，/).map((x) => x.trim().replace(/^"(.*)"$/, '$1'));
      const [username, password, realName = '', groupText = ''] = cells;
      if (i === 0 && /^(用户名|账号|username)$/i.test(username)) return;
      const err = (m) => errors.push({ line: i + 1, message: m });
      if (!isValidName(username)) return err('用户名无效');
      if (!password) return err('密码为空');
      if (seen.has(username.toLowerCase())) return err('用户名重复');
      seen.add(username.toLowerCase());
      rows.push({ username, password, realName: realName || username, groups: groupText.split(/[;；|]/).map((x) => x.trim()).filter(Boolean) });
    });
    if (errors.length) return { added: 0, updated: 0, skipped: 0, errors };

    let added = 0, updated = 0, skipped = 0;
    for (const r of rows) {
      const gids = [...extraGroups];
      for (const name of r.groups) {
        let g = data.groups.find((x) => sameName(x.name, name));
        if (!g) {
          g = { id: ctx.newId('group'), name };
          data.groups.push(g);
        }
        if (!gids.includes(g.id)) gids.push(g.id);
      }
      const existing = data.users.find((u) => sameName(u.username, r.username));
      if (existing?.role === 'admin') {
        errors.push({ line: 0, message: `${r.username}：与管理员账号冲突` });
        continue;
      }
      if (existing && !overwrite) {
        skipped++;
        continue;
      }
      const passwordHash = hashPassword(r.password);
      if (existing) {
        existing.passwordHash = passwordHash;
        existing.realName = r.realName;
        existing.groups = [...new Set([...(existing.groups || []), ...gids])];
        ctx.dropUserSessions(existing.id);
        updated++;
      } else {
        data.users.push({ id: ctx.newId('user'), username: r.username, realName: r.realName, role: 'user', groups: gids, passwordHash, createdAt: Date.now() });
        added++;
      }
    }
    ctx.store.save();
    ctx.log(`imported users: ${added} added, ${updated} updated, ${skipped} skipped`);
    return { added, updated, skipped, errors };
  });

  route('PUT', '/api/admin/users/:id', async (req, res, p) => {
    const u = getUser(p.id);
    const body = await readJson(req);
    if ('realName' in body) u.realName = String(body.realName || '').trim() || u.username;
    if ('groups' in body) u.groups = groupIds(body.groups);
    if ('password' in body) {
      const pw = String(body.password ?? '');
      if (!pw) fail(400, '密码为空');
      u.passwordHash = hashPassword(pw);
      ctx.dropUserSessions(u.id);
    }
    ctx.store.save();
    return userJson(u);
  });

  route('POST', '/api/admin/users/batch', async (req) => {
    const body = await readJson(req);
    const users = (body.ids || []).map(getUser);
    const gids = body.groups ? groupIds(body.groups) : [];
    for (const u of users) {
      if (body.action === 'addGroups') u.groups = [...new Set([...(u.groups || []), ...gids])];
      else if (body.action === 'removeGroups') u.groups = (u.groups || []).filter((g) => !gids.includes(g));
      else if (body.action === 'setGroups') u.groups = gids;
      else if (body.action === 'delete') {
        data.users = data.users.filter((x) => x !== u);
        ctx.dropUserSessions(u.id);
      } else fail(400, '未知操作');
    }
    ctx.store.save();
    return { ok: true, count: users.length };
  });

  route('GET', '/api/admin/users/export.csv', (req, res) => {
    const gname = (id) => data.groups.find((g) => g.id === id)?.name;
    const lines = ['用户名,真实姓名,分组'];
    for (const u of data.users) if (u.role !== 'admin')
      lines.push([u.username, u.realName, (u.groups || []).map(gname).filter(Boolean).join(';')].join(','));
    sendBuffer(res, Buffer.from('\uFEFF' + lines.join('\r\n'), 'utf8'), { name: 'users.csv', mime: 'text/csv; charset=utf-8' });
  });

  // ------------------------------------------------------------------ contests

  const contestJson = (c) => ({
    id: c.id,
    name: c.name,
    title: c.title,
    startTime: c.startTime,
    endTime: c.endTime,
    earlyMinutes: c.earlyMinutes,
    problems: c.problems,
    groups: c.groups,
    subFolder: !!c.subFolder,
    downZip: c.downZip,
    downZipPassword: c.downZipPassword || '',
    lemon: c.lemon,
    phase: contestPhase(c),
    hasSubmissions: hasSubmissions(c),
    lemonLink: c.lemon?.contest && ctx.lemon.client.configured() ? ctx.lemon.client.resultsLink(c.lemon.contest) : null,
  });

  const applyContest = (c, body, isNew) => {
    const next = { ...c };
    if (isNew || 'name' in body) {
      const name = String(body.name ?? '').trim();
      if (!isValidName(name)) fail(400, '比赛名无效（将作为文件夹名）');
      if (data.contests.some((x) => x.id !== c.id && sameName(x.name, name))) fail(409, '比赛名已存在');
      next.name = name;
    }
    if (isNew || 'title' in body) next.title = String(body.title ?? '').trim() || next.name;
    if (isNew || 'startTime' in body || 'endTime' in body) {
      const s = toMs(body.startTime ?? c.startTime);
      const e = toMs(body.endTime ?? c.endTime);
      if (!Number.isFinite(s) || !Number.isFinite(e)) fail(400, '请设置开始和结束时间');
      if (e <= s) fail(400, '结束时间须晚于开始时间');
      // once a contest has ended its time is fixed
      if (!isNew && contestPhase(c) === 'ended' && (s !== c.startTime || e !== c.endTime))
        fail(409, '比赛已结束，时间不能再修改');
      // a time that is set or changed cannot be in the past (the form has minute precision)
      const minute = Math.floor(Date.now() / 60000) * 60000;
      if ((isNew || s !== c.startTime) && s < minute) fail(400, '开始时间不能早于当前时间');
      if ((isNew || e !== c.endTime) && e < minute) fail(400, '结束时间不能早于当前时间');
      next.startTime = s;
      next.endTime = e;
    }
    if (isNew || 'earlyMinutes' in body) {
      const m = body.earlyMinutes === undefined || body.earlyMinutes === '' ? 30 : Number(body.earlyMinutes);
      if (!Number.isInteger(m) || m < 0 || m > 7 * 1440) fail(400, '提前进入时间无效');
      if (!isNew && contestPhase(c) === 'ended' && m !== c.earlyMinutes) fail(409, '比赛已结束，时间不能再修改');
      next.earlyMinutes = m;
    }
    if (isNew || 'problems' in body) {
      const list = Array.isArray(body.problems) ? body.problems : [];
      const seen = new Set();
      next.problems = list.map((x) => {
        const name = String(x.name ?? '').trim();
        if (!isValidProblemName(name)) fail(400, `题目名“${name}”无效（字母、数字、_、-）`);
        if (seen.has(name.toLowerCase())) fail(400, `题目名“${name}”重复`);
        seen.add(name.toLowerCase());
        return { name, title: String(x.title ?? '').trim() || name };
      });
      if (!next.problems.length) fail(400, '至少需要一道题目');
    }
    if (isNew || 'groups' in body) next.groups = groupIds(body.groups || []);
    if (isNew || 'subFolder' in body) {
      next.subFolder = !!body.subFolder;
      if (!isNew && next.subFolder !== !!c.subFolder && hasSubmissions(c)) fail(409, '已有提交，不能修改子文件夹设置');
    }
    if (isNew || 'downZipPassword' in body) next.downZipPassword = String(body.downZipPassword ?? '').slice(0, 200);
    if (isNew || 'lemon' in body) {
      const l = body.lemon || {};
      const lc = String(l.contest ?? '').trim();
      if (lc && !isValidName(lc, 128)) fail(400, 'LemonServer 比赛名无效');
      if (lc && !ctx.lemon.client.configured()) fail(400, '请先在设置中接入 LemonServer');
      let interval = l.interval === undefined || l.interval === null || l.interval === '' ? null : Number(l.interval);
      if (interval !== null && (!Number.isInteger(interval) || interval < 0 || interval > 1440)) fail(400, '评测周期应为 0–1440 分钟');
      next.lemon = { contest: lc, interval };
    }
    if (!isNew && next.name !== c.name) {
      const from = path.join(ctx.storageRoot(), c.name);
      const to = path.join(ctx.storageRoot(), next.name);
      if (fs.existsSync(from)) {
        if (fs.existsSync(to) && !sameName(c.name, next.name)) fail(409, '目标文件夹已存在');
        fs.renameSync(from, to);
      }
    }
    return next;
  };

  const afterChange = (c, old) => {
    if (!old || (old.lemon?.contest || '') !== (c.lemon?.contest || '')) {
      if (c.lemon?.contest) ctx.lemon.relink(c);
    } else if (c.lemon?.contest) {
      if (old.subFolder !== c.subFolder || JSON.stringify(old.problems) !== JSON.stringify(c.problems))
        ctx.lemon.rt(c).needTasks = true;
    }
    if (!old || old.endTime !== c.endTime) ctx.lemon.timesChanged(c);
  };

  // ?page=1&pageSize=20, ordered by sortContests()
  route('GET', '/api/admin/contests', (req) => {
    const { items, ...pageInfo } = paginate(req, sortContests(data.contests));
    const contests = items.map((c) => ({
      ...contestJson(c),
      submissions: Object.values(data.submissions[c.id] || {}).reduce((n, s) => n + Object.keys(s).length, 0),
    }));
    return { ...pageInfo, contests };
  });

  route('POST', '/api/admin/contests', async (req) => {
    const body = await readJson(req);
    const c = applyContest({ id: 0 }, body, true);
    await checkLemonLink(null, body);
    c.id = ctx.newId('contest');
    c.downZip = null;
    c.createdAt = Date.now();
    data.contests.push(c);
    ctx.store.save();
    afterChange(c, null);
    ctx.log('contest created:', c.name);
    return contestJson(c);
  });

  route('GET', '/api/admin/contests/:id', (req, res, p) => contestJson(getContest(p.id)));

  route('PUT', '/api/admin/contests/:id', async (req, res, p) => {
    const c = getContest(p.id);
    const body = await readJson(req);
    const old = structuredClone(c);
    await checkLemonLink(c, body);
    Object.assign(c, applyContest(c, body, false));
    ctx.store.save();
    afterChange(c, old);
    return contestJson(c);
  });

  route('DELETE', '/api/admin/contests/:id', (req, res, p) => {
    const c = getContest(p.id);
    data.contests = data.contests.filter((x) => x !== c);
    delete data.submissions[c.id];
    delete data.finished[c.id];
    delete data.lemonState[c.id];
    delete data.lemonPending[c.id];
    fs.rmSync(path.dirname(ctx.downZipFile(c)), { recursive: true, force: true });
    if (req.query.get('deleteFiles') === '1') fs.rmSync(ctx.contestDir(c), { recursive: true, force: true });
    ctx.store.save();
    ctx.log('contest deleted:', c.name);
    return { ok: true };
  });

  route('PUT', '/api/admin/contests/:id/downzip', async (req, res, p) => {
    const c = getContest(p.id);
    const name = String(req.query.get('name') || 'down.zip').split(/[\\/]/).pop() || 'down.zip';
    const size = await receiveFile(req, ctx.downZipFile(c), MAX_UPLOAD);
    c.downZip = { name, size, uploadedAt: Date.now() };
    ctx.store.save();
    return contestJson(c);
  });

  route('POST', '/api/admin/contests/:id/downzip/from-lemon', async (req, res, p) => {
    const c = getContest(p.id);
    const body = await readJson(req);
    const name = String(body.contest || c.lemon?.contest || '');
    if (!name) fail(400, '未关联 LemonServer 比赛');
    const zip = await lemonCall('GET', ctx.lemon.client.contestPath(name) + '/down-zip', { timeout: 300000 });
    fs.mkdirSync(path.dirname(ctx.downZipFile(c)), { recursive: true });
    fs.writeFileSync(ctx.downZipFile(c), zip);
    c.downZip = { name: 'down.zip', size: zip.length, uploadedAt: Date.now() };
    ctx.store.save();
    return contestJson(c);
  });

  route('GET', '/api/admin/contests/:id/downzip', (req, res, p) => {
    const c = getContest(p.id);
    if (!c.downZip) fail(404, '没有试题包');
    sendFile(res, ctx.downZipFile(c), { name: c.downZip.name, mime: 'application/zip' });
  });

  route('DELETE', '/api/admin/contests/:id/downzip', (req, res, p) => {
    const c = getContest(p.id);
    fs.rmSync(ctx.downZipFile(c), { force: true });
    c.downZip = null;
    ctx.store.save();
    return contestJson(c);
  });

  // Submissions overview: code size per cell; when linked, also whether it is judged and its result on
  // LemonServer (the same during the contest as afterwards).
  route('GET', '/api/admin/contests/:id/board', async (req, res, p) => {
    const c = getContest(p.id);
    const subs = data.submissions[c.id] || {};
    const lemon = await ctx.lemon.status(c);
    const remote = lemon.linked ? ctx.lemon.rt(c).remote : null;
    const remoteMap = new Map((remote?.contestants || []).map((x) => [x.name, x]));
    const taskIndex = new Map((remote?.tasks || []).map((t, i) => [t.sourceFileName, i]));
    const pending = lemon.linked ? ctx.lemon.pendingOf(c) : {};
    const users = data.users.filter((u) => u.role !== 'admin' && (allowedFor(c, u) || subs[u.id]));
    users.sort((a, b) => collator.compare(a.username, b.username));
    const rows = users.map((u) => {
      const ct = remoteMap.get(u.username);
      const cells = {};
      let total = null;
      for (const pr of c.problems) {
        const s = subs[u.id]?.[pr.name];
        const idx = taskIndex.get(pr.name);
        if (!s) continue;
        const t = remote && ct && idx !== undefined ? ct.tasks[idx] : null;
        const judged = !!t?.judged && t.score >= 0;
        if (judged) total = (total ?? 0) + t.score;
        cells[pr.name] = {
          ...s,
          synced: lemon.linked ? !pending[u.id + '|' + pr.name] : null,
          judged: remote ? !!t?.judged : null,
          score: judged ? t.score : null,
          compileState: judged ? t.compileState ?? 0 : null,
        };
      }
      return { id: u.id, username: u.username, realName: u.realName, cells, total, finishedAt: data.finished[c.id]?.[u.id] ?? null };
    });
    return {
      contest: contestJson(c),
      serverTime: Date.now(),
      rows,
      lemon,
      fullScores: Object.fromEntries((remote?.tasks || []).map((t) => [t.sourceFileName, t.totalScore])),
      missingTasks: remote ? c.problems.filter((pr) => !taskIndex.has(pr.name)).map((pr) => pr.name) : [],
    };
  });

  // Undo a contestant's early finish (e.g. a click by mistake): they can submit again.
  route('DELETE', '/api/admin/contests/:id/finished/:uid', (req, res, p) => {
    const c = getContest(p.id);
    const u = getUser(p.uid);
    if (data.finished[c.id]?.[u.id]) {
      delete data.finished[c.id][u.id];
      ctx.store.save();
      ctx.log('early finish undone:', c.name, u.username);
    }
    return { ok: true };
  });

  route('GET', '/api/admin/contests/:id/source/:uid/:problem', (req, res, p) => {
    const c = getContest(p.id);
    const u = getUser(p.uid);
    const s = data.submissions[c.id]?.[u.id]?.[p.problem] || fail(404, '尚未提交');
    const file = ctx.submissionFile(c, u.username, p.problem);
    if (!fs.existsSync(file)) fail(404, '文件不存在');
    return { ...s, code: fs.readFileSync(file, 'utf8') };
  });

  route('GET', '/api/admin/contests/:id/archive.zip', (req, res, p) => {
    const c = getContest(p.id);
    const entries = [];
    for (const [uid, probs] of Object.entries(data.submissions[c.id] || {})) {
      const u = ctx.user(uid);
      if (!u) continue;
      for (const [prob, s] of Object.entries(probs)) {
        const file = ctx.submissionFile(c, u.username, prob);
        if (fs.existsSync(file))
          entries.push({ name: `${c.name}/${ctx.submissionRelPath(c, u.username, prob)}`, data: fs.readFileSync(file), mtime: new Date(s.time) });
      }
    }
    sendBuffer(res, createZip(entries), { name: `${c.name}.zip`, mime: 'application/zip' });
  });

  route('POST', '/api/admin/contests/:id/lemon/judge', (req, res, p) => {
    const c = getContest(p.id);
    if (!ctx.lemon.linked(c)) fail(400, '未关联 LemonServer 比赛');
    if (ctx.lemon.rt(c).busy) fail(409, '上一次任务尚未完成');
    ctx.lemon.runTask(c, 'manual');
    return { ok: true };
  });

  route('POST', '/api/admin/contests/:id/lemon/resync', async (req, res, p) => {
    const c = getContest(p.id);
    if (!ctx.lemon.linked(c)) fail(400, '未关联 LemonServer 比赛');
    ctx.lemon.markAllPending(c);
    ctx.lemon.rt(c).needTasks = true;
    try {
      await ctx.lemon.ensureTasks(c);
    } catch (e) { fail(502, e.message); }
    const ok = await ctx.lemon.flushUploads(c);
    if (!ok) fail(502, '上传失败：' + (ctx.lemon.rt(c).uploadError || ''));
    return { ok: true };
  });
}
