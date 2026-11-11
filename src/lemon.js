import fs from 'node:fs';
import { lastEnd } from './contest-time.js';
import { joinedAt } from './participation.js';

export class LemonError extends Error {
  constructor(status, message, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// "127.0.0.1:8080", "http://host:8080/", "http://host:8080/api" -> "http://host:8080"
export function normalizeUrl(url) {
  let u = String(url || '').trim();
  if (u && !/^https?:\/\//i.test(u)) u = 'http://' + u;
  return u.replace(/\/+$/, '').replace(/\/api$/i, '').replace(/\/#.*$/, '').replace(/\/+$/, '');
}

export class LemonClient {
  constructor(ctx) { this.ctx = ctx; }

  get cfg() { return this.ctx.data.settings.lemon; }

  configured() { return !!(this.cfg.url && this.cfg.apiKey); }

  contestPath(name) { return '/api/contests/' + encodeURIComponent(name); }

  // Address used in links shown to the admin's browser.
  webUrl() { return normalizeUrl(this.cfg.publicUrl || this.cfg.url || ''); }

  resultsLink(name) { return this.webUrl() + '/#/contest/' + encodeURIComponent(name) + '/results'; }

  // `cfg` ({url, apiKey}) overrides the saved settings, e.g. to test values before saving them.
  async call(method, p, { json, raw, query, timeout = 20000, cfg = this.cfg } = {}) {
    if (!cfg.url || !cfg.apiKey) throw new LemonError(400, cfg.url ? '请填写 API Key' : '请填写 LemonServer 地址');
    let url = normalizeUrl(cfg.url) + p;
    if (query) url += '?' + new URLSearchParams(query).toString();
    const headers = { Authorization: 'Bearer ' + cfg.apiKey };
    let body;
    if (json !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(json);
    } else if (raw !== undefined) {
      headers['Content-Type'] = 'application/octet-stream';
      body = raw;
    }
    let res;
    try {
      res = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(timeout) });
    } catch (e) {
      throw new LemonError(0, '无法连接 LemonServer' + (e?.cause?.code ? `（${e.cause.code}）` : ''));
    }
    const ct = res.headers.get('content-type') || '';
    const data = ct.includes('json') ? await res.json().catch(() => null) : Buffer.from(await res.arrayBuffer());
    if (!res.ok) {
      const msg = res.status === 401 ? 'API Key 无效' : (data && data.error) || `HTTP ${res.status}`;
      throw new LemonError(res.status, msg, data);
    }
    return data;
  }
}

// Keeps CodeHub contests in step with their LemonServer contests: uploads submissions into
// source/ and starts "judge unjudged" runs on schedule (by CodeHub's contest time; LemonServer has none).
export class LemonLink {
  constructor(ctx) {
    this.ctx = ctx;
    this.client = new LemonClient(ctx);
    this.runtime = new Map();
  }

  start() {
    this.timer = setInterval(() => this.tick().catch((e) => this.ctx.log('lemon tick:', e.message)), 5000);
    this.timer.unref?.();
  }

  rt(c) {
    if (!this.runtime.has(c.id))
      this.runtime.set(c.id, { busy: false, pending: false, chain: Promise.resolve(), task: null, history: [] });
    return this.runtime.get(c.id);
  }

  state(c) {
    const all = this.ctx.data.lemonState;
    if (!all[c.id]) all[c.id] = { lastSlot: 0, slotBase: null, linkedAt: Date.now(), finalDone: false };
    return all[c.id];
  }

  // Periodic runs count from the contest start, or from the moment the contest was linked if later.
  periodBase(c) { return Math.max(c.startTime, this.state(c).linkedAt || 0); }

  linked(c) { return this.client.configured() && !!c.lemon?.contest; }

  cpath(c) { return this.client.contestPath(c.lemon.contest); }

  pendingOf(c) {
    const p = this.ctx.data.lemonPending;
    if (!p[c.id]) p[c.id] = {};
    return p[c.id];
  }

  hasPending(c) { return Object.keys(this.pendingOf(c)).length > 0; }

  // ---- submissions ----

  onJoin(c, user) {
    if (!this.linked(c)) return;
    this.pendingOf(c)[user.id + '|'] = Date.now() + Math.random();
    this.ctx.store.save();
    this.flushUploads(c);
  }

  onSubmit(c, user, problem) {
    if (!this.linked(c)) return;
    this.pendingOf(c)[user.id + '|' + problem] = Date.now() + Math.random();
    this.ctx.store.save();
    this.flushUploads(c).then(() => {
      if (c.lemon.interval === 0) {
        this.rt(c).pending = true;
        this.kick(c);
      }
    });
  }

  markAllPending(c) {
    const subs = this.ctx.data.submissions[c.id] || {};
    const pending = this.pendingOf(c);
    for (const user of this.ctx.data.users)
      if (user.role !== 'admin' && joinedAt(this.ctx.data, c, user.id)) pending[user.id + '|'] = Date.now() + Math.random();
    for (const [uid, probs] of Object.entries(subs))
      for (const p of Object.keys(probs)) pending[uid + '|' + p] = Date.now() + Math.random();
    this.ctx.store.save();
  }

  // Serialised per contest; resolves to true when nothing is left to upload.
  flushUploads(c) {
    const rt = this.rt(c);
    rt.uploads = (rt.uploads || 0) + 1;
    rt.chain = rt.chain.then(() => this.doFlush(c)).catch(() => false).finally(() => { rt.uploads--; });
    return rt.chain;
  }

  async doFlush(c) {
    if (!this.linked(c)) return false;
    const rt = this.rt(c);
    const pending = this.pendingOf(c);
    for (const key of Object.keys(pending)) {
      const version = pending[key]; // a newer submission arriving during the upload keeps it pending
      const [uid, problem] = key.split('|');
      const user = this.ctx.data.users.find((u) => String(u.id) === uid);
      if (!problem) {
        if (!user || !joinedAt(this.ctx.data, c, user.id)) { delete pending[key]; continue; }
        try {
          await this.client.call('POST', this.cpath(c) + '/files/mkdir', { json: { root: 'source', path: user.username } });
          if (pending[key] === version) delete pending[key];
          rt.uploadError = null;
        } catch (e) {
          rt.uploadError = e.message; rt.uploadErrorAt = Date.now(); this.ctx.store.save(); return false;
        }
        continue;
      }
      const sub = this.ctx.data.submissions[c.id]?.[uid]?.[problem];
      const file = user && sub ? this.ctx.submissionFile(c, user.username, problem) : null;
      if (!file || !fs.existsSync(file)) {
        delete pending[key];
        continue;
      }
      try {
        await this.client.call('PUT', this.cpath(c) + '/files/upload', {
          query: { root: 'source', path: this.ctx.submissionRelPath(c, user.username, problem) },
          raw: fs.readFileSync(file),
        });
        if (pending[key] === version) delete pending[key];
        rt.uploadError = null;
      } catch (e) {
        rt.uploadError = e.message;
        rt.uploadErrorAt = Date.now();
        this.ctx.store.save();
        return false;
      }
    }
    this.ctx.store.save();
    return true;
  }

  // ---- contest settings ----

  // Called when the link changes (or the problems / sub-folder setting change).
  relink(c) {
    const st = this.state(c);
    st.finalDone = false;
    st.linkedAt = Date.now();
    st.slotBase = null;
    const rt = this.rt(c);
    rt.remote = null;
    rt.needTasks = true;
    this.markAllPending(c);
  }

  // The contest ends later than before: the run after the contest is due again.
  timesChanged(c) {
    if (lastEnd(c, this.ctx.data.users) > Date.now()) this.state(c).finalDone = false;
  }

  async ensureTasks(c) {
    const rt = this.rt(c);
    rt.tasksUpdating = (rt.tasksUpdating || 0) + 1;
    try {
      const remote = await this.client.call('GET', this.cpath(c));
      this.cache(c, remote);
      for (let i = 0; i < remote.tasks.length; i++) {
        if (remote.tasks[i].subFolderCheck !== !!c.subFolder)
          await this.client.call('PUT', this.cpath(c) + '/tasks/' + i, { json: { subFolderCheck: !!c.subFolder } });
      }
      rt.needTasks = false;
    } finally { rt.tasksUpdating--; }
  }

  cache(c, remote) {
    const rt = this.rt(c);
    rt.remote = remote;
    rt.remoteAt = Date.now();
    rt.remoteError = null;
  }

  async remote(c, maxAge = 2500) {
    const rt = this.rt(c);
    if (rt.remote && Date.now() - rt.remoteAt < maxAge) return rt.remote;
    try {
      this.cache(c, await this.client.call('GET', this.cpath(c)));
    } catch (e) {
      rt.remoteError = e.message;
      return null;
    }
    return rt.remote;
  }

  async publicResultsLink(c) {
    if (!this.linked(c)) return null;
    const remote = await this.remote(c);
    return remote?.public === true ? this.client.resultsLink(c.lemon.contest) : null;
  }

  // ---- judging ----

  kick(c) {
    const rt = this.rt(c);
    if (rt.busy || !rt.pending) return;
    const now = Date.now();
    if (now < c.startTime || now >= lastEnd(c, this.ctx.data.users)) return;
    rt.pending = false;
    this.runTask(c, 'submit');
  }

  // mode "unjudged": the cells LemonServer reports as not judged (new or re-submitted code);
  // mode "all": every submission.
  async runTask(c, kind, mode = 'unjudged') {
    const rt = this.rt(c);
    if (rt.busy) return 'busy';
    rt.busy = true;
    const task = { kind, mode, startedAt: Date.now(), state: 'running' };
    rt.task = task;
    const finish = (state, message) => {
      task.state = state;
      task.message = message;
      task.endedAt = Date.now();
      rt.history.unshift(task);
      rt.history.length = Math.min(rt.history.length, 20);
      return state;
    };
    try {
      const nothing = mode === 'all' ? '没有代码' : '没有未评测的代码';
      if (!(await this.flushUploads(c))) return finish('error', '上传失败：' + (rt.uploadError || ''));
      if (rt.needTasks) {
        try { await this.ensureTasks(c); } catch (e) { if (!e.body?.busy) throw e; }
      }
      // LemonServer judges the jobs of all contests one after another. If this contest still has a job
      // there (ours, or one started on LemonServer), the previous run is not finished: skip this one.
      const mine = (j) => !!j && j.contest === c.lemon.contest;
      const q = await this.client.call('GET', '/api/judge-queue');
      if (mine(q.running) || (q.queue || []).some(mine)) return finish('skipped', '上一次评测尚未完成');
      let job;
      try {
        // "refresh": new contestant folders are picked up when the job starts
        job = (await this.client.call('POST', this.cpath(c) + '/judge', { json: { mode, refresh: true } })).job;
      } catch (e) {
        if (e.body?.nothingToJudge) return finish('done', nothing);
        throw e;
      }
      if (!job || job.skipped) return finish('done', nothing);
      task.job = job.id;
      let errors = 0;
      for (;;) {
        try {
          const now = await this.client.call('GET', '/api/judge-queue');
          errors = 0;
          if (now.running?.id === job.id) {
            task.state = 'judging';
            task.progress = `${now.running.tasksDone}/${now.running.tasksTotal}`;
          } else {
            const pos = (now.queue || []).findIndex((j) => j.id === job.id);
            if (pos < 0) break; // finished, or removed from the queue on LemonServer
            task.state = 'queued';
            task.position = pos + 1;
          }
        } catch (e) {
          if (++errors > 15) throw e;
        }
        await sleep(2000);
      }
      const s = await this.client.call('GET', '/api/judge/status', { query: { since: 1e15 } }).catch(() => null);
      if (s && s.job === job.id) {
        if (s.stopRequested) return finish('error', '已在 LemonServer 上停止');
        return finish('done', `已评测 ${s.tasksDone} 项`);
      }
      return finish('done', '已完成');
    } catch (e) {
      return finish('error', e.message);
    } finally {
      rt.busy = false;
      rt.remote = null;
      if (rt.pending) setTimeout(() => this.kick(c), 1000);
    }
  }

  async tick() {
    if (!this.client.configured()) return;
    const now = Date.now();
    for (const c of this.ctx.data.contests) {
      if (!this.linked(c)) continue;
      const st = this.state(c);
      const rt = this.rt(c);
      if (this.hasPending(c) && !rt.busy && now - (rt.uploadErrorAt || 0) > 10000) this.flushUploads(c);
      if (rt.needTasks && !rt.busy && now - (rt.tasksTriedAt || 0) > 15000) {
        rt.tasksTriedAt = now;
        this.ensureTasks(c).catch((e) => { rt.tasksError = e.message; });
      }

      const iv = c.lemon.interval;
      const latest = lastEnd(c, this.ctx.data.users);
      if (now >= c.startTime && now < latest) {
        if (iv > 0) {
          const base = this.periodBase(c);
          if (st.slotBase !== base || st.slotInterval !== iv) {
            st.slotBase = base;
            st.slotInterval = iv;
            st.lastSlot = 0;
          }
          const slot = now < base ? 0 : Math.floor((now - base) / (iv * 60000));
          if (slot > st.lastSlot) {
            st.lastSlot = slot;
            this.ctx.store.save();
            if (rt.busy) rt.lastSkipped = now; // the previous run is not finished yet: skip this one
            else this.runTask(c, 'periodic');
          }
        } else if (iv === 0) {
          this.kick(c);
        }
      } else if (now >= latest && !st.finalDone && !rt.busy && now - (rt.finalTriedAt || 0) > 10000) {
        // Preserve the judging policy; the contest ends with its last extended participant.
        rt.finalTriedAt = now;
        this.runTask(c, 'final').then(result => {
          if (result === 'done') {
            st.finalDone = true;
            this.ctx.store.save();
          }
        });
      }
    }
  }

  // ---- for the admin pages ----

  async status(c) {
    if (!this.linked(c)) return { linked: false, configured: this.client.configured() };
    const rt = this.rt(c);
    const st = this.state(c);
    const remote = await this.remote(c);
    return {
      linked: true,
      configured: true,
      contest: c.lemon.contest,
      link: this.client.resultsLink(c.lemon.contest),
      reachable: !!remote,
      error: remote ? null : rt.remoteError,
      judging: remote ? !!remote.judging : null,
      queuedJobs: remote ? remote.queuedJobs || 0 : 0,
      busy: rt.busy,
      task: rt.task,
      history: rt.history.slice(0, 5),
      pendingUploads: Object.keys(this.pendingOf(c)).length,
      uploadError: rt.uploadError || null,
      finalDone: !!st.finalDone,
    };
  }
}
