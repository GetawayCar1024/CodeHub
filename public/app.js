'use strict';

// ============================================================ helpers

const $app = document.getElementById('app');
const S = { status: null, offset: 0, timers: [] };

function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k === 'value') el.value = v;
      else if (k === 'checked' || k === 'disabled' || k === 'selected') el[k] = !!v;
      else if (k === 'html') el.innerHTML = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  const add = (c) => {
    if (c === null || c === undefined || c === false) return;
    if (Array.isArray(c)) c.forEach(add);
    else el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  };
  children.forEach(add);
  return el;
}

// Append to / replace the children of `el`, skipping null / false like h() does.
function append(el, ...children) {
  el.append(...h('div', null, ...children).childNodes);
  return el;
}
function put(el, ...children) {
  el.textContent = '';
  return append(el, ...children);
}

const enc = encodeURIComponent;
const now = () => Date.now() + S.offset;

async function api(method, url, body, opts = {}) {
  const headers = { 'X-CodeHub': '1' };
  let payload;
  if (opts.raw !== undefined) {
    payload = opts.raw;
    headers['Content-Type'] = 'application/octet-stream';
  } else if (body !== undefined) {
    payload = JSON.stringify(body);
    headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(url, { method, headers, body: payload, credentials: 'same-origin' });
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('json') ? await res.json() : await res.text();
  if (!res.ok) {
    const err = new Error((data && data.error) || `HTTP ${res.status}`);
    err.status = res.status;
    if (res.status === 401 && !opts.noRedirect) {
      S.status.user = null;
      go('#/login');
    }
    throw err;
  }
  if (data && typeof data === 'object' && typeof data.serverTime === 'number') S.offset = data.serverTime - Date.now();
  return data;
}

function toast(msg, error) {
  let box = document.querySelector('.toasts');
  if (!box) document.body.appendChild(box = h('div', { class: 'toasts' }));
  const t = h('div', { class: 'toast' + (error ? ' error' : '') }, msg);
  box.appendChild(t);
  setTimeout(() => t.remove(), error ? 4500 : 2500);
}
const fail = (e) => toast(e.message || String(e), true);

async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    try { await navigator.clipboard.writeText(text); return; } catch { /* HTTP/permissions: use selection-based copy. */ }
  }
  const active = document.activeElement;
  const selection = window.getSelection();
  const ranges = selection ? Array.from({ length: selection.rangeCount }, (_, i) => selection.getRangeAt(i).cloneRange()) : [];
  const input = h('textarea', { value: text, readonly: true, tabindex: -1, 'aria-hidden': 'true', 'data-clipboard-copy': '',
    style: { position: 'fixed', top: 0, left: 0, width: '1px', height: '1px', opacity: 0, fontSize: '16px' } });
  document.body.appendChild(input);
  let copied = false;
  try {
    input.focus({ preventScroll: true }); input.select();
    copied = typeof document.execCommand === 'function' && document.execCommand('copy');
  } catch {
    copied = false;
  } finally {
    input.remove();
    if (active?.isConnected) active.focus({ preventScroll: true });
    if (selection) {
      selection.removeAllRanges();
      for (const range of ranges) if (range.commonAncestorContainer.isConnected) selection.addRange(range);
    }
  }
  if (!copied) throw new Error('复制失败，请手动选中代码复制');
}

function modal(title, body, buttons = [], opts = {}) {
  const close = () => { ov.remove(); document.removeEventListener('keydown', onKey); opts.onClose && opts.onClose(); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  const foot = h('div', { class: 'modal-foot' },
    opts.left ? h('div', { class: 'left' }, opts.left) : null,
    buttons.map((b) => h('button', {
      class: b.primary ? 'primary' : b.danger ? 'danger' : '',
      onclick: async (e) => {
        if (!b.onClick) return close();
        const btn = e.currentTarget;
        btn.disabled = true;
        try { if ((await b.onClick()) !== false) close(); } catch (err) { fail(err); } finally { btn.disabled = false; }
      },
    }, b.label)));
  const ov = h('div', { class: 'overlay', onmousedown: (e) => { if (e.target === ov && !opts.sticky) close(); } },
    h('div', { class: 'modal' + (opts.wide ? ' wide' : '') },
      h('div', { class: 'modal-head' }, h('h3', null, title), h('button', { class: 'icon-btn', onclick: close, title: '关闭' }, '✕')),
      h('div', { class: 'modal-body' }, body),
      buttons.length ? foot : null));
  document.body.appendChild(ov);
  document.addEventListener('keydown', onKey);
  const first = ov.querySelector('input, textarea');
  if (first) setTimeout(() => first.focus(), 30);
  return { close, el: ov };
}

function confirmBox(title, text, label = '确定', danger = false) {
  return new Promise((resolve) => {
    let ok = false;
    modal(title, h('div', null, text), [
      { label: '取消' },
      { label, primary: !danger, danger, onClick: () => { ok = true; } },
    ], { onClose: () => resolve(ok) });
  });
}

function menuAt(anchor, items) {
  document.querySelectorAll('.menu').forEach((m) => m.remove());
  const m = h('div', { class: 'menu' }, items.map((it) =>
    it === 'sep' ? h('div', { class: 'sep' })
      : it.head ? h('div', { class: 'head' }, it.head)
        : h('div', { class: 'item' + (it.danger ? ' danger-text' : ''), onclick: () => { m.remove(); it.onClick(); } }, it.label)));
  anchor.parentElement.appendChild(m);
  setTimeout(() => document.addEventListener('click', function off(e) {
    if (!m.contains(e.target)) { m.remove(); document.removeEventListener('click', off); }
  }), 0);
}

const pad = (n) => String(n).padStart(2, '0');
function fmtTime(ms, withYear = true) {
  if (!ms && ms !== 0) return '—';
  const d = new Date(ms);
  const date = `${withYear ? d.getFullYear() + '-' : ''}${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return `${date} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
const fmtShort = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
// "2026-11-01 08:00 – 12:00", with the end date when it is another day
const fmtRange = (a, b) => {
  const x = fmtShort(a), y = fmtShort(b);
  return `${x} – ${x.slice(0, 10) === y.slice(0, 10) ? y.slice(11) : y}`;
};
function fmtDuration(ms) {
  ms = Math.max(0, ms);
  const s = Math.floor(ms / 1000);
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`;
}
function fmtSize(n) {
  if (n === null || n === undefined) return '—';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}
const toLocalInput = (ms) => {
  if (!ms) return '';
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const fromLocalInput = (s) => (s ? new Date(s).getTime() : null);
const utf8Size = (s) => new TextEncoder().encode(s).length;

// Periodic refresh of the current page; paused while the tab is in the background.
function every(ms, fn) {
  const t = setInterval(() => { if (!document.hidden) fn(); }, ms);
  S.timers.push(t);
  return t;
}
function clearTimers() {
  S.timers.forEach(clearInterval);
  S.timers = [];
}

function download(url) {
  const a = h('a', { href: url, download: '' });
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function pickFile(accept) {
  return new Promise((resolve) => {
    const input = h('input', { type: 'file', accept: accept || null, style: { display: 'none' } });
    input.addEventListener('change', () => { resolve(input.files[0] || null); input.remove(); });
    document.body.appendChild(input);
    input.click();
  });
}

function switchEl(checked, onchange, disabled) {
  const input = h('input', { type: 'checkbox', checked, disabled, onchange: () => onchange(input.checked) });
  return h('label', { class: 'switch' }, input, h('span'));
}

function segmented(options, value, onchange) {
  const box = h('div', { class: 'segmented' });
  const render = () => {
    put(box, ...options.map(([v, label]) =>
      h('button', { type: 'button', class: v === value ? 'on' : '', onclick: () => { value = v; render(); onchange(v); } }, label)));
  };
  render();
  return box;
}

const row = (label, ...value) => h('div', { class: 'row' }, h('div', { class: 'label' }, label), h('div', { class: 'value' }, ...value));

// ============================================================ theme

const THEMES = { light: '浅色', dark: '深色', auto: '跟随系统' };
const ICON = {
  light: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4.5"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
  dark: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z"/></svg>',
  auto: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="8.5"/><path d="M12 3.5v17a8.5 8.5 0 0 0 0-17z" fill="currentColor"/></svg>',
};
const themePref = () => localStorage.getItem('codehub-theme') || 'auto';
function applyTheme() {
  const t = themePref();
  const dark = t === 'dark' || (t === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
}
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);
function themeButton() {
  const btn = h('button', { class: 'icon-btn', title: '外观：' + THEMES[themePref()], html: ICON[themePref()] });
  btn.addEventListener('click', () => {
    const order = ['light', 'dark', 'auto'];
    const next = order[(order.indexOf(themePref()) + 1) % 3];
    localStorage.setItem('codehub-theme', next);
    applyTheme();
    btn.innerHTML = ICON[next];
    btn.title = '外观：' + THEMES[next];
    toast('外观：' + THEMES[next]);
  });
  return btn;
}

// ============================================================ shell & routing

const isAdmin = () => S.status?.user?.role === 'admin';

function topbar(active) {
  const u = S.status.user;
  const nav = isAdmin() ? h('nav', { class: 'nav' },
    [['contests', '比赛', '#/admin'], ['users', '用户', '#/admin/users'], ['settings', '设置', '#/admin/settings']]
      .map(([k, label, href]) => h('a', { href, class: k === active ? 'active' : '' }, label))) : null;
  const userBtn = u ? h('div', { class: 'user-menu' },
    h('button', { class: 'user-btn', onclick: (e) => menuAt(e.currentTarget, [
      { head: `${u.realName}（${u.username}）` },
      { label: '修改密码', onClick: passwordDialog },
      'sep',
      { label: '退出登录', danger: true, onClick: logout },
    ]) }, h('span', null, u.realName || u.username), h('span', { class: 'muted' }, '▾'))) : null;
  return h('header', { class: 'topbar' },
    h('div', { class: 'brand', onclick: () => go('#/') }, h('img', { src: 'favicon.svg', alt: '' }), S.status.siteTitle),
    nav, h('div', { class: 'spacer' }), themeButton(), userBtn);
}

// The signed-in user's own password (contestants and the admin).
function passwordDialog() {
  const cur = h('input', { type: 'password', class: 'full', autocomplete: 'current-password', placeholder: '当前密码' });
  const pw1 = h('input', { type: 'password', class: 'full', autocomplete: 'new-password', placeholder: '新密码，至少 6 位' });
  const pw2 = h('input', { type: 'password', class: 'full', autocomplete: 'new-password', placeholder: '再次输入新密码' });
  const dlg = modal('修改密码', h('form', { class: 'stack', onsubmit: (e) => { e.preventDefault(); dlg.el.querySelector('.modal-foot .primary').click(); } },
    cur, pw1, pw2, h('button', { type: 'submit', class: 'hidden' })), [
    { label: '取消' },
    { label: '修改', primary: true, onClick: async () => {
      if (!cur.value || !pw1.value) { toast('请填写密码', true); return false; }
      if (pw1.value !== pw2.value) { toast('两次输入的新密码不一致', true); return false; }
      await api('PUT', '/api/password', { current: cur.value, password: pw1.value });
      S.status.user.defaultPassword = false;
      toast('密码已修改');
      if (isAdmin() && location.hash.startsWith('#/admin')) route();
    } },
  ]);
}

function shell(active, ...content) {
  $app.classList.remove('login-page');
  clearTimers();
  document.querySelectorAll('.overlay').forEach((o) => o.remove());
  const banner = isAdmin() && S.status.user.defaultPassword
    ? h('div', { class: 'banner' }, '管理员密码仍是默认值。', h('a', { onclick: passwordDialog, style: { cursor: 'pointer' } }, '修改')) : null;
  const main = h('main', { class: 'page' }, banner, ...content);
  put($app, topbar(active), main, h('div', { class: 'footer' }, `CodeHub ${S.status.version}`));
  return main;
}

function go(hash) {
  if (hash === '#/login') rememberLoginReturn(location.hash);
  if (location.hash === hash) route(); else location.hash = hash;
}
function rememberLoginReturn(hash) {
  if (typeof hash === 'string' && hash.startsWith('#/') && !hash.startsWith('#/login') && hash.length <= 2048) sessionStorage.setItem('codehub.loginReturn', hash);
}
function loginReturn() {
  const hash = sessionStorage.getItem('codehub.loginReturn');
  sessionStorage.removeItem('codehub.loginReturn');
  return typeof hash === 'string' && hash.startsWith('#/') && !hash.startsWith('#/login') && hash.length <= 2048 ? hash : '#/';
}
window.addEventListener('hashchange', route);

async function logout() {
  try { await api('POST', '/api/logout'); } catch { /* ignore */ }
  S.status.user = null;
  go('#/login');
}

async function route() {
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
  const u = S.status.user;
  document.title = S.status.siteTitle;
  if (!u) return parts[0] === 'login' ? renderLogin() : go('#/login');
  if (parts[0] === 'login') return go(loginReturn());
  try {
    if (u.role === 'admin') {
      if (parts[0] !== 'admin') return go('#/admin');
      const [, a, b, c] = parts;
      if (!a) return await renderAdminContests();
      if (a === 'page') return await renderAdminContests(Math.max(1, Number.parseInt(b, 10) || 1));
      if (a === 'new') return await renderContestForm(null);
      if (a === 'c' && c === 'edit') return await renderContestForm(Number(b));
      if (a === 'c') return await renderBoard(Number(b));
      if (a === 'users') return await renderUsers();
      if (a === 'settings') return await renderSettings(b);
      return go('#/admin');
    }
    if (parts[0] === 'c') return await renderContest(Number(parts[1]));
    if (parts[0] === 'page') return await renderContestList(Math.max(1, Number.parseInt(parts[1], 10) || 1));
    return await renderContestList();
  } catch (e) {
    if (e.status !== 401) {
      shell(null, h('div', { class: 'card empty' }, e.message, h('div', { style: { marginTop: '12px' } }, h('a', { href: '#/' }, '返回'))));
    }
  }
}

// ============================================================ login

function renderLogin() {
  clearTimers();
  document.querySelectorAll('.overlay').forEach(overlay => overlay.remove());
  $app.classList.add('login-page');
  const user = h('input', { type: 'text', placeholder: '用户名', autocomplete: 'username' });
  const pass = h('input', { type: 'password', placeholder: '密码', autocomplete: 'current-password' });
  const read = h('input', { type: 'checkbox' });
  const btn = h('button', { class: 'primary', type: 'submit' }, '登录');
  const submit = async (e) => {
    e.preventDefault();
    if (!user.value.trim() || !pass.value) return toast('请输入用户名和密码', true);
    if (S.status.manual && !read.checked && user.value.trim().toLowerCase() !== 'admin') return toast('请先阅读考生手册', true);
    btn.disabled = true;
    try {
      const r = await api('POST', '/api/login', { username: user.value.trim(), password: pass.value }, { noRedirect: true });
      S.status.user = r.user;
      go(loginReturn());
    } catch (err) { fail(err); } finally { btn.disabled = false; }
  };
  put($app, 
    h('header', { class: 'topbar' }, h('div', { class: 'brand' }, h('img', { src: 'favicon.svg', alt: '' }), S.status.siteTitle), h('div', { class: 'spacer' }), themeButton()),
    h('div', { class: 'login-wrap' },
      h('form', { class: 'card login', onsubmit: submit },
        h('h2', null, S.status.siteTitle),
        h('div', { class: 'stack' }, user, pass,
          S.status.manual ? h('label', { class: 'check small' }, read, '我已下载并阅读', h('a', { href: '/api/manual', target: '_blank' }, '考生手册')) : null,
          btn))),
    h('div', { class: 'footer' }, `CodeHub ${S.status.version}`));
  user.focus();
}

// ============================================================ contestant

const PHASE = { upcoming: '未开放', before: '未开始', running: '进行中', ended: '已结束' };
const PHASE_BADGE = { upcoming: '', before: 'orange', running: 'green', ended: '' };
const phaseOf = (c) => {
  const t = now();
  if (t < c.startTime - (c.earlyMinutes ?? 30) * 60000) return 'upcoming';
  if (t < c.startTime) return 'before';
  if (t < c.endTime) return 'running';
  return 'ended';
};

async function renderContestList(page = 1) {
  const r = await api('GET', `/api/contests?page=${page}&pageSize=20`);
  if (r.page !== page && page !== 1) return go(r.page > 1 ? '#/page/' + r.page : '#/');
  const main = shell(null, h('div', { class: 'page-head' }, h('h2', null, '比赛'),
    r.total > r.pageSize ? h('span', { class: 'muted' }, `共 ${r.total} 场`) : null));
  main.classList.add('narrow');
  if (!r.contests.length) {
    main.appendChild(h('div', { class: 'card empty' }, '当前没有比赛'));
  } else {
    append(main, h('div', { class: 'group contest-list' }, r.contests.map((c) =>
      h('div', { class: 'row link', 'data-contest': c.id, 'aria-disabled': !!c.historyBlocked, onclick: () => c.historyBlocked ? toast('正在参加严格模式比赛，暂时不能查看历史比赛', true) : go('#/c/' + c.id) },
        h('div', { class: 'grow' },
          h('div', { class: 'name' }, c.title, h('span', { class: 'muted small', style: { marginLeft: '10px' } }, c.strict ? '严格模式' : '非严格模式')),
          h('div', { class: 'muted small' }, fmtRange(c.startTime, c.endTime))),
        h('span', { class: 'badge ' + PHASE_BADGE[c.phase] }, c.historyBlocked ? '暂不可查看' : PHASE[c.phase]),
        h('span', { class: 'chev' }, '›')))),
    pager(r.page, r.pages, (p) => (p > 1 ? '#/page/' + p : '#/')));
  }
  refreshWhenChanged(`/api/contests?page=${page}&pageSize=20`, r);
}

// Re-render the page when the list behind it changed.
function refreshWhenChanged(url, data, ms = 5000) {
  const hash = location.hash;
  const key = (d) => JSON.stringify({ ...d, serverTime: 0 });
  const before = key(data);
  every(ms, async () => {
    try {
      const fresh = await api('GET', url);
      if (location.hash === hash && key(fresh) !== before) route();
    } catch { /* keep the page as it is */ }
  });
}

function codeEditor(initial = '', readOnly = false) {
  const gutter = h('div', { class: 'gutter' });
  const area = readOnly ? h('pre') : h('textarea', { spellcheck: 'false', autocomplete: 'off', autocapitalize: 'off', wrap: 'off' });
  let lines = 0;
  const update = () => {
    const text = readOnly ? area.textContent : area.value;
    const n = text.split('\n').length;
    if (n !== lines) {
      lines = n;
      gutter.textContent = Array.from({ length: n }, (_, i) => i + 1).join('\n');
    }
  };
  if (readOnly) area.textContent = initial; else area.value = initial;
  area.addEventListener('scroll', () => { gutter.scrollTop = area.scrollTop; });
  if (!readOnly) {
    area.addEventListener('input', update);
    area.addEventListener('keydown', (e) => {
      if (e.key === 'Tab' && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        document.execCommand('insertText', false, '    ');
      }
    });
  }
  update();
  const el = h('div', { class: 'editor' }, gutter, area);
  return { el, area, get value() { return area.value; }, set value(v) { area.value = v; update(); }, update };
}

function sourceDialog(title, code) {
  return modal(title, codeEditor(code, true).el, [
    { label: '复制代码', primary: true, onClick: async () => { await copyText(code); toast('代码已复制'); return false; } },
    { label: '关闭' },
  ], { wide: true });
}

async function renderContest(id) {
  let c = await api('GET', '/api/contests/' + id);
  if (c.requiresConfirmation) return renderJoinConfirmation(c);
  let refreshing = false;
  const main = shell(null);
  const head = h('div');
  const cards = h('div', { class: 'problems' });
  const timeEl = h('div', { class: 'time' });
  const lblEl = h('div', { class: 'lbl' });
  append(main, h('div', { class: 'card' }, head), cards);

  const renderHead = () => {
    const running = c.phase === 'running';
    const step = (no, ...content) => h('li', null, h('span', { class: 'no' }, `第 ${no} 步`), ...content);
    put(head, 
      h('div', { class: 'contest-head' },
        h('h1', null, `${c.title}：${c.user.realName}，${c.user.username}`),
        h('div', { class: 'countdown' }, lblEl, timeEl)),
      h('div', { class: 'contest-info' },
        h('div', null,
          h('ul', { class: 'kv' },
            h('li', null, h('span', { class: 'k' }, '姓名'), c.user.realName),
            h('li', null, h('span', { class: 'k' }, '账号'), c.user.username),
            c.user.groups.length ? h('li', null, h('span', { class: 'k' }, '分组'), c.user.groups.join('、')) : null,
            h('li', null, h('span', { class: 'k' }, '时间'), fmtRange(c.startTime, c.endTime)),
            h('li', null, h('span', { class: 'k' }, '模式'), c.strict ? '严格模式' : '非严格模式'),
            c.extraMinutes ? h('li', null, h('span', { class: 'k' }, '延时'), `已增加 ${c.extraMinutes} 分钟`) : null),
          h('div', { class: 'flex', style: { marginTop: '12px' } },
            h('button', { onclick: () => refresh(true) }, '刷新页面'),
            running && !c.finishedAt ? h('button', { class: 'danger', onclick: finishEarly }, '提前结束比赛') : null),
          c.finishedAt && c.phase !== 'ended' ? h('div', { class: 'finished-note' }, `你已于 ${fmtTime(c.finishedAt, false).slice(6)} 结束比赛，不能再提交`) : null),
        h('ul', { class: 'steps' },
          step(0, '下载考生手册并仔细阅读', c.manual ? h('a', { href: '/api/manual', target: '_blank' }, '下载') : h('span', { class: 'muted' }, '暂无考生手册')),
          step(1, '下载试题包并解压', h('span', { 'data-material': 'downzip' },
            c.downZipState === 'available' ? h('a', { href: `/api/contests/${c.id}/down.zip` }, '下载')
              : h('span', { class: 'muted' }, c.downZipState === 'pending' ? `待下发（${fmtTime(c.downZipReleaseAt, false)}）` : '未设置 down.zip'))),
          step(2, '用密码解密试题册', h('span', { 'data-material': 'password' },
            c.passwordState === 'available' ? h('code', { class: 'pwd' }, c.password)
              : h('span', { class: 'muted' }, c.passwordState === 'pending' ? `待公布（${fmtTime(c.passwordReleaseAt, false)}）` : '未设置密码'))),
          step(3, '编写代码，提交到系统'),
          step(4, '查看已提交的代码，确认无误'),
          h('li', { class: 'note' }, '输入输出请严格按试题册要求编写。'),
          c.lemonResultsLink ? h('li', null, h('a', { href: c.lemonResultsLink, target: '_blank', rel: 'noopener noreferrer' }, '查看 LemonServer 结果')) : null)));
    tick();
  };

  const renderCards = () => {
    const running = c.phase === 'running';
    if (!c.problemsReleased) {
      return put(cards, h('div', { class: 'card empty', 'data-problems-pending': true, style: { gridColumn: '1 / -1' } },
        '题目待公布', h('div', { class: 'muted small', style: { marginTop: '6px' } }, fmtTime(c.problemsReleaseAt, false))));
    }
    put(cards, ...c.problems.map((p) => {
      const s = p.submission;
      return h('div', { class: 'problem' + (s ? ' done' : '') },
        h('div', { class: 'title' }, p.title, p.title !== p.name ? h('span', { class: 'muted mono' }, p.name) : null),
        h('div', { class: 'info' }, s ? [
          h('div', null, '提交时间：', fmtTime(s.time, false)),
          h('div', null, '编程语言：', s.lang),
          h('div', null, '代码长度：', `${s.size} 字节`),
        ] : h('div', { class: 'muted' }, '尚未提交')),
        h('div', { class: 'actions' },
          h('button', { class: 'primary small', disabled: !running || !!c.finishedAt, onclick: () => submitDialog(p) }, '提交代码'),
          s ? h('button', { class: 'small', onclick: () => viewSource(p) }, '查看代码') : null));
    }));
  };

  const tick = () => {
    const t = now();
    const phase = t < c.startTime ? 'before' : t < c.endTime ? 'running' : 'ended';
    const releaseDue = (c.downZipState === 'pending' && t >= c.downZipReleaseAt)
      || (c.passwordState === 'pending' && t >= c.passwordReleaseAt)
      || (!c.problemsReleased && t >= c.problemsReleaseAt);
    if (phase !== c.phase || releaseDue) return refresh();
    lblEl.textContent = phase === 'before' ? '距离开始' : phase === 'running' ? '距离结束' : '';
    timeEl.classList.toggle('ended', phase === 'ended');
    timeEl.textContent = phase === 'before' ? fmtDuration(c.startTime - t) : phase === 'running' ? fmtDuration(c.endTime - t) : '已结束';
  };

  const finishEarly = async () => {
    if (!(await confirmBox('提前结束比赛', '结束后不能再提交代码，但仍可进入本页查看已提交的代码。确定结束？', '结束比赛', true))) return;
    try {
      await api('POST', `/api/contests/${c.id}/finish`);
      toast('已结束比赛');
      refresh();
    } catch (e) { fail(e); }
  };

  const refresh = async (manual) => {
    if (refreshing) return;
    refreshing = true;
    try {
      const fresh = await api('GET', '/api/contests/' + id);
      const changed = JSON.stringify({ ...fresh, serverTime: 0 }) !== JSON.stringify({ ...c, serverTime: 0 });
      c = fresh;
      if (changed || manual) {
        renderHead();
        renderCards();
      }
      if (manual) toast('已刷新');
    } catch (e) {
      if (e.status === 404 || e.status === 403) { toast(e.message, true); go('#/'); } else if (manual) fail(e);
    } finally { refreshing = false; }
  };

  const submitDialog = (p) => {
    const ed = codeEditor('');
    const sizeEl = h('span', { class: 'muted small' }, '0 字节');
    ed.area.addEventListener('input', () => { sizeEl.textContent = `${utf8Size(ed.value)} 字节`; });
    const fromFile = h('button', { class: 'small', type: 'button', onclick: async () => {
      const f = await pickFile('.cpp,.cc,.cxx,.h,.txt');
      if (!f) return;
      ed.value = await f.text();
      sizeEl.textContent = `${utf8Size(ed.value)} 字节`;
    } }, '从文件读取');
    modal(`提交：${p.title}`, h('div', { class: 'stack' },
      h('div', { class: 'flex' }, h('span', { class: 'muted' }, '语言'), h('label', { class: 'check' }, h('input', { type: 'radio', checked: true }), 'C++'),
        h('div', { class: 'grow' }), fromFile),
      ed.el), [
      { label: '关闭' },
      { label: '提交', primary: true, onClick: async () => {
        if (!ed.value.trim()) { toast('代码为空', true); return false; }
        await api('POST', `/api/contests/${c.id}/submit`, { problem: p.name, code: ed.value, language: 'C++' });
        toast('提交成功');
        refresh();
      } },
    ], { wide: true, sticky: true, left: sizeEl });
  };

  const viewSource = async (p) => {
    try {
      const s = await api('GET', `/api/contests/${c.id}/source/${enc(p.name)}`);
      sourceDialog(`${p.title} · ${s.lang}`, s.code);
    } catch (e) { fail(e); }
  };

  renderHead();
  renderCards();
  every(1000, tick);
  every(5000, () => refresh());
}

function renderJoinConfirmation(c) {
  const join = h('button', { class: 'primary', 'data-join-contest': c.id, onclick: async () => {
    join.disabled = true;
    try { await api('POST', `/api/contests/${c.id}/join`, { confirm: true, strict: c.strict }); await route(); }
    catch (error) { fail(error); if (error.status === 409) route(); else if ([403, 404].includes(error.status)) go('#/'); }
    finally { join.disabled = false; }
  } }, '确认参加');
  const main = shell(null, h('div', { class: 'card join-confirmation', 'data-join-confirmation': c.id },
    h('h1', null, c.title),
    h('ul', { class: 'kv' },
      h('li', null, h('span', { class: 'k' }, '时间'), fmtRange(c.startTime, c.endTime)),
      h('li', null, h('span', { class: 'k' }, '时长'), `${Number(c.durationMinutes.toFixed(2))} 分钟`),
      h('li', null, h('span', { class: 'k' }, '模式'), c.strict ? '严格模式' : '非严格模式'),
      h('li', null, h('span', { class: 'k' }, '选手'), `${c.user.realName}（${c.user.username}）`)),
    h('p', { class: 'muted' }, c.strict ? '确认参加后，结束本场比赛前暂时无法查看历史比赛。仍可同时参加其他比赛。' : '可以同时参加其他比赛，也可以查看历史比赛。'),
    h('div', { class: 'flex' }, h('button', { onclick: () => go('#/'), 'data-decline-contest': true }, '不参加，返回'), join)));
  main.classList.add('narrow');
  refreshWhenChanged('/api/contests/' + c.id, c);
}

// ============================================================ admin: contests

function pager(page, pages, href) {
  if (pages <= 1) return null;
  return h('div', { class: 'pager' },
    h('a', { class: 'btn small' + (page <= 1 ? ' disabled' : ''), href: href(page - 1) }, '‹ 上一页'),
    h('span', { class: 'muted' }, `${page} / ${pages}`),
    h('a', { class: 'btn small' + (page >= pages ? ' disabled' : ''), href: href(page + 1) }, '下一页 ›'));
}

async function renderAdminContests(page = 1) {
  const r = await api('GET', `/api/admin/contests?page=${page}&pageSize=20`);
  if (r.page !== page && page !== 1) return go(r.page > 1 ? '#/admin/page/' + r.page : '#/admin');
  const list = r.contests;
  const main = shell('contests', h('div', { class: 'page-head' }, h('h2', null, '比赛'),
    r.total ? h('span', { class: 'muted' }, `共 ${r.total} 场`) : null,
    h('div', { class: 'right' }, h('button', { class: 'primary', onclick: () => go('#/admin/new') }, '新建比赛'))));
  if (!list.length) {
    main.appendChild(h('div', { class: 'card empty' }, '还没有比赛'));
    return;
  }
  append(main, h('div', { class: 'group contest-list' }, list.map((c) =>
    h('div', { class: 'row link', onclick: () => go('#/admin/c/' + c.id) },
      h('div', { class: 'grow' },
        h('div', { class: 'name' }, c.title, c.title !== c.name ? h('span', { class: 'muted small', style: { fontWeight: 400, marginLeft: '8px' } }, c.name) : null),
        h('div', { class: 'muted small' }, `${fmtRange(c.startTime, c.endTime)} · ${c.problems.length} 题 · ${c.submissions} 份提交`)),
      c.lemon.contest ? h('span', { class: 'badge blue' }, 'LemonServer') : null,
      h('span', { class: 'badge ' + PHASE_BADGE[c.phase] }, PHASE[c.phase]),
      h('span', { class: 'chev' }, '›')))),
    pager(r.page, r.pages, (p) => (p > 1 ? '#/admin/page/' + p : '#/admin')));
  refreshWhenChanged(`/api/admin/contests?page=${page}&pageSize=20`, r);
}

async function renderContestForm(id) {
  const [loadedContest, groups, settings] = await Promise.all([
    id ? api('GET', '/api/admin/contests/' + id) : null,
    api('GET', '/api/admin/groups'),
    api('GET', '/api/admin/settings'),
  ]);
  let contest = loadedContest, saving = false;
  const lemonOn = !!(settings.lemon.url && settings.lemon.apiKeySet);
  const t0 = new Date();
  t0.setMinutes(0, 0, 0);
  t0.setHours(t0.getHours() + 1);
  const f = contest ? structuredClone(contest) : {
    name: '', title: '', startTime: t0.getTime(), endTime: t0.getTime() + 4 * 3600000, earlyMinutes: 30,
    downZipReleaseMinutes: 30, passwordReleaseMinutes: 0,
    problems: [{ name: '', title: '' }], groups: [], subFolder: false, strict: true, downZipPassword: '', lemon: { contest: '', interval: null },
  };
  // In the editor, title holds only a custom display name; '' means "same as the file name".
  // Keeping the saved copy of the old name here made it reappear (and be saved) after a rename + re-render.
  for (const problem of f.problems) {
    if (contest) problem.previousName = problem.name;
    if (problem.title === problem.name) problem.title = '';
  }
  let pendingDownZip = null; // File chosen before the contest exists
  let lemonDownZip = null; // import down.zip from this LemonServer contest after saving

  const main = shell('contests', h('div', { class: 'page-head' },
    h('h2', null, contest ? '编辑比赛' : '新建比赛'),
    h('div', { class: 'right' },
      h('button', { onclick: () => go(contest ? '#/admin/c/' + contest.id : '#/admin') }, '取消'),
      h('button', { class: 'primary', onclick: () => save() }, '保存'))));
  main.classList.add('narrow');

  const input = (key, attrs = {}) => h('input', { type: 'text', class: 'full', value: f[key] ?? '', oninput: (e) => { f[key] = e.target.value; }, ...attrs });
  const timeLocked = !!(contest && contest.phase === 'ended');
  const timeInput = (key) => h('input', { type: 'datetime-local', disabled: timeLocked, min: toLocalInput(Date.now()), value: toLocalInput(f[key]), onchange: (e) => { f[key] = fromLocalInput(e.target.value); } });
  const minuteInput = (key, label) => h('input', { type: 'number', name: key, 'aria-label': label, min: 0, max: 10080, step: 1,
    disabled: timeLocked, value: f[key], oninput: (e) => { f[key] = e.target.value === '' ? '' : Number(e.target.value); } });

  // --- basics
  append(main, h('div', { class: 'section-title' }, '基本'),
    h('div', { class: 'group' },
      row('比赛名', input('name', { placeholder: '作为文件夹名，如 NOIP2026', oninput: (e) => { f.name = e.target.value; } })),
      row('标题', input('title', { placeholder: '留空则同比赛名' })),
      row('开始时间', timeInput('startTime')),
      row('结束时间', timeInput('endTime')),
      row('严格模式', switchEl(f.strict !== false, value => { f.strict = value; })),
      row('提前进入', minuteInput('earlyMinutes', '提前进入时间'), h('span', { class: 'muted' }, '分钟（开赛前）'))));

  // --- problems
  const plist = h('div', { class: 'problem-rows' });
  const problemOf = new WeakMap(); // row element -> problem object, so reordering never depends on indexes
  const renumber = () => plist.querySelectorAll('.prow .idx').forEach((el, i) => { el.textContent = i + 1; });
  const moveProblem = (p, delta) => {
    if (plist.classList.contains('sorting')) return;
    const i = f.problems.indexOf(p), j = i + delta;
    if (i < 0 || j < 0 || j >= f.problems.length) return;
    f.problems.splice(j, 0, f.problems.splice(i, 1)[0]);
    renderProblems();
    plist.querySelectorAll('.prow .drag-handle')[j]?.focus();
  };
  const startDrag = (event, rowEl) => {
    if (event.button !== 0 || plist.classList.contains('sorting')) return;
    event.preventDefault();
    const handle = event.currentTarget, pointer = event.pointerId, box = rowEl.getBoundingClientRect();
    const placeholder = h('div', { class: 'prow-placeholder', style: { height: box.height + 'px' } });
    const previousStyle = rowEl.style.cssText, previousCursor = document.body.style.cursor;
    let pointerY = event.clientY, finished = false, frame;
    rowEl.before(placeholder);
    rowEl.classList.add('dragging');
    plist.classList.add('sorting');
    Object.assign(rowEl.style, { left: box.left + 'px', top: box.top + 'px', width: box.width + 'px' });
    document.body.style.cursor = 'grabbing';
    handle.focus({ preventScroll: true });
    const place = () => {
      rowEl.style.top = pointerY - (event.clientY - box.top) + 'px';
      const others = [...plist.children].filter(el => el !== rowEl && el !== placeholder);
      const next = others.find(el => { const r = el.getBoundingClientRect(); return pointerY < r.top + r.height / 2; }) || null;
      if (placeholder.nextElementSibling !== next) plist.insertBefore(placeholder, next);
      [...plist.children].filter(el => el !== rowEl).forEach((el, i) => (el === placeholder ? rowEl : el).querySelector('.idx').textContent = i + 1);
    };
    const onMove = e => { if (e.pointerId === pointer) { pointerY = e.clientY; place(); } };
    const onEnd = e => {
      if (finished || e?.pointerId !== undefined && e.pointerId !== pointer) return;
      finished = true;
      cancelAnimationFrame(frame);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onEnd);
      window.removeEventListener('pointercancel', onEnd);
      window.removeEventListener('blur', onEnd);
      window.removeEventListener('keydown', onKey);
      handle.removeEventListener('lostpointercapture', onEnd);
      if (handle.hasPointerCapture(pointer)) handle.releasePointerCapture(pointer);
      if (e?.type === 'pointerup') placeholder.replaceWith(rowEl); else placeholder.remove();
      rowEl.style.cssText = previousStyle;
      rowEl.classList.remove('dragging');
      plist.classList.remove('sorting');
      document.body.style.cursor = previousCursor;
      renumber();
      f.problems = [...plist.children].map((el) => problemOf.get(el));
    };
    const onKey = e => { if (e.key === 'Escape') { e.preventDefault(); onEnd(); } };
    const scroll = () => {
      const dy = pointerY < 48 ? -12 : pointerY > innerHeight - 48 ? 12 : 0;
      if (dy) { window.scrollBy(0, dy); place(); }
      frame = requestAnimationFrame(scroll);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onEnd);
    window.addEventListener('pointercancel', onEnd);
    window.addEventListener('blur', onEnd);
    window.addEventListener('keydown', onKey);
    handle.addEventListener('lostpointercapture', onEnd);
    // Keep the captured handle in its original DOM position until the drop.
    handle.setPointerCapture(pointer);
    frame = requestAnimationFrame(scroll);
  };
  const renderProblems = () => {
    put(plist, ...f.problems.map((p, i) => {
      const handle = h('button', { type: 'button', class: 'drag-handle', title: '拖动排序', 'aria-label': '拖动排序',
        onkeydown: (e) => {
          if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); moveProblem(p, e.key === 'ArrowUp' ? -1 : 1); }
        } }, h('span', { 'aria-hidden': 'true' }));
      const el = h('div', { class: 'prow' }, handle,
        h('span', { class: 'idx' }, i + 1),
        h('input', { type: 'text', class: 'grow mono', placeholder: '题目名（文件名）', value: p.name, oninput: (e) => { p.name = e.target.value.trim(); } }),
        h('input', { type: 'text', class: 'grow', placeholder: '显示名称（可选）', value: p.title, oninput: (e) => { p.title = e.target.value; } }),
        h('button', { class: 'plain small danger', title: '删除', onclick: () => { f.problems.splice(f.problems.indexOf(p), 1); renderProblems(); } }, '✕'));
      handle.addEventListener('pointerdown', (e) => startDrag(e, el));
      problemOf.set(el, p);
      return el;
    }));
  };
  renderProblems();
  append(main, h('div', { class: 'section-title' }, '题目'),
    h('div', { class: 'card' }, plist,
      h('div', { class: 'flex', style: { marginTop: '12px' } },
        h('button', { class: 'small', onclick: () => { f.problems.push({ name: '', title: '', previousName: null }); renderProblems(); } }, '添加题目'),
        lemonOn ? h('button', { class: 'small', onclick: () => importFromLemon() }, '从 LemonServer 导入') : null)),
    h('div', { class: 'section-foot' }, '改文件名会同步改名已提交的代码'));

  // --- groups
  const gbox = h('div', { class: 'flex' });
  const renderGroups = () => {
    put(gbox, ...(groups.length ? groups.map((g) => h('button', {
      class: 'chip' + (f.groups.includes(g.id) ? ' on' : ''),
      onclick: () => { f.groups = f.groups.includes(g.id) ? f.groups.filter((x) => x !== g.id) : [...f.groups, g.id]; renderGroups(); },
    }, g.name)) : [h('span', { class: 'muted' }, '暂无分组')]));
  };
  renderGroups();
  append(main, h('div', { class: 'section-title' }, '参赛分组'), h('div', { class: 'card' }, gbox),
    h('div', { class: 'section-foot' }, '不选则所有用户都可参加'));

  // --- down.zip
  const dzState = h('div', { class: 'value' });
  const renderDz = () => {
    const dz = contest?.downZip;
    put(dzState, 
      pendingDownZip ? h('span', null, pendingDownZip.name, h('span', { class: 'muted' }, ` · ${fmtSize(pendingDownZip.size)} · 保存后上传`))
        : lemonDownZip ? h('span', null, `从 LemonServer 导入（${lemonDownZip}）`)
          : dz ? h('span', null, h('a', { href: `/api/admin/contests/${contest.id}/downzip` }, dz.name), h('span', { class: 'muted' }, ` · ${fmtSize(dz.size)}`))
            : h('span', { class: 'muted' }, '未设置'),
      h('div', { class: 'grow' }),
      h('button', { class: 'small', onclick: chooseDz }, dz || pendingDownZip ? '替换' : '上传'),
      dz || pendingDownZip || lemonDownZip ? h('button', { class: 'small danger', onclick: removeDz }, '删除') : null);
  };
  const chooseDz = async () => {
    const file = await pickFile('.zip,.7z,.rar');
    if (!file) return;
    lemonDownZip = null;
    // Save the release schedule before uploading, including for existing contests.
    // Otherwise selecting a file could expose it under the previously saved schedule.
    pendingDownZip = file;
    renderDz();
  };
  const removeDz = async () => {
    if (pendingDownZip || lemonDownZip) { pendingDownZip = lemonDownZip = null; return renderDz(); }
    if (!(await confirmBox('删除试题包', '删除后选手无法下载。', '删除', true))) return;
    try { Object.assign(contest, await api('DELETE', `/api/admin/contests/${contest.id}/downzip`)); } catch (e) { fail(e); }
    renderDz();
  };
  renderDz();
  append(main, h('div', { class: 'section-title' }, '试题包'),
    h('div', { class: 'group' },
      h('div', { class: 'row' }, h('div', { class: 'label' }, 'down.zip'), dzState),
      row('down.zip 公开', minuteInput('downZipReleaseMinutes', 'down.zip 公开时间'), h('span', { class: 'muted' }, '分钟（开赛前）')),
      row('解压密码', input('downZipPassword', { name: 'downZipPassword', placeholder: '未设置密码' })),
      row('密码公布', minuteInput('passwordReleaseMinutes', '密码公布时间'), h('span', { class: 'muted' }, '分钟（开赛前）'))),
    h('div', { class: 'section-foot' }, '0 表示开赛时；须满足 提前进入 ≥ down.zip 公开 ≥ 密码公布。题目名与密码同时公布'));

  // --- storage
  append(main, h('div', { class: 'section-title' }, '存储'),
    h('div', { class: 'group' },
      row('子文件夹', switchEl(f.subFolder, (v) => { f.subFolder = v; }))),
    h('div', { class: 'section-foot' }, '切换时自动迁移已有代码。位于 ', h('code', null, settings.effectiveStorageRoot)));

  // --- LemonServer
  if (lemonOn || f.lemon.contest) {
    const select = h('select', { onchange: () => { f.lemon.contest = select.value; } }, h('option', { value: '' }, '不关联'));
    const loadLemon = async (selectName) => {
      try {
        const names = (await api('GET', '/api/admin/lemon/contests')).map((x) => x.name);
        if (f.lemon.contest && !names.includes(f.lemon.contest)) names.push(f.lemon.contest);
        put(select, h('option', { value: '' }, '不关联'), ...names.map((n) => h('option', { value: n, selected: n === f.lemon.contest }, n)));
        if (selectName) { select.value = selectName; f.lemon.contest = selectName; }
      } catch (e) {
        put(select, h('option', { value: f.lemon.contest }, f.lemon.contest || '不关联'));
        lemonErr.textContent = e.message;
      }
    };
    const lemonErr = h('span', { class: 'danger-text small' });
    const createBtn = h('button', { class: 'small', onclick: async () => {
      const name = (f.name || '').trim();
      if (!name) return toast('请先填写比赛名', true);
      try {
        await api('POST', '/api/admin/lemon/contests', { name, title: f.title || name });
        await loadLemon(name);
        toast('已在 LemonServer 新建 ' + name);
      } catch (e) { fail(e); }
    } }, '新建同名');
    loadLemon();

    const mode = f.lemon.interval === null || f.lemon.interval === undefined ? 'after' : f.lemon.interval === 0 ? 'submit' : 'period';
    const minutes = h('input', { type: 'number', min: 1, value: f.lemon.interval > 0 ? f.lemon.interval : 10, oninput: () => { if (minutes.value) f.lemon.interval = Number(minutes.value); } });
    const minutesWrap = h('span', { class: 'flex' + (mode === 'period' ? '' : ' hidden') }, '每', minutes, '分钟');
    const seg = segmented([['after', '赛后统一'], ['submit', '每次提交'], ['period', '定时']], mode, (v) => {
      f.lemon.interval = v === 'after' ? null : v === 'submit' ? 0 : Number(minutes.value) || 10;
      minutesWrap.classList.toggle('hidden', v !== 'period');
    });
    append(main, h('div', { class: 'section-title' }, 'LemonServer'),
      h('div', { class: 'group' },
        row('关联比赛', select, createBtn, lemonErr),
        row('评测', seg, minutesWrap)),
      h('div', { class: 'section-foot' }, '只评测未评测的代码，赛后再评测一次'));
    f._reloadLemon = loadLemon;
  }

  if (contest) {
    append(main, h('div', { class: 'section-title' }, '危险操作'),
      h('div', { class: 'group' }, h('div', { class: 'row' }, h('div', { class: 'grow' }, '删除比赛'),
        h('button', { class: 'danger', onclick: () => deleteContest(contest) }, '删除'))));
  }

  const importFromLemon = async () => {
    let list;
    try { list = await api('GET', '/api/admin/lemon/contests'); } catch (e) { return fail(e); }
    if (!list.length) return toast('LemonServer 上没有比赛', true);
    const sel = h('select', { class: 'full' }, list.map((x) => h('option', { value: x.name, selected: x.name === f.lemon.contest },
      `${x.name}（${x.tasks ?? '?'} 题）`)));
    const withZip = h('input', { type: 'checkbox', checked: true });
    modal('从 LemonServer 导入', h('div', { class: 'stack' }, sel,
      h('label', { class: 'check' }, withZip, '同时导入 down.zip（如有）'),
      h('div', { class: 'muted small' }, '会替换题目列表，并关联该比赛')), [
      { label: '取消' },
      { label: '导入', primary: true, onClick: async () => {
        const r = await api('GET', '/api/admin/lemon/contests/' + enc(sel.value));
        if (!r.tasks.length) { toast('该比赛没有试题', true); return false; }
        f.problems = r.tasks.map((t) => ({ name: t.name, title: t.title && t.title !== t.name ? t.title : '', previousName: contest?.problems.find(p => p.name === t.name)?.name ?? null }));
        f.lemon.contest = r.name;
        if (!f.name) { f.name = r.name; main.querySelector('input').value = r.name; }
        if (withZip.checked && r.downZip) { lemonDownZip = r.name; pendingDownZip = null; }
        renderProblems();
        renderDz();
        if (f._reloadLemon) f._reloadLemon(r.name);
        toast(`已导入 ${r.tasks.length} 道题`);
      } },
    ]);
  };

  const save = async () => {
    if (saving) return;
    const minutes = [f.earlyMinutes, f.downZipReleaseMinutes, f.passwordReleaseMinutes];
    if (minutes.some(value => value === '' || !Number.isInteger(value) || value < 0 || value > 10080))
      return toast('进入和公开时间须填写 0–10080 的整数分钟数', true);
    if (f.earlyMinutes < f.downZipReleaseMinutes || f.downZipReleaseMinutes < f.passwordReleaseMinutes)
      return toast('须满足：提前进入 ≥ down.zip 公开 ≥ 密码公布（开赛前分钟数）', true);
    const body = {
      name: (f.name || '').trim(), title: f.title, startTime: f.startTime, endTime: f.endTime,
      earlyMinutes: f.earlyMinutes, problems: f.problems.filter((p) => p.name || p.title), groups: f.groups,
      downZipReleaseMinutes: f.downZipReleaseMinutes, passwordReleaseMinutes: f.passwordReleaseMinutes,
      subFolder: f.subFolder, downZipPassword: f.downZipPassword, lemon: { contest: f.lemon.contest || '', interval: f.lemon.interval },
    };
    saving = true;
    try {
      const r = contest ? await api('PUT', '/api/admin/contests/' + contest.id, body) : await api('POST', '/api/admin/contests', body);
      contest = r; // if a new contest's upload fails, retry saves this contest rather than creating it again
      if (pendingDownZip) { contest = await uploadDownZip(r.id, pendingDownZip); pendingDownZip = null; }
      if (lemonDownZip) await api('POST', `/api/admin/contests/${r.id}/downzip/from-lemon`, { contest: lemonDownZip }).catch((e) => toast('导入 down.zip 失败：' + e.message, true));
      toast('已保存');
      go('#/admin/c/' + r.id);
    } catch (e) { fail(e); } finally { saving = false; }
  };
}

async function uploadDownZip(id, file) {
  toast('正在上传…');
  return api('PUT', `/api/admin/contests/${id}/downzip?name=${enc(file.name)}`, undefined, { raw: file });
}

async function deleteContest(c) {
  const files = h('input', { type: 'checkbox' });
  modal('删除比赛', h('div', { class: 'stack' }, h('div', null, `确定删除“${c.title}”？`),
    h('label', { class: 'check' }, files, '同时删除选手代码文件')), [
    { label: '取消' },
    { label: '删除', danger: true, onClick: async () => {
      await api('DELETE', `/api/admin/contests/${c.id}${files.checked ? '?deleteFiles=1' : ''}`);
      toast('已删除');
      go('#/admin');
    } },
  ]);
}

const TASK_KIND = { periodic: '定时', submit: '提交触发', final: '赛后', manual: '手动' };
const TASK_STATE = { running: '准备中', queued: '排队中', judging: '评测中', done: '完成', skipped: '已跳过', error: '失败' };

async function renderBoard(id) {
  let b = await api('GET', `/api/admin/contests/${id}/board`);
  let order = { key: 'username', direction: 1 };
  const main = shell('contests');
  const body = h('div');
  main.appendChild(body);

  const render = () => {
    const c = b.contest;
    const L = b.lemon;
    const scored = L.linked && L.reachable;
    const finished = b.rows.filter((r) => r.finishedAt).length;
    let submitted = 0, judged = 0;
    for (const r of b.rows) for (const cell of Object.values(r.cells)) { submitted++; if (cell.judged) judged++; }

    const lemonCard = L.linked ? h('div', { class: 'card', style: { marginBottom: '16px' } },
      h('div', { class: 'status-line' },
        h('b', null, 'LemonServer'),
        h('span', { class: 'mono' }, L.contest),
        L.reachable ? h('span', { class: 'ok-text' }, '已连接') : h('span', { class: 'danger-text' }, L.error || '无法连接'),
        L.judging ? h('span', { class: 'badge blue' }, '正在评测') : L.queuedJobs ? h('span', { class: 'badge orange' }, '排队中') : null,
        h('span', { class: 'muted' }, '评测：' + (c.lemon.interval === null ? '赛后统一' : c.lemon.interval === 0 ? '每次提交' : `每 ${c.lemon.interval} 分钟`)),
        L.pendingUploads ? h('span', { class: 'warn-text' }, `待上传 ${L.pendingUploads}`) : null,
        L.finalDone ? h('span', { class: 'ok-text' }, '赛后评测已完成') : null,
        L.task ? h('span', { class: 'muted' }, `最近任务：${TASK_KIND[L.task.kind] || L.task.kind}${L.task.mode === 'all' ? '（全部）' : ''} · ${TASK_STATE[L.task.state] || L.task.state}${L.task.progress && L.task.state === 'judging' ? ' ' + L.task.progress : ''}${L.task.state === 'queued' ? ` 第 ${L.task.position} 位` : ''}${L.task.message ? ' · ' + L.task.message : ''} · ${fmtTime(L.task.startedAt, false).slice(6)}`) : null,
        h('div', { class: 'grow' }),
        h('button', { class: 'small', disabled: L.busy, onclick: () => act('judge') }, '立即评测'),
        h('button', { class: 'small', onclick: () => act('resync') }, '重新同步'),
        h('a', { class: 'btn small primary', href: L.link, target: '_blank' }, '评测结果 ↗')),
      [L.uploadError && `上传失败：${L.uploadError}`,
        b.missingTasks.length && `LemonServer 中缺少试题：${b.missingTasks.join('、')}`]
        .filter(Boolean).map((t) => h('div', { class: 'danger-text small', style: { marginTop: '6px' } }, t))) : null;

    // the result on LemonServer: score, or the compile state (NS, CE, …) when compiling failed
    const COMPILE = ['', 'NS', 'CE', 'CTLE', 'IC', 'NG'];
    const rows = CodeHubBoardSort.sort(b.rows, order.key, order.direction);
    // Luogu-style indicator: both grey triangles when unsorted, only the up (ascending) or down one when sorted.
    const sortHeader = (label, key, attrs = {}) => {
      const disabled = key !== 'username' && key !== 'realName' && !scored;
      const dir = order.key === key ? (order.direction > 0 ? 'asc' : 'desc') : null;
      return h('th', { ...attrs, 'aria-sort': dir === 'asc' ? 'ascending' : dir === 'desc' ? 'descending' : 'none' },
        h('button', { class: 'table-sort', 'data-sort': key, disabled, onclick: () => {
          order = { key, direction: order.key === key ? -order.direction : key === 'username' || key === 'realName' ? 1 : -1 }; render();
        } }, label, disabled ? null : h('span', { class: 'sort-icon' + (dir ? ' ' + dir : ''), 'aria-hidden': 'true' }, h('i', { class: 'up' }), h('i', { class: 'down' }))));
    };
    const result = (s, p) => {
      if (s.score === null || s.score === undefined) return null;
      const full = b.fullScores?.[p.name];
      const cls = s.compileState ? 'bad' : full && s.score >= full ? 'full' : s.score > 0 ? 'part' : 'zero';
      return h('span', { class: 'cell-score ' + cls }, s.compileState ? `0 ${COMPILE[s.compileState] || ''}` : s.score);
    };
    const table = h('table', { class: 'list' },
      h('thead', null, h('tr', null, sortHeader('账号', 'username'), sortHeader('姓名', 'realName'),
        c.problems.map((p) => sortHeader(p.title !== p.name ? `${p.title} (${p.name})` : p.name, 'problem:' + p.name, { class: 'cell' })),
        scored ? sortHeader('总分', 'total', { class: 'cell' }) : null,
        h('th', { class: 'cell' }, '已提交'),
        h('th', { class: 'cell' }, '提前结束'), h('th', { class: 'cell' }, '延时'))),
      h('tbody', null, rows.map((r) => h('tr', { 'data-user': r.username },
        h('td', { class: 'mono' }, r.username), h('td', null, r.realName),
        c.problems.map((p) => {
          const s = r.cells[p.name];
          const attrs = { 'data-cell': r.id + '|' + p.name };
          if (!s) return h('td', { ...attrs, class: 'cell muted' }, '—');
          let state = null;
          if (s.synced === false) state = h('span', { class: 'cell-state muted' }, '待上传');
          else if (s.judged === true) state = result(s, p) || h('span', { class: 'cell-state ok-text' }, '已评测');
          else if (s.judged === false) state = h('span', { class: 'cell-state warn-text' }, '未评测');
          return h('td', {
            ...attrs, class: 'cell has clickable', onclick: () => adminSource(c, r, p),
            title: `${fmtTime(s.time)} · 第 ${s.count} 次提交`,
          }, h('span', { class: 'cell-size' }, fmtSize(s.size)), state);
        }),
        scored ? h('td', { class: 'cell' }, r.total === null ? h('span', { class: 'muted' }, '—') : h('b', null, r.total)) : null,
        h('td', { class: 'cell muted' }, `${Object.keys(r.cells).length} / ${c.problems.length}`),
        h('td', { class: 'cell' }, r.finishedAt ? [h('span', { title: fmtTime(r.finishedAt) }, fmtTime(r.finishedAt, false).slice(6)),
          h('a', { class: 'undo-link', title: '允许该选手继续提交', onclick: () => undoFinish(r) }, '撤销')] : h('span', { class: 'muted' }, '—')),
        h('td', { class: 'cell' }, h('button', { class: 'small', 'data-extend': r.id, disabled: r.canExtend === false, onclick: () => extendUser(r) }, r.extraMinutes ? `+${r.extraMinutes} 分钟` : '延时'),
          r.extraMinutes ? h('div', { class: 'muted small', title: fmtTime(r.endTime) }, fmtTime(r.endTime, false)) : null)))));

    put(body,
      h('div', { class: 'page-head' },
        h('h2', null, c.title),
        h('span', { class: 'badge ' + PHASE_BADGE[c.phase] }, PHASE[c.phase]),
        h('span', { class: 'muted' }, fmtRange(c.startTime, c.endTime)),
        h('div', { class: 'right' },
          submitted ? h('a', { class: 'btn', href: `/api/admin/contests/${c.id}/archive.zip` }, '下载全部代码') : null,
          h('button', { onclick: () => go(`#/admin/c/${c.id}/edit`) }, '编辑'))),
      lemonCard,
      b.rows.length ? h('div', { class: 'table-wrap' }, table) : h('div', { class: 'card empty' }, '没有可参赛的用户'),
      h('div', { class: 'section-foot' },
        `${b.rows.length} 名选手 · 提交 ${submitted}` + (scored ? ` · 已评测 ${judged}` : '') + (finished ? ` · 提前结束 ${finished}` : '') + (submitted ? ' · 点击查看代码' : '')));
  };

  const reload = async () => {
    try {
      const fresh = await api('GET', `/api/admin/contests/${id}/board`);
      const changed = JSON.stringify({ ...fresh, serverTime: 0 }) !== JSON.stringify({ ...b, serverTime: 0 });
      b = fresh;
      if (changed) render();
    } catch (e) { if (e.status === 404) go('#/admin'); }
  };

  const undoFinish = async (r) => {
    if (!(await confirmBox('撤销提前结束', `允许 ${r.username} 继续提交？`, '撤销'))) return;
    try {
      await api('DELETE', `/api/admin/contests/${id}/finished/${r.id}`);
      toast('已撤销');
      reload();
    } catch (e) { fail(e); }
  };

  const extendUser = (r) => {
    const minutes = h('input', { type: 'number', min: 1, max: 10080 - (r.extraMinutes || 0), step: 1, value: 5, 'aria-label': '本次延时分钟数' });
    modal(`为 ${r.username} 延时`, h('div', { class: 'stack' },
      h('label', null, '本次增加的分钟数', minutes),
      h('div', { class: 'muted small' }, `当前结束：${fmtTime(r.endTime)}；已累计延时 ${r.extraMinutes || 0} 分钟。`)), [
      { label: '取消' }, { label: '保存延时', primary: true, onClick: async () => {
        const value = Number(minutes.value);
        if (!Number.isInteger(value) || value < 1 || value + (r.extraMinutes || 0) > 10080) { toast('请输入正整数分钟，累计最多 10080 分钟', true); return false; }
        await api('PUT', `/api/admin/contests/${id}/extensions/${r.id}`, { minutes: value + (r.extraMinutes || 0) });
        await reload();
      } },
    ]);
  };

  const act = async (what) => {
    try {
      await api('POST', `/api/admin/contests/${id}/lemon/${what}`);
      toast(what === 'judge' ? '已开始' : '已同步');
      setTimeout(reload, 800);
    } catch (e) { fail(e); }
  };

  render();
  every(3000, reload);
}

async function adminSource(c, r, p) {
  try {
    const s = await api('GET', `/api/admin/contests/${c.id}/source/${r.id}/${enc(p.name)}`);
    sourceDialog(`${r.username} · ${p.name}`, s.code);
  } catch (e) { fail(e); }
}

// ============================================================ admin: users

async function renderUsers() {
  let [users, groups] = await Promise.all([api('GET', '/api/admin/users'), api('GET', '/api/admin/groups')]);
  const sel = new Set();
  let query = '';
  let groupFilter = '';
  const main = shell('users');
  const gname = (id) => groups.find((g) => g.id === id)?.name;

  const reload = async () => {
    [users, groups] = await Promise.all([api('GET', '/api/admin/users'), api('GET', '/api/admin/groups')]);
    for (const id of [...sel]) if (!users.some((u) => u.id === id)) sel.delete(id);
    render();
  };

  const filterSel = h('select', { onchange: () => { groupFilter = filterSel.value; render(); } });
  const search = h('input', { type: 'search', placeholder: '搜索用户名或姓名', oninput: () => { query = search.value.trim().toLowerCase(); render(); } });
  const head = h('div', { class: 'page-head' }, h('h2', null, '用户'),
    h('div', { class: 'right' },
      h('button', { onclick: () => groupsDialog() }, '分组'),
      h('button', { 'data-export-users': true, onclick: () => {
        const format = h('select', { 'aria-label': '导出文件类型' }, ...['csv', 'tsv', 'txt', 'json'].map(type => h('option', { value: type }, type.toUpperCase())));
        const scope = sel.size ? `已选 ${sel.size} 名用户` : groupFilter === 'none' ? '未分组用户' : groupFilter ? `分组：${gname(Number(groupFilter))}` : '全部用户';
        modal('导出用户', h('div', { class: 'stack' }, h('p', null, scope), row('文件类型', format)), [
          { label: '取消' }, { label: '下载', primary: true, onClick: () => {
            const query = new URLSearchParams({ format: format.value });
            if (sel.size) query.set('ids', [...sel].join(',')); else if (groupFilter) query.set('group', groupFilter);
            const link = h('a', { href: '/api/admin/users/export?' + query, download: 'users.' + format.value });
            document.body.appendChild(link); link.click(); link.remove();
          } },
        ]);
      } }, '导出'),
      h('button', { class: 'primary', onclick: () => importDialog() }, '导入用户')));
  const toolbar = h('div', { class: 'toolbar' }, search, filterSel);
  const bulk = h('div');
  const tableBox = h('div');
  const foot = h('div', { class: 'section-foot' });
  append(main, head, toolbar, bulk, tableBox, foot);

  const visible = () => users.filter((u) =>
    (!query || u.username.toLowerCase().includes(query) || (u.realName || '').toLowerCase().includes(query)) &&
    (!groupFilter || (groupFilter === 'none' ? !u.groups.length : u.groups.includes(Number(groupFilter)))));

  const render = () => {
    put(filterSel, h('option', { value: '' }, '全部分组'), h('option', { value: 'none', selected: groupFilter === 'none' }, '未分组'),
      ...groups.map((g) => h('option', { value: g.id, selected: String(g.id) === groupFilter }, `${g.name}（${g.users}）`)));
    const list = visible();
    put(bulk, sel.size ? h('div', { class: 'bulkbar' },
      h('span', null, `已选 ${sel.size} 人`),
      h('button', { class: 'small', onclick: () => batchGroups('addGroups') }, '加入分组'),
      h('button', { class: 'small', onclick: () => batchGroups('removeGroups') }, '移出分组'),
      h('button', { class: 'small danger', onclick: batchDelete }, '删除'),
      h('div', { class: 'grow' }),
      h('button', { class: 'small plain', onclick: () => { sel.clear(); render(); } }, '取消选择')) : null);
    if (!users.length) {
      put(tableBox, h('div', { class: 'card empty' }, '还没有用户，点“导入用户”添加'));
      foot.textContent = '';
      return;
    }
    const all = list.length > 0 && list.every((u) => sel.has(u.id));
    put(tableBox, h('div', { class: 'table-wrap' }, h('table', { class: 'list' },
      h('thead', null, h('tr', null,
        h('th', { style: { width: '36px' } }, h('input', { type: 'checkbox', checked: all, onchange: (e) => { list.forEach((u) => (e.target.checked ? sel.add(u.id) : sel.delete(u.id))); render(); } })),
        h('th', null, '用户名'), h('th', null, '姓名'), h('th', null, '分组'), h('th', { style: { width: '80px' } }))),
      h('tbody', null, list.map((u) => h('tr', null,
        h('td', null, h('input', { type: 'checkbox', checked: sel.has(u.id), onchange: (e) => { e.target.checked ? sel.add(u.id) : sel.delete(u.id); render(); } })),
        h('td', { class: 'mono' }, u.username),
        h('td', null, u.realName),
        h('td', null, h('div', { class: 'flex' }, u.groups.map((g) => h('span', { class: 'chip' }, gname(g))))),
        h('td', null, h('button', { class: 'small plain', onclick: () => editUser(u) }, '编辑'))))))));
    foot.textContent = list.length === users.length ? `共 ${users.length} 人` : `显示 ${list.length} / ${users.length} 人`;
  };

  const groupPicker = (selected) => {
    const set = new Set(selected);
    const box = h('div', { class: 'flex' });
    const draw = () => put(box, ...(groups.length ? groups.map((g) => h('button', {
      type: 'button', class: 'chip' + (set.has(g.id) ? ' on' : ''),
      onclick: () => { set.has(g.id) ? set.delete(g.id) : set.add(g.id); draw(); },
    }, g.name)) : [h('span', { class: 'muted small' }, '暂无分组')]));
    draw();
    return { el: box, get value() { return [...set]; } };
  };

  const editUser = (u) => {
    const name = h('input', { type: 'text', class: 'full', value: u.realName });
    const pw = h('input', { type: 'text', class: 'full', placeholder: '留空则不修改' });
    const gp = groupPicker(u.groups);
    modal(`编辑 ${u.username}`, h('div', { class: 'group', style: { boxShadow: 'none', background: 'var(--card2)' } },
      row('姓名', name), row('新密码', pw), row('分组', gp.el)), [
      { label: '取消' },
      { label: '保存', primary: true, onClick: async () => {
        const body = { realName: name.value, groups: gp.value };
        if (pw.value) body.password = pw.value;
        await api('PUT', '/api/admin/users/' + u.id, body);
        toast(pw.value ? '已保存，密码已修改' : '已保存');
        reload();
      } },
    ], { left: h('button', { class: 'danger', onclick: async () => {
      if (!(await confirmBox('删除用户', `删除 ${u.username}？已提交的代码会保留。`, '删除', true))) return;
      try { await api('POST', '/api/admin/users/batch', { ids: [u.id], action: 'delete' }); document.querySelector('.overlay')?.remove(); reload(); } catch (e) { fail(e); }
    } }, '删除') });
  };

  const batchGroups = (action) => {
    if (!groups.length) return toast('请先创建分组', true);
    const gp = groupPicker([]);
    modal(action === 'addGroups' ? '加入分组' : '移出分组', h('div', { class: 'stack' }, h('div', { class: 'muted' }, `${sel.size} 名用户`), gp.el), [
      { label: '取消' },
      { label: '确定', primary: true, onClick: async () => {
        if (!gp.value.length) { toast('请选择分组', true); return false; }
        await api('POST', '/api/admin/users/batch', { ids: [...sel], action, groups: gp.value });
        toast('已更新');
        reload();
      } },
    ]);
  };

  const batchDelete = async () => {
    if (!(await confirmBox('删除用户', `删除选中的 ${sel.size} 名用户？已提交的代码会保留。`, '删除', true))) return;
    try {
      await api('POST', '/api/admin/users/batch', { ids: [...sel], action: 'delete' });
      sel.clear();
      toast('已删除');
      reload();
    } catch (e) { fail(e); }
  };

  const importDialog = () => {
    const text = h('textarea', { class: 'full mono', rows: 12, placeholder: '用户名,密码,姓名,分组\nSC-00001,123,张三,高一\nSC-00002,123' });
    const fileBtn = h('button', { class: 'small', type: 'button', onclick: async () => {
      const f = await pickFile('.csv,.txt,.tsv');
      if (f) text.value = await readText(f);
    } }, '从文件读取');
    let mode = 'skip';
    const gp = groupPicker([]);
    const errBox = h('div', { class: 'err-list' });
    modal('导入用户', h('div', { class: 'stack' },
      h('div', { class: 'flex' }, h('span', { class: 'muted small grow' }, '每行：用户名,密码[,姓名[,分组;分组]]，姓名为空则同用户名'), fileBtn),
      text,
      h('div', { class: 'flex' }, h('span', { class: 'muted', style: { width: '70px' } }, '已存在'), segmented([['skip', '跳过'], ['overwrite', '覆盖']], mode, (v) => { mode = v; })),
      h('div', { class: 'flex' }, h('span', { class: 'muted', style: { width: '70px' } }, '加入分组'), gp.el),
      errBox), [
      { label: '取消' },
      { label: '导入', primary: true, onClick: async () => {
        if (!text.value.trim()) { toast('内容为空', true); return false; }
        const r = await api('POST', '/api/admin/users/import', { text: text.value, mode, groups: gp.value });
        if (r.errors.length && !r.added && !r.updated) {
          put(errBox, ...r.errors.map((e) => h('div', null, e.line ? `第 ${e.line} 行：${e.message}` : e.message)));
          return false;
        }
        toast(`新增 ${r.added}，覆盖 ${r.updated}，跳过 ${r.skipped}` + (r.errors.length ? `，失败 ${r.errors.length}` : ''));
        reload();
      } },
    ], { wide: true });
  };

  const groupsDialog = () => {
    const list = h('div', { class: 'group', style: { boxShadow: 'none', background: 'var(--card2)' } });
    const draw = () => put(list, ...(groups.length ? groups.map((g) => h('div', { class: 'row' },
      h('div', { class: 'grow' }, g.name, h('span', { class: 'muted small' }, ` · ${g.users} 人`)),
      h('button', { class: 'small plain', onclick: () => renameGroup(g) }, '重命名'),
      h('button', { class: 'small plain danger', onclick: () => deleteGroup(g) }, '删除'))) : [h('div', { class: 'row muted' }, '暂无分组')]));
    const name = h('input', { type: 'text', class: 'grow', placeholder: '新分组名' });
    const add = async () => {
      if (!name.value.trim()) return;
      try { await api('POST', '/api/admin/groups', { name: name.value.trim() }); name.value = ''; await reload(); draw(); } catch (e) { fail(e); }
    };
    name.addEventListener('keydown', (e) => { if (e.key === 'Enter') add(); });
    const renameGroup = (g) => {
      const input = h('input', { type: 'text', class: 'full', value: g.name });
      modal('重命名分组', input, [{ label: '取消' }, { label: '保存', primary: true, onClick: async () => {
        await api('PUT', '/api/admin/groups/' + g.id, { name: input.value.trim() });
        await reload();
        draw();
      } }]);
    };
    const deleteGroup = async (g) => {
      if (!(await confirmBox('删除分组', `删除分组“${g.name}”？用户会保留。`, '删除', true))) return;
      try { await api('DELETE', '/api/admin/groups/' + g.id); await reload(); draw(); } catch (e) { fail(e); }
    };
    draw();
    modal('分组', h('div', { class: 'stack' }, list, h('div', { class: 'flex' }, name, h('button', { class: 'primary', onclick: add }, '添加'))), []);
  };

  render();
}

async function readText(file) {
  const buf = await file.arrayBuffer();
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { return new TextDecoder('gbk').decode(buf); }
}

// ============================================================ admin: settings

async function renderSettings(section) {
  let s = await api('GET', '/api/admin/settings');
  const main = shell('settings', h('div', { class: 'page-head' }, h('h2', null, '设置')));
  main.classList.add('narrow');
  const box = h('div');
  main.appendChild(box);

  const render = () => {
    const title = h('input', { type: 'text', class: 'full', value: s.siteTitle });
    const maxCode = h('input', { type: 'number', min: 1, value: s.maxCodeKiB });
    const root = h('input', { type: 'text', class: 'full', value: s.storageRoot, placeholder: s.effectiveStorageRoot });
    const lurl = h('input', { type: 'text', class: 'full', value: s.lemon.url, placeholder: 'http://127.0.0.1:8080' });
    const lpub = h('input', { type: 'text', class: 'full', value: s.lemon.publicUrl, placeholder: '可选，默认同 API 地址' });
    const lkey = h('input', { type: 'password', class: 'full', placeholder: s.lemon.apiKeySet ? `已设置（${s.lemon.apiKeyHint}），留空不修改` : 'lsk_…', autocomplete: 'off' });
    const lstate = h('span', { class: 'small' });

    const saveSection = async (body, msg = '已保存') => {
      try { s = await api('PUT', '/api/admin/settings', body); toast(msg); render(); } catch (e) { fail(e); }
    };
    const saveLemon = () => {
      const lemon = { url: lurl.value.trim(), publicUrl: lpub.value.trim() };
      if (lkey.value.trim()) lemon.apiKey = lkey.value.trim();
      return saveSection({ lemon });
    };
    const testLemon = async () => {
      lstate.className = 'small muted';
      lstate.textContent = '正在连接…';
      try {
        const r = await api('POST', '/api/admin/lemon/test', { url: lurl.value.trim(), apiKey: lkey.value.trim() });
        lstate.className = r.outdated ? 'small danger-text' : 'small ok-text';
        lstate.textContent = r.outdated ? `LemonServer ${r.version} 版本过旧，需要 0.1.6 或更高` : `已连接 LemonServer ${r.version} · ${r.contests} 个比赛`;
      } catch (e) {
        lstate.className = 'small danger-text';
        lstate.textContent = e.message;
      }
    };

    const cur = h('input', { type: 'password', class: 'full', autocomplete: 'current-password' });
    const pw1 = h('input', { type: 'password', class: 'full', autocomplete: 'new-password', placeholder: '至少 6 位' });
    const pw2 = h('input', { type: 'password', class: 'full', autocomplete: 'new-password' });
    const changePw = async () => {
      if (pw1.value !== pw2.value) return toast('两次输入的密码不一致', true);
      try {
        await api('PUT', '/api/admin/password', { current: cur.value, password: pw1.value });
        S.status.user.defaultPassword = false;
        toast('密码已修改');
        go('#/admin/settings');
      } catch (e) { fail(e); }
    };

    const m = s.manual;
    put(box, 
      h('div', { class: 'section-title' }, '常规'),
      h('div', { class: 'group' }, row('站点名称', title), row('代码长度上限', maxCode, h('span', { class: 'muted' }, 'KiB'))),
      h('div', { class: 'flex', style: { justifyContent: 'flex-end', marginTop: '8px' } },
        h('button', { class: 'small primary', onclick: () => saveSection({ siteTitle: title.value, maxCodeKiB: Number(maxCode.value) }) }, '保存')),

      h('div', { class: 'section-title' }, '存储位置'),
      h('div', { class: 'group' }, row('文件夹', root)),
      h('div', { class: 'flex', style: { marginTop: '8px' } },
        h('span', { class: 'section-foot grow', style: { margin: '0 4px' } }, '结构：比赛名/选手/…，修改后已有代码会一并移动'),
        h('button', { class: 'small primary', onclick: () => saveSection({ storageRoot: root.value.trim() }) }, '保存')),

      h('div', { class: 'section-title' }, '考生手册'),
      h('div', { class: 'group' }, h('div', { class: 'row' },
        h('div', { class: 'grow' }, m ? h('span', null, h('a', { href: '/api/manual', target: '_blank' }, m.name), h('span', { class: 'muted' }, ` · ${fmtSize(m.size)}`)) : h('span', { class: 'muted' }, '未上传')),
        h('button', { class: 'small', onclick: uploadManual }, m ? '替换' : '上传'),
        m ? h('button', { class: 'small danger', onclick: () => api('DELETE', '/api/admin/manual').then((r) => { s = r; render(); }, fail) }, '删除') : null)),
      h('div', { class: 'section-foot' }, '上传后，选手登录前需确认已阅读'),

      h('div', { class: 'section-title' }, 'LemonServer'),
      h('div', { class: 'group' }, row('API 地址', lurl), row('网页地址', lpub), row('API Key', lkey)),
      h('div', { class: 'section-foot' }, 'API Key 在 LemonServer“设置 → 令牌与 API Key”中创建；网页地址仅用于结果链接'),
      h('div', { class: 'flex', style: { marginTop: '8px' } }, lstate, h('div', { class: 'grow' }),
        h('button', { class: 'small', onclick: testLemon }, '测试连接'),
        h('button', { class: 'small primary', onclick: saveLemon }, '保存')),

      h('div', { class: 'section-title', id: 'password' }, '管理员密码'),
      h('div', { class: 'group' }, row('当前密码', cur), row('新密码', pw1), row('确认新密码', pw2)),
      h('div', { class: 'flex', style: { justifyContent: 'flex-end', marginTop: '8px' } },
        h('button', { class: 'small primary', onclick: changePw }, '修改密码')));

    if (section === 'password') setTimeout(() => { document.getElementById('password').scrollIntoView({ behavior: 'smooth' }); cur.focus(); }, 50);
  };

  const uploadManual = async () => {
    const f = await pickFile();
    if (!f) return;
    try {
      s = await api('PUT', '/api/admin/manual?name=' + enc(f.name), undefined, { raw: f });
      S.status.manual = true;
      toast('已上传');
      render();
    } catch (e) { fail(e); }
  };

  render();
}

// ============================================================ boot

(async function boot() {
  try {
    S.status = await api('GET', '/api/status', undefined, { noRedirect: true });
  } catch (e) {
    put($app, h('div', { class: 'empty' }, '无法连接服务器：' + e.message));
    return;
  }
  route();
})();
