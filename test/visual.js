/**
 * visual.js — 桌面 / 移动端截图与布局体检
 *
 *   node test/visual.js
 *
 * 输出：test/shots/*.png，以及各视图的关键尺寸指标。
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..', 'src');
const SHOTS = path.join(__dirname, 'shots');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9224;
const HTTP_PORT = 8100;

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png' };

function serve() {
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      const p = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]) === '/' ? 'index.html' : decodeURIComponent(req.url.split('?')[0]));
      if (!p.startsWith(ROOT) || !fs.existsSync(p)) {
        res.writeHead(404);
        res.end('not found');
        return;
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream' });
      res.end(fs.readFileSync(p));
    });
    s.listen(HTTP_PORT, '127.0.0.1', () => resolve(s));
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function getJson(url) {
  const res = await fetch(url);
  return res.json();
}

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      }
    });
  }
  send(method, params) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params: params || {} }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error('timeout ' + method));
        }
      }, 15000);
    });
  }
}

async function connect() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await getJson('http://127.0.0.1:' + PORT + '/json/list');
      const page = list.find((t) => t.type === 'page');
      if (page) {
        const ws = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((res, rej) => {
          ws.addEventListener('open', res, { once: true });
          ws.addEventListener('error', rej, { once: true });
        });
        return new CDP(ws);
      }
    } catch (e) {
      /* retry */
    }
    await sleep(200);
  }
  throw new Error('无法连接 Edge CDP');
}

async function evalJs(c, expr) {
  const r = await c.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error('页面异常: ' + JSON.stringify(r.exceptionDetails.exception && r.exceptionDetails.exception.description));
  return r.result.value;
}

async function shot(c, name) {
  await sleep(260);
  const r = await c.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const file = path.join(SHOTS, name);
  fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
  console.log('  shot  ' + name + '  (' + Math.round(fs.statSync(file).size / 1024) + ' KB)');
}

async function metrics(c, label) {
  const m = await evalJs(c, `(() => {
    const g = document.querySelector('#gridWrap');
    return {
      vw: innerWidth, vh: innerHeight,
      docW: document.documentElement.scrollWidth,
      pageOverflowX: document.documentElement.scrollWidth - innerWidth,
      gridClient: g ? g.clientWidth : 0,
      gridScroll: g ? g.scrollWidth : 0,
      sticky: !!document.querySelector('.grid thead th'),
      colName: getComputedStyle(document.documentElement).getPropertyValue('--col-name').trim(),
      topbarH: Math.round((document.querySelector('.topbar') || {}).offsetHeight || 0),
      rowH: Math.round((document.querySelector('#grid td.cell') || {}).offsetHeight || 0),
      sideW: Math.round((document.querySelector('.sidebar') || {}).offsetWidth || 0),
      sitem: document.querySelectorAll('#classTabs .sitem').length,
      gchip: document.querySelectorAll('#groupTabs .gchip').length,
      summary: ((document.querySelector('#sideSummary') || {}).textContent || '').replace(/\\s+/g, ' ').slice(0, 40),
      save: ((document.querySelector('#saveState') || {}).textContent || '').trim()
    };
  })()`);
  console.log('  ' + label + '  ' + JSON.stringify(m));
  return m;
}

(async () => {
  if (!fs.existsSync(SHOTS)) fs.mkdirSync(SHOTS, { recursive: true });
  const TARGET = process.env.URL || ('http://127.0.0.1:' + HTTP_PORT + '/');
  const server = process.env.URL ? null : await serve();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-visual-'));
  const edge = spawn(EDGE, [
    '--headless=new',
    '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + profile,
    '--no-first-run',
    '--disable-gpu',
    '--window-size=1440,1000',
    'about:blank'
  ], { stdio: 'ignore' });

  try {
    const c = await connect();
    await c.send('Page.enable');
    await c.send('Runtime.enable');
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    await c.send('Page.navigate', { url: TARGET });
    await sleep(1200);

    console.log('\n桌面 1440');
    await metrics(c, 'grid');
    await shot(c, '01-grid-light.png');

    // 单元格标记面板
    await evalJs(c, `(() => {
      const td = document.querySelector('#grid td.cell[data-r="2"][data-c="3"]');
      const r = td.getBoundingClientRect();
      td.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: r.left + 8, clientY: r.top + 8 }));
      document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, clientX: r.left + 8, clientY: r.top + 8 }));
      return !!document.querySelector('#popLayer .pop');
    })()`);
    await shot(c, '02-cell-popover.png');
    await evalJs(c, `(() => { const b = document.querySelector('#popLayer .pop-backdrop'); if (b) b.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); return true; })()`);

    // 统计
    await evalJs(c, `document.querySelector('#btnStats').click();`);
    await metrics(c, 'stats');
    await shot(c, '03-stats.png');
    await evalJs(c, `document.querySelector('#btnStats').click();`);

    // 深色
    await evalJs(c, `document.querySelector('#btnTheme').click();`);
    await shot(c, '04-grid-dark.png');
    await evalJs(c, `document.querySelector('#btnTheme').click();`);

    // 点名
    await evalJs(c, `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));`);
    await shot(c, '05-roll.png');
    await evalJs(c, `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));`);

    // 导入
    await evalJs(c, `document.querySelector('#btnImport').click();`);
    await shot(c, '06-import.png');
    await evalJs(c, `document.querySelector('#modalLayer [data-close]').click();`);

    // 设置
    await evalJs(c, `document.querySelector('#btnSettings').click();`);
    await shot(c, '07-settings.png');
    await evalJs(c, `document.querySelector('#modalLayer [data-close]').click();`);

    // 帮助
    await evalJs(c, `document.querySelector('#btnHelp').click();`);
    await shot(c, '08-help.png');
    await evalJs(c, `document.querySelector('#modalLayer [data-close]').click();`);

    console.log('\n窄屏兜底 1180×800');
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1180, height: 800, deviceScaleFactor: 1, mobile: false });
    await sleep(400);
    const narrow = await metrics(c, 'grid');
    await shot(c, '09-narrow-grid.png');

    await evalJs(c, `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));`);
    await shot(c, '10-narrow-roll.png');
    await evalJs(c, `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));`);

    await c.send('Emulation.clearDeviceMetricsOverride');

    console.log('\n结论');
    console.log('  页面级横向溢出：' + (narrow.pageOverflowX > 0 ? '有 ' + narrow.pageOverflowX + 'px（需修）' : '无'));
    console.log('  表格横向滚动：' + (narrow.gridScroll > narrow.gridClient ? '有（正常）' : '无'));
    console.log('  左栏：' + narrow.sideW + 'px，班级项 ' + narrow.sitem + '，小组项 ' + narrow.gchip);
  } finally {
    try {
      edge.kill();
    } catch (e) {
      /* ignore */
    }
    if (server) server.close();
  }
})().catch((e) => {
  console.error('失败：' + e.message);
  process.exit(1);
});
