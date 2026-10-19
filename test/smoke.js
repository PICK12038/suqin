/**
 * smoke.js — 用本机 Edge 的 headless 模式做端到端冒烟测试
 *
 * 做三件事：
 *  1. 起一个静态服务器托管 src/
 *  2. 用 CDP 打开页面，收集 JS 异常 / console.error
 *  3. 模拟「点格子 → 点状态」「按数字键」「切周」等真实操作，断言 DOM 与 localStorage
 *
 * 只依赖 Node 内置模块（node 24 自带 WebSocket）。
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..', 'src');
const PORT = 8099;
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const DB_KEY = 'suqin_db_v1';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml'
};

function serve() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let p = decodeURIComponent(req.url.split('?')[0]);
      if (p === '/') p = '/index.html';
      const file = path.join(ROOT, path.normalize(p).replace(/^([/\\])+/, ''));
      if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        res.writeHead(404); res.end('not found'); return;
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      fs.createReadStream(file).pipe(res);
    });
    srv.listen(PORT, '127.0.0.1', () => resolve(srv));
  });
}

function jget(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitTarget(port, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      const list = await jget(`http://127.0.0.1:${port}/json/list`);
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch (e) { /* not up yet */ }
    await sleep(250);
  }
  throw new Error('CDP target not found');
}

function cdp(ws) {
  let id = 0;
  const pending = new Map();
  const events = [];
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message)); else resolve(msg.result);
    } else if (msg.method) {
      events.push(msg);
    }
  });
  return {
    events,
    send(method, params = {}) {
      return new Promise((resolve, reject) => {
        const mid = ++id;
        pending.set(mid, { resolve, reject });
        ws.send(JSON.stringify({ id: mid, method, params }));
      });
    }
  };
}

function summarize(events) {
  const out = { exceptions: [], consoleErrors: [], failedRequests: [] };
  for (const e of events) {
    if (e.method === 'Runtime.exceptionThrown') {
      const d = e.params.exceptionDetails;
      out.exceptions.push((d.exception && (d.exception.description || d.exception.value)) || d.text);
    }
    if (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error') {
      out.consoleErrors.push(e.params.args.map((a) => a.description || a.value).join(' '));
    }
    if (e.method === 'Network.loadingFailed') {
      out.failedRequests.push(e.params.errorText + ' ' + (e.params.requestId || ''));
    }
  }
  return out;
}

async function evaluate(c, expression) {
  const r = await c.send('Runtime.evaluate', {
    expression, returnByValue: true, awaitPromise: true,
    userGesture: true
  });
  if (r.exceptionDetails) {
    throw new Error(r.exceptionDetails.text + ' ' +
      ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || ''));
  }
  return r.result.value;
}

(async () => {
  const srv = await serve();
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'suqin-edge-'));
  const edge = spawn(EDGE, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--disable-background-networking',
    '--remote-debugging-port=9222',
    '--user-data-dir=' + userDir,
    '--window-size=1440,900',
    'about:blank'
  ], { stdio: 'ignore' });

  const results = [];
  const ok = (name, cond, extra) => {
    results.push({ name, pass: !!cond, extra: extra || '' });
  };

  try {
    const target = await waitTarget(9222);
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res);
      ws.addEventListener('error', rej);
    });
    const c = cdp(ws);
    await c.send('Runtime.enable');
    await c.send('Log.enable');
    await c.send('Page.enable');
    await c.send('Network.enable');
    // 桌面尺寸：headless 默认窗口常是 800×600，会让表格落到窄屏兜底布局里
    await c.send('Emulation.setDeviceMetricsOverride', {
      width: 1440, height: 900, deviceScaleFactor: 1, mobile: false
    });

    await c.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/index.html` });
    await sleep(1800);

    // ---- 基础渲染 ----
    const base = await evaluate(c, `(() => {
      const q = (s) => document.querySelector(s);
      return {
        title: document.title,
        classTabs: document.querySelectorAll('#classTabs [data-class]').length,
        groupTabs: document.querySelectorAll('#groupTabs [data-group]').length,
        rows: document.querySelectorAll('#grid tbody tr[data-sid]').length,
        cells: document.querySelectorAll('#grid td.cell').length,
        dayHeads: document.querySelectorAll('#grid th.day').length,
        week: (q('#weekLabel') || {}).textContent,
        range: (q('#weekRange') || {}).textContent,
        saved: (q('#saveState') || {}).textContent,
        ls: !!localStorage.getItem('${DB_KEY}'),
        gridHidden: q('#viewGrid').hidden,
        statsHidden: q('#viewStats').hidden,
        demoHidden: q('#demoBanner').hidden,
        tableW: q('#grid') ? q('#grid').offsetWidth : 0,
        scrollW: q('#gridWrap') ? q('#gridWrap').scrollWidth : 0
      };
    })()`);
    ok('页面标题', base.title.includes('速勤'), base.title);
    ok('班级标签', base.classTabs >= 1, base.classTabs);
    ok('小组标签', base.groupTabs === 4, base.groupTabs);
    ok('学生行', base.rows === 8, base.rows);
    ok('单元格', base.cells === 8 * 6 * 3, base.cells + ' (期望 144)');
    ok('日期表头', base.dayHeads === 6, base.dayHeads);
    ok('周标题', /^第 \d+ 周$/.test(base.week || ''), base.week);
    ok('已保存', /已保存/.test(base.saved || ''), base.saved);
    ok('localStorage 写入', base.ls === true);
    ok('表格视图可见', base.gridHidden === false);
    ok('统计视图隐藏', base.statsHidden === true, 'hidden=' + base.statsHidden);
    ok('演示提示可见', base.demoHidden === false, 'hidden=' + base.demoHidden);

    // ---- 点格子 → 点「迟到」 ----
    const clickRes = await evaluate(c, `(() => {
      const td = document.querySelector('#grid td.cell[data-r="0"][data-c="0"]');
      if (!td) return { error: 'no cell' };
      const r = td.getBoundingClientRect();
      td.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: r.left + 5, clientY: r.top + 5 }));
      document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, clientX: r.left + 5, clientY: r.top + 5 }));
      const pop = document.querySelector('#popLayer .pop');
      const opt = pop && pop.querySelector('[data-mark="late"]');
      if (opt) opt.click();
      const td2 = document.querySelector('#grid td.cell[data-r="0"][data-c="0"]');
      return {
        popOpened: !!pop,
        hasChip: !!td2.querySelector('.chip'),
        chip: td2.querySelector('.chip') ? td2.querySelector('.chip').textContent : '',
        popClosed: !document.querySelector('#popLayer .pop')
      };
    })()`);
    ok('点格子打开面板', clickRes.popOpened);
    ok('标记迟到生效', clickRes.hasChip && clickRes.chip === '迟', clickRes.chip);
    ok('面板自动关闭', clickRes.popClosed);

    // ---- 键盘：选中后按 3 ----
    const keyRes = await evaluate(c, `(() => {
      const td = document.querySelector('#grid td.cell[data-r="1"][data-c="1"]');
      const r = td.getBoundingClientRect();
      td.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: r.left + 5, clientY: r.top + 5 }));
      document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, clientX: r.left + 5, clientY: r.top + 5 }));
      // pointerup 会弹出标记面板，用 backdrop 的 pointerdown 关掉（不清选区）
      const back = document.querySelector('#popLayer .pop-backdrop');
      if (back) back.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      const st = !!document.querySelector('#grid td.cell.active');
      document.dispatchEvent(new KeyboardEvent('keydown', { key: '3', bubbles: true }));
      const td2 = document.querySelector('#grid td.cell[data-r="1"][data-c="1"]');
      return { active: st, chip: td2.querySelector('.chip') ? td2.querySelector('.chip').textContent : '' };
    })()`);
    ok('键盘前有活动格', keyRes.active);
    ok('数字键 3 = 病假', keyRes.chip === '病', keyRes.chip);

    // ---- 拖选批量 ----
    const dragRes = await evaluate(c, `(() => {
      const a = document.querySelector('#grid td.cell[data-r="2"][data-c="0"]');
      const b = document.querySelector('#grid td.cell[data-r="3"][data-c="2"]');
      const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
      a.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: ra.left + 5, clientY: ra.top + 5 }));
      document.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: rb.left + 5, clientY: rb.top + 5 }));
      document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, clientX: rb.left + 5, clientY: rb.top + 5 }));
      const sel = document.querySelectorAll('#grid td.cell.sel').length;
      document.dispatchEvent(new KeyboardEvent('keydown', { key: '5', bubbles: true }));
      const chips = Array.from(document.querySelectorAll('#grid td.cell .chip')).map(e => e.textContent);
      const ea = document.elementFromPoint(ra.left + 5, ra.top + 5);
      const eb = document.elementFromPoint(rb.left + 5, rb.top + 5);
      return {
        sel, chipCount: chips.filter(x => x === '旷').length,
        ea: ea ? ea.className : null, eb: eb ? eb.className : null,
        backdrop: !!document.querySelector('.pop-backdrop'),
        rects: [Math.round(ra.left), Math.round(ra.top), Math.round(rb.left), Math.round(rb.top)]
      };
    })()`);
    ok('拖选 2×3 = 6 格', dragRes.sel === 6, dragRes.sel + ' ' + JSON.stringify(dragRes));
    ok('批量标记旷课', dragRes.chipCount === 6, dragRes.chipCount);

    // ---- 撤销 ----
    const undoRes = await evaluate(c, `(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));
      const chips = Array.from(document.querySelectorAll('#grid td.cell .chip')).map(e => e.textContent);
      return { kuang: chips.filter(x => x === '旷').length };
    })()`);
    ok('Ctrl+Z 撤销批量', undoRes.kuang === 0, undoRes.kuang);

    // ---- 切周 ----
    const weekRes = await evaluate(c, `(() => {
      const before = document.querySelector('#weekLabel').textContent;
      document.querySelector('#weekNext').click();
      const after = document.querySelector('#weekLabel').textContent;
      const cells = document.querySelectorAll('#grid td.cell').length;
      document.querySelector('#weekPrev').click();
      return { before, after, cells, back: document.querySelector('#weekLabel').textContent };
    })()`);
    ok('下一周', weekRes.after !== weekRes.before, weekRes.before + ' → ' + weekRes.after);
    ok('切周后表格仍在', weekRes.cells === 144, weekRes.cells);
    ok('上一周回到原处', weekRes.back === weekRes.before);

    // ---- 统计视图 ----
    const statsRes = await evaluate(c, `(() => {
      document.querySelector('#btnStats').click();
      const cards = document.querySelectorAll('#viewStats .card').length;
      const rank = document.querySelectorAll('#viewStats .rank tbody tr').length;
      const hidden = document.querySelector('#viewGrid').hidden;
      const disp = getComputedStyle(document.querySelector('#viewGrid')).display;
      document.querySelector('#btnStats').click();
      return { cards, rank, hidden, disp, back: document.querySelector('#viewGrid').hidden };
    })()`);
    ok('统计卡片 4 个', statsRes.cards === 4, statsRes.cards);
    ok('排名有数据', statsRes.rank >= 8, statsRes.rank);
    ok('统计时表格隐藏', statsRes.hidden === true && statsRes.disp === 'none', statsRes.disp);
    ok('切回表格', statsRes.back === false);

    // ---- 点名面板 ----
    const rollRes = await evaluate(c, `(() => {
      document.querySelector('#btnRoll').click();
      const rows = document.querySelectorAll('#modalLayer .roll-row').length;
      const opts = document.querySelectorAll('#modalLayer .roll-row:first-child .ropt').length;
      document.querySelector('#modalLayer .roll-row:first-child [data-rkey="sick"]').click();
      const on = document.querySelectorAll('#modalLayer .roll-row:first-child .ropt.on').length;
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      return { rows, opts, on, closed: !document.querySelector('#modalLayer.open') };
    })()`);
    ok('点名列出学生', rollRes.rows === 8, rollRes.rows);
    ok('每行 7 个状态按钮', rollRes.opts === 7, rollRes.opts);
    ok('点名标记生效', rollRes.on === 1, rollRes.on);
    ok('Esc 关闭点名', rollRes.closed);

    // ---- 导入面板 ----
    const impRes = await evaluate(c, `(() => {
      document.querySelector('#btnImport').click();
      const tabs = document.querySelectorAll('#modalLayer [data-itab]').length;
      const ta = document.querySelector('#modalLayer #impNames');
      if (ta) {
        ta.value = '测试甲\\n测试乙';
        ta.dispatchEvent(new Event('input', { bubbles: true }));
      }
      const prev = document.querySelector('#modalLayer #impPreview').textContent;
      document.querySelector('#modalLayer [data-close]').click();
      return { tabs, prev, closed: !document.querySelector('#modalLayer.open') };
    })()`);
    ok('导入三个页签', impRes.tabs === 3, impRes.tabs);
    ok('名单预览识别 2 人', /2/.test(impRes.prev), impRes.prev);
    ok('关闭导入', impRes.closed);

    // ---- 持久化校验 ----
    const persist = await evaluate(c, `(() => {
      const raw = localStorage.getItem('${DB_KEY}');
      if (!raw) return { ok: false };
      const db = JSON.parse(raw);
      const g = db.classes[0].groups[0];
      return {
        ok: true,
        classes: db.classes.length,
        groups: db.classes[0].groups.length,
        students: g.students.length,
        records: Object.keys(g.records || {}).length,
        v: db.v,
        sample: g.students.slice(0, 3).map(s => s.name)
      };
    })()`);
    ok('DB 结构完整', persist.ok && persist.classes === 1 && persist.groups === 4 && persist.students === 8,
      JSON.stringify(persist));

    const ev = summarize(c.events);
    ok('无 JS 异常', ev.exceptions.length === 0, ev.exceptions.slice(0, 3).join(' | '));
    ok('无 console.error', ev.consoleErrors.length === 0, ev.consoleErrors.slice(0, 3).join(' | '));

    ws.close();
  } finally {
    edge.kill();
    srv.close();
    try { fs.rmSync(userDir, { recursive: true, force: true }); } catch (e) { }
  }

  // ---- 报告 ----
  let pass = 0, fail = 0;
  for (const r of results) {
    if (r.pass) { pass++; console.log('  ok   ' + r.name + (r.extra ? '  [' + r.extra + ']' : '')); }
    else { fail++; console.log('  FAIL ' + r.name + (r.extra ? '  [' + r.extra + ']' : '')); }
  }
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('smoke 运行失败：', e);
  process.exit(2);
});
