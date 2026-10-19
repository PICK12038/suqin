/**
 * server.test.js — 验证 Web 版：API 读写、落盘、页面在服务器模式下的行为
 *
 *   node test/server.test.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 8124;
const CDP_PORT = 9228;
const BASE = 'http://127.0.0.1:' + PORT;
const ROOT = path.join(__dirname, '..');
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

async function waitHealth(ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const r = await fetch(BASE + '/api/health');
      if (r.ok) return await r.json();
    } catch (e) {
      /* retry */
    }
    await sleep(150);
  }
  throw new Error('服务未在 ' + ms + 'ms 内启动');
}

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.errors = [];
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) {
        const p = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
      }
      if (m.method === 'Runtime.exceptionThrown') {
        this.errors.push(m.params.exceptionDetails.exception && m.params.exceptionDetails.exception.description);
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
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error('页面异常: ' + JSON.stringify(r.exceptionDetails.exception));
    return r.result.value;
  }
}

async function connectCDP() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch('http://127.0.0.1:' + CDP_PORT + '/json/list')).json();
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
  throw new Error('无法连接 Edge');
}

(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-data-'));
  const srv = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: Object.assign({}, process.env, { PORT: String(PORT), DATA_DIR: dataDir }),
    stdio: 'ignore'
  });

  let edge;
  try {
    const health = await waitHealth(6000);
    console.log('\nAPI');
    ok('health 标记为 server 模式', health.ok === true && health.mode === 'server', JSON.stringify(health));
    ok('初始无数据', health.hasDB === false);

    const r404 = await fetch(BASE + '/api/db');
    ok('无数据时 GET 返回 404', r404.status === 404, r404.status);

    const bad = await fetch(BASE + '/api/db', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nope: 1 })
    });
    ok('非法结构返回 400', bad.status === 400, bad.status);

    const payload = {
      v: 1,
      settings: { periods: [{ id: 'p1', name: '上午' }], weekSize: 6 },
      classes: [{ id: 'c1', name: '测试班', groups: [] }],
      trash: []
    };
    const put = await fetch(BASE + '/api/db', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const putBody = await put.json();
    ok('合法结构写入成功', put.status === 200 && putBody.ok === true, putBody.bytes + ' bytes');
    ok('落盘到 data 目录', fs.existsSync(path.join(dataDir, 'db.json')));

    const back = await (await fetch(BASE + '/api/db')).json();
    ok('GET 读回一致', back.classes[0].name === '测试班', back.classes.length + ' 班');

    // 覆盖写入成示例数据前，先检查备份机制
    await fetch(BASE + '/api/db', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({}, payload, { classes: [] }))
    });
    ok('上一版有备份文件', fs.existsSync(path.join(dataDir, 'db.bak.json')));

    // 清掉服务端数据，让页面走「服务器可用但没有数据 → 把示例数据写上去」这条路
    fs.rmSync(path.join(dataDir, 'db.json'), { force: true });
    fs.rmSync(path.join(dataDir, 'db.bak.json'), { force: true });
    const cleared = await waitHealth(3000);
    ok('清空后 hasDB=false', cleared.hasDB === false);

    console.log('\n页面（服务器模式）');
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-edge-'));
    edge = spawn(EDGE, [
      '--headless=new',
      '--remote-debugging-port=' + CDP_PORT,
      '--user-data-dir=' + profile,
      '--no-first-run',
      '--disable-gpu',
      '--window-size=1440,1000',
      'about:blank'
    ], { stdio: 'ignore' });
    const c = await connectCDP();
    await c.send('Page.enable');
    await c.send('Runtime.enable');
    await c.send('Page.navigate', { url: BASE + '/' });
    await sleep(1400);

    const shell = await c.eval(`(() => ({
      classes: document.querySelectorAll('#classTabs .sitem').length,
      groups: document.querySelectorAll('#groupTabs .gchip').length,
      summary: (document.querySelector('#sideSummary') || {}).textContent || '',
      save: (document.querySelector('#saveState') || {}).textContent || '',
      stor: (document.querySelector('#storageNote') || {}).textContent || '',
      rows: document.querySelectorAll('#grid tbody tr[data-sid]').length
    }))()`);
    ok('左栏有班级项（含新建）', shell.classes >= 2, shell.classes);
    ok('左栏有小组项（含新建）', shell.groups >= 4, shell.groups);
    ok('本周概览已渲染', /出勤率/.test(shell.summary) && /%/.test(shell.summary), shell.summary.replace(/\s+/g, ' ').slice(0, 40));
    ok('保存状态不含「本机」', /已保存/.test(shell.save) && shell.save.indexOf('本机') < 0, shell.save);
    ok('存储说明指向服务器', /data\/db\.json/.test(shell.stor), shell.stor);
    ok('表格已渲染', shell.rows === 8, shell.rows);

    // 标记一个格子，等防抖 + PUT
    const marked = await c.eval(`(() => {
      const td = document.querySelector('#grid td.cell[data-r="0"][data-c="0"]');
      const b = td.getBoundingClientRect();
      td.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: b.left + 5, clientY: b.top + 5 }));
      document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, clientX: b.left + 5, clientY: b.top + 5 }));
      const opt = document.querySelector('#popLayer [data-mark="late"]');
      if (!opt) return 'no-popover';
      opt.click();
      return 'ok';
    })()`);
    ok('点格子标记成功', marked === 'ok', marked);
    await sleep(900);

    const saved = await (await fetch(BASE + '/api/db')).json();
    const recs = JSON.stringify(saved).match(/"late"/g) || [];
    ok('标记已 PUT 到服务器', recs.length >= 1, recs.length + ' 条 late');

    // 刷新后仍在
    await c.send('Page.reload', { ignoreCache: true });
    await sleep(1400);
    const after = await c.eval(`(() => {
      const td = document.querySelector('#grid td.cell[data-r="0"][data-c="0"]');
      return td && td.querySelector('.chip') ? td.querySelector('.chip').textContent : '';
    })()`);
    ok('刷新后标记仍在', after === '迟', after);

    ok('无 JS 异常', c.errors.length === 0, c.errors.slice(0, 2).join(' | '));
  } finally {
    try {
      if (edge) edge.kill();
    } catch (e) {
      /* ignore */
    }
    try {
      srv.kill();
    } catch (e) {
      /* ignore */
    }
    await sleep(200);
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
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
