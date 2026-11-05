// Browser regressions: login layout and the real contest editor's rename/reorder flow.
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
  const submissions = { alpha: { time: Date.now(), size: 7, count: 2, lang: 'C++' }, beta: { time: Date.now(), size: 6, count: 1, lang: 'C++' } };
  app.ctx.data.submissions[contestId] = { [user.id]: submissions };
  await fs.mkdir(path.dirname(app.ctx.submissionFile(contest, 'alice', 'alpha')), { recursive: true });
  await fs.writeFile(app.ctx.submissionFile(contest, 'alice', 'alpha'), 'alpha\r\n');
  await fs.writeFile(app.ctx.submissionFile(contest, 'alice', 'beta'), 'beta!\n');
  await evaluate(`location.hash='#/admin/c/${contestId}/edit'`);
  for (let i = 0; i < 200 && !await evaluate('document.querySelectorAll(".prow").length === 2'); i++) await delay(25);
  await evaluate(`(() => {
    const rows=document.querySelectorAll('.prow');
    for(const [i,name] of ['new-alpha','new-beta'].entries()){const input=rows[i].querySelector('input');input.value=name;input.dispatchEvent(new Event('input',{bubbles:true}));}
    rows[1].querySelector('button').click();
    document.querySelector('.page-head button.primary').click();
  })()`);
  for (let i = 0; i < 200 && contest.problems[0].name !== 'new-beta'; i++) await delay(25);
  assert.deepEqual(contest.problems.map(p => p.name), ['new-beta', 'new-alpha']);
  assert.equal(await fs.readFile(app.ctx.submissionFile(contest, 'alice', 'new-alpha'), 'utf8'), 'alpha\r\n');
  assert.equal(await fs.readFile(app.ctx.submissionFile(contest, 'alice', 'new-beta'), 'utf8'), 'beta!\n');
  assert.equal(app.ctx.data.submissions[contestId][user.id]['new-alpha'].count, 2);
  console.log('PASS contest editor renames the corresponding submissions after reordering');
  for (let i = 0; i < 200 && !await evaluate(`location.hash === '#/admin/c/${contestId}' && !!document.querySelector('.user-btn')`); i++) await delay(25);
  await evaluate(`document.querySelector('.user-btn').click();[...document.querySelectorAll('.menu .item')].find(e=>e.textContent.includes('退出登录')).click()`);
  for (let i = 0; i < 200 && !await evaluate('!!document.querySelector(".login")'); i++) await delay(25);
  assert.equal(await evaluate('document.querySelector("#app").classList.contains("login-page")'), true);
  assert.ok(await evaluate('document.documentElement.scrollHeight <= 601'));
  console.log('PASS login/logout restores the correct page layout');
} finally {
  if (send) await Promise.race([send('Browser.close').catch(() => {}), delay(500)]);
  socket?.close(); browser.kill(); app.stop();
  app.server.closeAllConnections();
  await new Promise(resolve => app.server.close(resolve));
  await delay(200);
  await fs.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
