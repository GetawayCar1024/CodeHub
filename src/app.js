import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { HttpError, Router, parseCookies, sendJson } from './http.js';
import { LemonError, LemonLink } from './lemon.js';
import { Store } from './store.js';
import { hashPassword, randomToken } from './util.js';
import { setupUserRoutes } from './routes-user.js';
import { setupAdminRoutes } from './routes-admin.js';

export { VERSION } from './version.js';
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PUBLIC = path.join(ROOT, 'public');
const SESSION_COOKIE = 'codehub_sid';
const SESSION_IDLE = 7 * 24 * 3600 * 1000;
export const DEFAULT_ADMIN_PASSWORD = '123456';

const DEFAULTS = {
  version: 1,
  settings: {
    siteTitle: 'CodeHub',
    storageRoot: '',
    maxCodeKiB: 256,
    manual: null,
    lemon: { url: '', publicUrl: '', apiKey: '' },
  },
  nextId: { user: 1, group: 1, contest: 1 },
  users: [],
  groups: [],
  contests: [],
  submissions: {},
  // contest id -> user id -> when the contestant finished the contest early
  finished: {},
  sessions: {},
  lemonState: {},
  lemonPending: {},
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
};

export function createApp({ dataDir, resetAdmin = false, log = console.log }) {
  const store = new Store(path.join(dataDir, 'codehub.json'));
  const data = store.load(DEFAULTS);

  const ctx = {
    data,
    store,
    dataDir,
    log: (...a) => log(new Date().toISOString().slice(0, 19).replace('T', ' '), ...a),
    filesDir: path.join(dataDir, 'files'),
    storageRoot() { return data.settings.storageRoot || path.join(dataDir, 'submissions'); },
    contestDir(c) { return path.join(ctx.storageRoot(), c.name); },
    // <contest>/<user>/<problem>.cpp, or <contest>/<user>/<problem>/<problem>.cpp with sub folders
    submissionRelPath(c, username, problem) {
      return c.subFolder ? `${username}/${problem}/${problem}.cpp` : `${username}/${problem}.cpp`;
    },
    submissionFile(c, username, problem) {
      return path.join(ctx.contestDir(c), ...ctx.submissionRelPath(c, username, problem).split('/'));
    },
    downZipFile(c) { return path.join(ctx.filesDir, 'contest-' + c.id, 'down.zip'); },
    manualFile() { return path.join(ctx.filesDir, 'manual'); },
    newId(kind) { return data.nextId[kind]++; },
    user(id) { return data.users.find((u) => u.id === Number(id)); },
    contest(id) { return data.contests.find((c) => c.id === Number(id)); },
  };

  let admin = data.users.find((u) => u.role === 'admin');
  if (!admin) {
    admin = { id: ctx.newId('user'), username: 'admin', realName: '管理员', role: 'admin', groups: [], createdAt: Date.now() };
    data.users.push(admin);
    resetAdmin = true;
  }
  if (resetAdmin) {
    admin.passwordHash = hashPassword(DEFAULT_ADMIN_PASSWORD, 16384);
    admin.defaultPassword = true;
    for (const [sid, s] of Object.entries(data.sessions)) if (s.uid === admin.id) delete data.sessions[sid];
    ctx.log('admin password set to the default');
  }
  store.flush();

  ctx.lemon = new LemonLink(ctx);

  ctx.newSession = (res, user) => {
    const sid = randomToken();
    data.sessions[sid] = { uid: user.id, created: Date.now(), seen: Date.now() };
    store.save();
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_IDLE / 1000}`);
  };
  ctx.dropSession = (req, res) => {
    const sid = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (sid) delete data.sessions[sid];
    store.save();
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
  };
  ctx.dropUserSessions = (uid, keep) => {
    for (const [sid, s] of Object.entries(data.sessions)) if (s.uid === uid && sid !== keep) delete data.sessions[sid];
    store.save();
  };

  const sessionUser = (req) => {
    const sid = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    const s = sid && data.sessions[sid];
    if (!s) return null;
    const now = Date.now();
    if (now - s.seen > SESSION_IDLE) {
      delete data.sessions[sid];
      store.save();
      return null;
    }
    if (now - s.seen > 60000) {
      s.seen = now;
      store.save();
    }
    req.sid = sid;
    return ctx.user(s.uid) || null;
  };

  const router = new Router();
  setupUserRoutes(router, ctx);
  setupAdminRoutes(router, ctx);

  const serveStatic = (req, res, pathname) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'method not allowed' });
    let rel = decodeURIComponent(pathname);
    if (rel === '/' || !path.extname(rel)) rel = '/index.html';
    const file = path.normalize(path.join(PUBLIC, rel));
    if (!file.startsWith(PUBLIC + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Not found');
    }
    const body = fs.readFileSync(file);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Content-Length': body.length,
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname;
    try {
      if (!pathname.startsWith('/api/')) return serveStatic(req, res, pathname);
      // JSON API: a custom header on writes keeps other sites from posting forms here
      if (req.method !== 'GET' && req.method !== 'HEAD' && req.headers['x-codehub'] !== '1')
        throw new HttpError(403, '缺少 X-CodeHub 请求头');
      const m = router.match(req.method, pathname);
      if (!m) throw new HttpError(404, '接口不存在');
      if (m === 'method') throw new HttpError(405, 'method not allowed');
      req.user = sessionUser(req);
      req.query = url.searchParams;
      const result = await m.handler(req, res, m.params);
      if (!res.headersSent && result !== undefined) sendJson(res, 200, result);
    } catch (err) {
      // an unhandled LemonServer error is a gateway error, not a bug of CodeHub
      const e = err instanceof LemonError ? new HttpError(err.status === 400 ? 400 : 502, err.message) : err;
      if (!(e instanceof HttpError)) ctx.log('error', req.method, pathname, e.stack || e);
      if (!res.headersSent) {
        const status = e instanceof HttpError ? e.status : 500;
        sendJson(res, status, { error: e instanceof HttpError ? e.message : '服务器内部错误', ...(e.extra || {}) });
      } else res.destroy();
    }
  });
  server.requestTimeout = 0;

  return { server, ctx, start: () => ctx.lemon.start(), stop: () => { clearInterval(ctx.lemon.timer); store.flush(); } };
}
