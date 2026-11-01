import fs from 'node:fs';
import path from 'node:path';

export class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

export const fail = (status, message, extra) => { throw new HttpError(status, message, extra); };

export function sendJson(res, status, obj) {
  const data = Buffer.from(JSON.stringify(obj));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': data.length,
    'Cache-Control': 'no-store',
  });
  res.end(data);
}

export function sendFile(res, file, { name, mime = 'application/octet-stream', attachment = true } = {}) {
  let st;
  try { st = fs.statSync(file); } catch { return sendJson(res, 404, { error: '文件不存在' }); }
  if (!st.isFile()) return sendJson(res, 404, { error: '文件不存在' });
  const headers = { 'Content-Type': mime, 'Content-Length': st.size, 'Cache-Control': 'no-store' };
  if (name) headers['Content-Disposition'] = `${attachment ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(name)}`;
  res.writeHead(200, headers);
  fs.createReadStream(file).pipe(res);
}

export function sendBuffer(res, data, { name, mime = 'application/octet-stream' } = {}) {
  const headers = { 'Content-Type': mime, 'Content-Length': data.length, 'Cache-Control': 'no-store' };
  if (name) headers['Content-Disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(name)}`;
  res.writeHead(200, headers);
  res.end(data);
}

export function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new HttpError(413, '请求过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export async function readJson(req, limit = 1 << 20) {
  const body = await readBody(req, limit);
  if (!body.length) return {};
  try {
    const v = JSON.parse(body.toString('utf8'));
    if (v && typeof v === 'object') return v;
  } catch { /* fall through */ }
  throw new HttpError(400, '无效的 JSON');
}

// Stream the request body into `dest` (atomically), returns the size.
export function receiveFile(req, dest, limit) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const tmp = dest + '.upload-' + process.pid + '-' + Date.now();
    const out = fs.createWriteStream(tmp);
    let size = 0;
    let failed = false;
    const abort = (err) => {
      if (failed) return;
      failed = true;
      out.destroy();
      fs.rm(tmp, { force: true }, () => reject(err));
    };
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        abort(new HttpError(413, '文件过大'));
        req.destroy();
      }
    });
    req.on('error', abort);
    out.on('error', abort);
    out.on('finish', () => {
      if (failed) return;
      try {
        fs.renameSync(tmp, dest);
        resolve(size);
      } catch (e) { abort(e); }
    });
    req.pipe(out);
  });
}

export class Router {
  constructor() { this.routes = []; }

  add(method, pattern, handler) {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
    this.routes.push({ method, re, keys, handler });
  }

  get(p, h) { this.add('GET', p, h); }
  post(p, h) { this.add('POST', p, h); }
  put(p, h) { this.add('PUT', p, h); }
  delete(p, h) { this.add('DELETE', p, h); }

  match(method, pathname) {
    let pathMatched = false;
    for (const r of this.routes) {
      const m = r.re.exec(pathname);
      if (!m) continue;
      pathMatched = true;
      if (r.method !== method && !(r.method === 'GET' && method === 'HEAD')) continue;
      const params = {};
      r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
      return { handler: r.handler, params };
    }
    return pathMatched ? 'method' : null;
  }
}

export function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
