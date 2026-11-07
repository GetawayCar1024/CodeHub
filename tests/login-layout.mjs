// Browser regressions: login layout, contest editing and timed material publication.
// Uses an installed Chromium browser (CHROME_BIN can override auto-detection).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { promises as fs, existsSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.js';

const browserPath = process.env.CHROME_BIN || [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
].find(existsSync);
assert.ok(browserPath, 'Install Chromium or set CHROME_BIN to run the browser regression');
const home = await fs.mkdtemp(path.join(os.tmpdir(), 'codehub-layout-'));
const app = createApp({ dataDir: path.join(home, 'data'), log() {} });
await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${app.server.address().port}`;
const portProbe = net.createServer();
await new Promise(resolve => portProbe.listen(0, '127.0.0.1', resolve));
const port = portProbe.address().port;
await new Promise(resolve => portProbe.close(resolve));
const browser = spawn(browserPath, ['--headless', '--disable-gpu', '--no-first-run', `--remote-debugging-port=${port}`, `--user-data-dir=${path.join(home, 'browser')}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
let browserError = '';
browser.stderr.on('data', data => { browserError = (browserError + data).slice(-8192); });
browser.on('error', error => { browserError += error.message; });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const alphaCode = '// 测试😀\r\n' + Array.from({ length: 48 }, (_, i) => `\t// line ${i + 1}`).join('\r\n') + '\r\n\r\n';
let socket, send;
try {
  let targets;
  for (let i = 0; i < 300 && !targets?.some(t => t.type === 'page'); i++) {
    if (browser.exitCode !== null || browser.signalCode !== null) break;
    targets = await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(1000) }).then(r => r.json()).catch(() => null);
    if (!targets?.some(t => t.type === 'page')) await delay(100);
  }
  assert.ok(targets?.some(t => t.type === 'page'), `Chromium did not start (${browserPath}; exit ${browser.exitCode}; signal ${browser.signalCode}):\n${browserError}`);
  socket = new WebSocket(targets.find(target => target.type === 'page').webSocketDebuggerUrl);
  await new Promise(resolve => socket.addEventListener('open', resolve, { once: true }));
  let id = 0;
  const requests = new Map();
  socket.addEventListener('message', event => {
    const response = JSON.parse(event.data), request = requests.get(response.id);
    if (!request) return;
    requests.delete(response.id);
    if (response.error) request.reject(new Error(JSON.stringify(response.error))); else request.resolve(response.result);
  });
  send = (method, params = {}) => new Promise((resolve, reject) => { requests.set(++id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); });
  const evaluate = async expression => {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    assert.ok(!result.exceptionDetails, JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const wait = async expression => {
    for (let i = 0; i < 240; i++) { if (await evaluate(expression)) return; await delay(50); }
    throw new Error('Browser condition timed out: ' + expression);
  };
  const copyFromViewer = async mode => {
    await wait('!!document.querySelector(".overlay .editor pre")');
    const lastLine = await evaluate(`(() => {
      const pre=document.querySelector('.overlay .editor pre'), gutter=document.querySelector('.overlay .gutter');
      pre.scrollTop=pre.scrollHeight;pre.dispatchEvent(new Event('scroll'));
      const text=gutter.firstChild,range=document.createRange();range.setStart(text,text.textContent.lastIndexOf('\\n')+1);range.setEnd(text,text.length);
      const line=range.getBoundingClientRect(),box=gutter.getBoundingClientRect();return {bottom:line.bottom,visibleBottom:box.bottom,top:line.top,visibleTop:box.top};
    })()`);
    assert.ok(lastLine.bottom <= lastLine.visibleBottom + 1 && lastLine.top >= lastLine.visibleTop - 1, `the trailing empty line must be fully visible: ${JSON.stringify(lastLine)}`);
    assert.ok(await evaluate(`[...document.querySelectorAll('.overlay button')].some(button=>button.textContent==='复制代码')`), 'the code viewer must have a copy button');
    await evaluate(`(() => {
      window.clipboardOriginal ||= {descriptor:Object.getOwnPropertyDescriptor(navigator,'clipboard'),exec:document.execCommand};
      window.copiedCode=null;
      const mode=${JSON.stringify(mode)};
      Object.defineProperty(navigator,'clipboard',{configurable:true,value:mode==='insecure'?undefined:{writeText:async text=>{if(mode!=='modern')throw new Error('permission denied');window.copiedCode=text;}}});
      document.execCommand=command=>{if(mode==='failed')return false;if(command==='copy'){window.copiedCode=document.activeElement.value;return true;}return false;};
      [...document.querySelectorAll('.overlay button')].find(button=>button.textContent==='复制代码').click();
    })()`);
    if (mode === 'failed') {
      await wait(`document.querySelector('.toasts').textContent.includes('复制失败')`);
      assert.equal(await evaluate('window.copiedCode'), null);
    } else {
      await wait('window.copiedCode !== null');
      assert.equal((await evaluate('window.copiedCode')).replace(/\r\n/g, '\n'), alphaCode.replace(/\r\n/g, '\n'));
    }
    assert.equal(await evaluate(`document.querySelector('.overlay .editor pre').textContent`), alphaCode);
    assert.ok(await evaluate(`!!document.querySelector('.overlay')`), 'copying must keep the viewer open');
    assert.equal(await evaluate(`document.querySelectorAll('textarea[data-clipboard-copy]').length`), 0);
    await wait(`[...document.querySelectorAll('.overlay button')].some(button=>button.textContent==='复制代码' && !button.disabled)`);
  };
  await send('Page.enable');
  await send('Page.navigate', { url: origin + '/#/login' });
  for (let i = 0; i < 100 && !await evaluate('!!document.querySelector(".login")'); i++) await delay(50);
  assert.ok(await evaluate('!!document.querySelector(".login")'));
  for (const [width, height] of [[1366, 768], [1280, 720], [1024, 600], [800, 450], [390, 844]]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    const dimensions = await evaluate(`(() => { const d=document.documentElement; const f=document.querySelector('.footer').getBoundingClientRect(); return {viewport: innerHeight, scroll: d.scrollHeight, width: d.scrollWidth, footerBottom:f.bottom}; })()`);
    assert.ok(dimensions.scroll <= height + 1, `${width}x${height}: unexpected vertical scrollbar: ${JSON.stringify(dimensions)}`);
    assert.ok(dimensions.width <= width + 1, `${width}x${height}: unexpected horizontal scrollbar`);
    assert.ok(dimensions.footerBottom <= height + 1, 'footer must fit the viewport');
    console.log(`PASS login fits ${width}x${height}`);
  }
  await send('Emulation.setDeviceMetricsOverride', { width: 800, height: 240, deviceScaleFactor: 1, mobile: false });
  const small = await evaluate(`(() => {const login=document.querySelector('.login');const button=login.querySelector('button.primary');button.scrollIntoView();const r=button.getBoundingClientRect();return {height:document.documentElement.scrollHeight, buttonTop:r.top, buttonBottom:r.bottom, position:getComputedStyle(button).position};})()`);
  assert.ok(small.height > 240, 'short windows must scroll instead of clipping the form');
  assert.ok(small.buttonTop >= 0 && small.buttonBottom <= 241, 'login button must remain reachable');
  console.log('PASS short login viewport stays scrollable and usable');
  for (const manual of [false, true]) {
    await evaluate(`S.status.manual=${manual};renderLogin()`);
    const gaps = await evaluate(`(() => {const items=[...document.querySelectorAll('.login .stack > *')].map(el=>el.getBoundingClientRect());return items.slice(1).map((r,i)=>Math.round((r.top-items[i].bottom)*10)/10);})()`);
    assert.ok(gaps.every(gap => Math.abs(gap - gaps[0]) < 0.6), `login fields and button must be evenly spaced: ${gaps}`);
  }
  await evaluate('S.status.manual=false;renderLogin()');
  console.log('PASS login fields and button are evenly spaced');
  await send('Emulation.setDeviceMetricsOverride', { width: 1024, height: 600, deviceScaleFactor: 1, mobile: false });
  await evaluate(`document.querySelector('.login input[type=text]').value='admin';document.querySelector('.login input[type=password]').value='123456';document.querySelector('form.login').requestSubmit()`);
  for (let i = 0; i < 200 && !await evaluate('!!document.querySelector(".user-btn")'); i++) await delay(25);
  assert.equal(await evaluate('document.querySelector("#app").classList.contains("login-page")'), false, 'signed-in pages must not inherit login layout');
  const contestId = await evaluate(`(async () => {
    const call=async (url,body)=>{const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json','X-CodeHub':'1'},body:JSON.stringify(body)});if(!r.ok)throw new Error('Fixture HTTP '+r.status);return r.json();};
    await call('/api/admin/users/import',{text:'alice,test-password'});
    return (await call('/api/admin/contests',{name:'ui-rename',startTime:Date.now()+3600000,endTime:Date.now()+7200000,problems:[{name:'alpha'},{name:'beta'}]})).id;
  })()`);
  const contest = app.ctx.contest(contestId), user = app.ctx.data.users.find(u => u.username === 'alice');
  const submissions = { alpha: { time: Date.now(), size: Buffer.byteLength(alphaCode), count: 2, lang: 'C++' }, beta: { time: Date.now(), size: 6, count: 1, lang: 'C++' } };
  app.ctx.data.submissions[contestId] = { [user.id]: submissions };
  await fs.mkdir(path.dirname(app.ctx.submissionFile(contest, 'alice', 'alpha')), { recursive: true });
  await fs.writeFile(app.ctx.submissionFile(contest, 'alice', 'alpha'), alphaCode);
  await fs.writeFile(app.ctx.submissionFile(contest, 'alice', 'beta'), 'beta!\n');
  await evaluate(`location.hash='#/admin/c/${contestId}/edit'`);
  for (let i = 0; i < 200 && !await evaluate('document.querySelectorAll(".prow").length === 2'); i++) await delay(25);
  await evaluate(`(() => {
    const rows=document.querySelectorAll('.prow');
    for(const [i,name] of ['new-alpha','new-beta'].entries()){const input=rows[i].querySelector('input');input.value=name;input.dispatchEvent(new Event('input',{bubbles:true}));}
  })()`);
  // Drag the second row's handle above the first one with real mouse input.
  const dragPoints = await evaluate(`(() => {
    document.querySelector('.problem-rows').scrollIntoView({block:'center'});
    const [a,b]=[...document.querySelectorAll('.prow')].map(row=>row.getBoundingClientRect());
    const handle=document.querySelectorAll('.prow .drag-handle')[1].getBoundingClientRect();
    return {x:handle.left+handle.width/2,y:handle.top+handle.height/2,targetY:a.top+2};
  })()`);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: dragPoints.x, y: dragPoints.y, button: 'left', buttons: 1, clickCount: 1 });
  for (const y of [dragPoints.y - 10, dragPoints.targetY + 6, dragPoints.targetY])
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: dragPoints.x, y, button: 'left', buttons: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: dragPoints.x, y: dragPoints.targetY, button: 'left', buttons: 0, clickCount: 1 });
  assert.deepEqual(await evaluate(`[...document.querySelectorAll('.prow')].map(row=>[row.querySelector('.idx').textContent,row.querySelectorAll('input')[0].value,row.querySelectorAll('input')[1].value])`),
    [['1', 'new-beta', ''], ['2', 'new-alpha', '']], 'dragging must reorder rows without bringing back the old names as display titles');
  // Keyboard on the handle moves the row too; move it down and back up again.
  await evaluate(`document.querySelectorAll('.prow .drag-handle')[0].dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}))`);
  await evaluate(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowUp',bubbles:true}))`);
  assert.deepEqual(await evaluate(`[...document.querySelectorAll('.prow')].map(row=>row.querySelector('input').value)`), ['new-beta', 'new-alpha']);
  await evaluate(`document.querySelector('.page-head button.primary').click()`);
  for (let i = 0; i < 200 && contest.problems[0].name !== 'new-beta'; i++) await delay(25);
  assert.deepEqual(contest.problems.map(p => p.name), ['new-beta', 'new-alpha']);
  assert.equal(await fs.readFile(app.ctx.submissionFile(contest, 'alice', 'new-alpha'), 'utf8'), alphaCode);
  assert.equal(await fs.readFile(app.ctx.submissionFile(contest, 'alice', 'new-beta'), 'utf8'), 'beta!\n');
  assert.equal(app.ctx.data.submissions[contestId][user.id]['new-alpha'].count, 2);
  assert.deepEqual(contest.problems.map(p => p.title), ['new-beta', 'new-alpha'], 'renamed problems without a custom title must not keep the old name');
  console.log('PASS contest editor renames the corresponding submissions after reordering');
  for (let i = 0; i < 200 && !await evaluate(`location.hash === '#/admin/c/${contestId}' && !!document.querySelector('.user-btn')`); i++) await delay(25);

  await evaluate(`api('POST','/api/admin/users/import',{text:'bob,test-password,Anna\\ncharlie,test-password,Mike'})`);
  const extraUsers = app.ctx.data.users.filter(item => ['bob', 'charlie'].includes(item.username));
  const originalName = user.realName, originalRemote = app.ctx.lemon.rt(contest).remote;
  const originalStatus = app.ctx.lemon.status.bind(app.ctx.lemon);
  user.realName = 'Zoe';
  // Real board API, with only the external judging response replaced by a deterministic fixture.
  app.ctx.lemon.rt(contest).remote = {
    tasks: contest.problems.map(problem => ({ sourceFileName: problem.name, totalScore: 100 })),
    contestants: [user, ...extraUsers].map(item => ({ name: item.username, tasks: (item.username === 'alice' ? [90, 10] : item.username === 'bob' ? [50, 90] : [null, null]).map(score => ({ score, judged: score !== null, compileState: 0 })) })),
  };
  for (const extra of extraUsers) app.ctx.data.submissions[contestId][extra.id] = {
    'new-beta': { time: Date.now(), size: 6, count: 1, lang: 'C++' },
    'new-alpha': { time: Date.now(), size: 7, count: 1, lang: 'C++' },
  };
  app.ctx.lemon.status = async value => value.id === contestId ? { linked: true, configured: true, reachable: true, contest: 'fixture', history: [], link: '#' } : originalStatus(value);
  await evaluate('route()');
  await wait('!!document.querySelector("[data-sort=total]")');
  const order = () => evaluate(`[...document.querySelectorAll('tbody tr[data-user]')].map(row=>row.dataset.user)`);
  const icon = key => evaluate(`document.querySelector('[data-sort="${key}"] .sort-icon').className`);
  assert.equal(await icon('username'), 'sort-icon asc');
  assert.equal(await icon('total'), 'sort-icon');
  await evaluate(`document.querySelector('[data-sort=total]').click()`);
  assert.deepEqual(await order(), ['bob', 'alice', 'charlie']);
  assert.equal(await icon('total'), 'sort-icon desc');
  assert.equal(await icon('username'), 'sort-icon');
  await evaluate(`document.querySelector('[data-sort="problem:new-beta"]').click()`);
  assert.deepEqual(await order(), ['alice', 'bob', 'charlie']);
  await evaluate(`document.querySelector('[data-sort="problem:new-beta"]').click()`);
  assert.deepEqual(await order(), ['bob', 'alice', 'charlie']);
  await evaluate(`document.querySelector('[data-sort=realName]').click()`);
  assert.deepEqual(await order(), ['bob', 'charlie', 'alice']);
  await evaluate(`document.querySelector('[data-sort=username]').click()`);
  assert.deepEqual(await order(), ['alice', 'bob', 'charlie']);
  const cell = `[data-cell="${user.id}|new-alpha"]`;
  assert.equal(await evaluate(`!!document.querySelector('.selected, [aria-selected]') || [...document.querySelectorAll('.page-head button')].some(button=>button.textContent==='查看代码')`), false, 'the board has no cell selection');
  await evaluate(`document.querySelector(${JSON.stringify(cell)}).click()`);
  await wait('!!document.querySelector(".overlay .editor pre")');
  await evaluate(`document.querySelector('.overlay .modal-head button').click()`);
  user.realName = originalName; app.ctx.lemon.status = originalStatus; app.ctx.lemon.rt(contest).remote = originalRemote;
  app.ctx.data.users = app.ctx.data.users.filter(item => !extraUsers.includes(item));
  for (const extra of extraUsers) delete app.ctx.data.submissions[contestId][extra.id];
  await evaluate('route()');
  console.log('PASS board score/name ordering, sort indicators and click-to-view');

  await evaluate(`adminSource({id:${contestId}},{id:${user.id},username:'alice'},{name:'new-alpha'})`);
  await copyFromViewer('modern');
  await copyFromViewer('denied');
  await evaluate(`document.querySelector('.overlay .modal-head button').click()`);
  console.log('PASS admin code copy uses the clipboard and falls back when permission is denied');

  await evaluate(`location.hash='#/admin/c/${contestId}/edit'`);
  await wait('!!document.querySelector("input[name=downZipReleaseMinutes]")');
  await evaluate(`(() => {const input=document.querySelector('input[name=downZipReleaseMinutes]');input.value='31';input.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('.page-head button.primary').click();})()`);
  await wait('document.querySelector(".toasts").textContent.includes("须满足")');
  assert.equal(contest.downZipReleaseMinutes, 30, 'invalid order must not save');
  await evaluate(`(() => {
    for(const [name,value] of Object.entries({earlyMinutes:30,downZipReleaseMinutes:20,passwordReleaseMinutes:10,downZipPassword:'ui-release-secret'})) {
      const input=document.querySelector('input[name='+name+']');input.value=String(value);input.dispatchEvent(new Event('input',{bubbles:true}));
    }
    pickFile=async()=>new File(['PK-ui-material'], 'down.zip', {type:'application/zip'});
    [...document.querySelectorAll('button')].find(button=>button.textContent==='上传').click();
  })()`);
  await wait('document.querySelector("main").textContent.includes("保存后上传")');
  assert.equal(contest.downZip, null, 'choosing a file must not upload under the old schedule');
  await evaluate(`document.querySelector('.page-head button.primary').click()`);
  for (let i = 0; i < 240 && !contest.downZip; i++) await delay(25);
  assert.ok(contest.downZip, 'the chosen file must upload after saving');
  assert.deepEqual([contest.downZipReleaseMinutes, contest.passwordReleaseMinutes], [20, 10]);
  assert.equal(await fs.readFile(app.ctx.downZipFile(contest), 'utf8'), 'PK-ui-material');
  await wait(`location.hash === '#/admin/c/${contestId}' && !!document.querySelector('.user-btn')`);
  console.log('PASS material settings reject invalid order and save before uploading');

  const contestsBeforeCreate = app.ctx.data.contests.length;
  await evaluate(`location.hash='#/admin/new'`);
  await wait('!!document.querySelector(".prow input")');
  await evaluate(`(() => {
    const set=(input,value)=>{input.value=value;input.dispatchEvent(new Event('input',{bubbles:true}));};
    set(document.querySelector('input[placeholder^="作为文件夹名"]'),'ui-create-release');
    set(document.querySelector('.prow input'),'sum');
    set(document.querySelector('input[name=downZipReleaseMinutes]'),'20');
    set(document.querySelector('input[name=passwordReleaseMinutes]'),'10');
    set(document.querySelector('input[name=downZipPassword]'),'new-secret');
    [...document.querySelectorAll('button')].find(button=>button.textContent==='上传').click();
  })()`);
  await wait('document.querySelector("main").textContent.includes("保存后上传")');
  assert.equal(app.ctx.data.contests.length, contestsBeforeCreate, 'choosing a file must not create a contest');
  await evaluate(`(() => {
    const original=window.fetch;
    window.fetch=async (...args)=>{
      if(typeof args[0]==='string' && args[0].includes('/downzip?')) {
        window.fetch=original;
        return new Response(JSON.stringify({error:'fixture upload failure'}),{status:503,headers:{'Content-Type':'application/json'}});
      }
      return original(...args);
    };
    document.querySelector('.page-head button.primary').click();
  })()`);
  await wait('document.querySelector(".toasts").textContent.includes("fixture upload failure")');
  const createdContest = app.ctx.data.contests.find(c => c.name === 'ui-create-release');
  assert.ok(createdContest);
  assert.equal(createdContest.downZip, null);
  await evaluate(`document.querySelector('.page-head button.primary').click()`);
  await wait(`location.hash === '#/admin/c/${createdContest.id}'`);
  assert.equal(app.ctx.data.contests.length, contestsBeforeCreate + 1, 'retry must not create a duplicate contest');
  assert.ok(createdContest.downZip, 'the prepared file must upload when the save is retried');
  console.log('PASS new contest can prepare a ZIP/password and retry a failed upload');

  await evaluate(`document.querySelector('.user-btn').click();[...document.querySelectorAll('.menu .item')].find(e=>e.textContent.includes('退出登录')).click()`);
  for (let i = 0; i < 200 && !await evaluate('!!document.querySelector(".login")'); i++) await delay(25);
  assert.equal(await evaluate('document.querySelector("#app").classList.contains("login-page")'), true);
  assert.ok(await evaluate('document.documentElement.scrollHeight <= 601'));
  console.log('PASS login/logout restores the correct page layout');

  contest.startTime = Date.now() + 25 * 60000;
  contest.endTime = contest.startTime + 3600000;
  await evaluate(`document.querySelector('.login input[type=text]').value='alice';document.querySelector('.login input[type=password]').value='test-password';document.querySelector('form.login').requestSubmit()`);
  await wait('!!document.querySelector(".user-btn") && !document.querySelector(".login")');
  await evaluate(`location.hash='#/c/${contestId}'`);
  await wait('!!document.querySelector("[data-material=downzip]")');
  assert.ok(await evaluate('!!document.querySelector("[data-problems-pending]")'));
  assert.equal(await evaluate(`document.body.textContent.includes('new-alpha') || !!document.querySelector('.problem .title')`), false);
  assert.ok(await evaluate(`document.querySelector('[data-material=downzip]').textContent.includes('待下发')`));
  assert.ok(await evaluate(`document.querySelector('[data-material=password]').textContent.includes('待公布')`));
  assert.equal(await evaluate(`!!document.querySelector('[data-material=downzip] a') || document.body.textContent.includes('ui-release-secret')`), false);
  // No reload or click: the open page must pick up both releases while still before the start.
  contest.startTime = Date.now() + 20 * 60000 + 1800;
  await wait('!!document.querySelector("[data-material=downzip] a")');
  assert.ok(await evaluate(`document.querySelector('[data-material=password]').textContent.includes('待公布')`));
  assert.ok(await evaluate('!!document.querySelector("[data-problems-pending]")'));
  contest.startTime = Date.now() + 10 * 60000 + 1800;
  await wait(`document.querySelector('[data-material=password]').textContent === 'ui-release-secret'`);
  assert.equal(await evaluate(`document.querySelector('.countdown .lbl').textContent`), '距离开始');
  await wait('document.querySelectorAll(".problem .title").length === 2');
  assert.equal(await evaluate('!!document.querySelector("[data-problems-pending]")'), false);
  await evaluate(`(() => {const card=[...document.querySelectorAll('.problem')].find(item=>item.querySelector('.title').textContent.includes('new-alpha'));[...card.querySelectorAll('button')].find(button=>button.textContent==='查看代码').click();})()`);
  await copyFromViewer('insecure');
  await copyFromViewer('failed');
  await evaluate(`document.querySelector('.overlay .modal-head button').click()`);
  console.log('PASS contestant code copy supports HTTP fallback and reports failure without losing the code');

  contest.startTime = Date.now() + 15 * 60000;
  contest.downZipPassword = '';
  await evaluate(`[...document.querySelectorAll('button')].find(button=>button.textContent==='刷新页面').click()`);
  await wait('!!document.querySelector("[data-problems-pending]")');
  assert.equal(await evaluate(`document.querySelector('[data-material=password]').textContent`), '未设置密码');
  contest.startTime = Date.now() + 10 * 60000 + 1800;
  await wait('document.querySelectorAll(".problem .title").length === 2');
  assert.equal(await evaluate(`document.querySelector('[data-material=password]').textContent`), '未设置密码');
  console.log('PASS problem names release automatically on the password schedule, even with no password');
  contest.downZip = null; contest.downZipPassword = '';
  await wait(`document.querySelector('[data-material=downzip]').textContent === '未设置 down.zip' && document.querySelector('[data-material=password]').textContent === '未设置密码'`);
  console.log('PASS separate pending/unset messages and automatic pre-start release');
} finally {
  if (send) await Promise.race([send('Browser.close').catch(() => {}), delay(500)]);
  socket?.close(); browser.kill(); app.stop();
  app.server.closeAllConnections();
  await new Promise(resolve => app.server.close(resolve));
  await delay(200);
  await fs.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
