/**
 * dist.test.js — 验证打包后的单文件 HTML 用 file:// 直接打开也能正常工作
 *
 *   node test/dist.test.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9226;
const FILE = path.join(__dirname, '..', 'dist', '速勤-考勤工作台.html');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
function ok(name, cond, extra) {
  if (cond) {
    pass++;
    console.log('  ok   ' + name + (extra !== undefined ? '  [' + extra + ']' : ''));
  } else {
    fail++;
    console.log('  FAIL ' + name + (extra !== undefined ? '  [' + extra + ']' : ''));
  }
}

(async () => {
  if (!fs.existsSync(FILE)) throw new Error('先运行 node build/build.js');
  const html = fs.readFileSync(FILE, 'utf8');
  ok('产物存在且 > 100KB', html.length > 100000, Math.round(html.length / 1024) + ' KB');
  ok('无外部脚本引用', !/<script[^>]+src=/i.test(html));
  ok('无外部样式引用', !/<link[^>]+stylesheet/i.test(html));
  ok('包含三份内联脚本', (html.match(/<script>/g) || []).length === 3);

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-dist-'));
  const edge = spawn(EDGE, [
    '--headless=new',
    '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + profile,
    '--no-first-run',
    '--disable-gpu',
    '--allow-file-access-from-files',
    '--window-size=1440,1000',
    'about:blank'
  ], { stdio: 'ignore' });

  let ws;
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json();
      const page = list.find((t) => t.type === 'page');
      if (page) {
        ws = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((res, rej) => {
          ws.addEventListener('open', res, { once: true });
          ws.addEventListener('error', rej, { once: true });
        });
        break;
      }
    } catch (e) {
      /* retry */
    }
    await sleep(200);
  }
  if (!ws) throw new Error('无法连接 Edge');

  let id = 0;
  const pending = new Map();
  const errors = [];
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      errors.push(msg.params.exceptionDetails.exception && msg.params.exceptionDetails.exception.description);
    }
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      errors.push('console.error: ' + (msg.params.args || []).map((a) => a.value).join(' '));
    }
  });
  const send = (method, params) => new Promise((resolve, reject) => {
    const i = ++id;
    pending.set(i, { resolve, reject });
    ws.send(JSON.stringify({ id: i, method, params: params || {} }));
    setTimeout(() => {
      if (pending.has(i)) {
        pending.delete(i);
        reject(new Error('timeout ' + method));
      }
    }, 15000);
  });
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error('页面异常: ' + JSON.stringify(r.exceptionDetails.exception));
    return r.result.value;
  };

  try {
    await send('Page.enable');
    await send('Runtime.enable');
    const url = 'file:///' + FILE.replace(/\\/g, '/');
    await send('Page.navigate', { url });
    await sleep(1500);

    ok('标题正确', (await ev('document.title')) === '速勤 · 班级考勤工作台');
    const info = await ev(`(() => ({
      students: document.querySelectorAll('#grid tbody tr[data-sid]').length,
      cells: document.querySelectorAll('#grid td.cell').length,
      saved: (document.querySelector('#saveState') || {}).textContent || '',
      ls: (() => { try { return Object.keys(localStorage).length; } catch (e) { return -1; } })()
    }))()`);
    ok('渲染出学生行', info.students === 8, info.students);
    ok('渲染出单元格', info.cells === 144, info.cells);
    ok('file:// 下 localStorage 可用', info.ls >= 1, info.ls + ' keys');

    // 点一个格子并标记
    const marked = await ev(`(() => {
      const td = document.querySelector('#grid td.cell[data-r="0"][data-c="0"]');
      const r = td.getBoundingClientRect();
      td.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: r.left + 5, clientY: r.top + 5 }));
      document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, clientX: r.left + 5, clientY: r.top + 5 }));
      const opt = document.querySelector('#popLayer [data-mark="late"]');
      if (!opt) return 'no-popover';
      opt.click();
      const td2 = document.querySelector('#grid td.cell[data-r="0"][data-c="0"]');
      return td2.querySelector('.chip') ? td2.querySelector('.chip').textContent : '';
    })()`);
    ok('点格子标记生效', marked === '迟', marked);

    await sleep(500);
    const persisted = await ev(`(() => { try { const raw = localStorage.getItem(SQCore.APP.dbKey); return raw ? JSON.parse(raw).classes.length : -1; } catch (e) { return -2; } })()`);
    ok('标记已落盘', persisted === 1, persisted);

    ok('无 JS 异常', errors.length === 0, errors.slice(0, 2).join(' | '));

    const shot = await send('Page.captureScreenshot', { format: 'png' });
    const shots = path.join(__dirname, 'shots');
    if (!fs.existsSync(shots)) fs.mkdirSync(shots, { recursive: true });
    fs.writeFileSync(path.join(shots, '13-dist-file.png'), Buffer.from(shot.data, 'base64'));
    console.log('  shot  13-dist-file.png');
  } finally {
    try {
      edge.kill();
    } catch (e) {
      /* ignore */
    }
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('失败：' + e.message);
  process.exit(1);
});
