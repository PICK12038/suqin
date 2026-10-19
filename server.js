/**
 * server.js — 速勤的本地 Web 服务（零依赖）
 *
 *   node server.js               # http://127.0.0.1:8123
 *   PORT=8200 node server.js     # 换端口
 *   LAN=1 node server.js         # 绑定 0.0.0.0，同一局域网可用手机/其它电脑访问
 *
 * 职责：
 *   1. 托管 src/ 下的静态文件（index.html / styles.css / *.js）
 *   2. 提供 /api/db 读写，数据落在 data/db.json（原子写入 + 上一版备份）
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, 'src');
const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const BAK_FILE = path.join(DATA_DIR, 'db.bak.json');
const PORT = Number(process.env.PORT || 8123);
const HOST = process.env.LAN === '1' ? '0.0.0.0' : '127.0.0.1';
const MAX_BODY = 24 * 1024 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2'
};

function send(res, status, body, headers) {
  res.writeHead(status, Object.assign({ 'Cache-Control': 'no-store' }, headers || {}));
  res.end(body);
}

function sendJson(res, status, obj) {
  send(res, status, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8' });
}

function ensureData() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readDB() {
  try {
    if (!fs.existsSync(DB_FILE)) return null;
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch (e) {
    console.warn('读取 db.json 失败：' + e.message);
    return null;
  }
}

function writeDB(obj) {
  ensureData();
  const json = JSON.stringify(obj, null, 1);
  const tmp = DB_FILE + '.tmp';
  // 先备份上一版，再原子替换
  try {
    if (fs.existsSync(DB_FILE)) fs.copyFileSync(DB_FILE, BAK_FILE);
  } catch (e) {
    console.warn('备份 db.json 失败：' + e.message);
  }
  fs.writeFileSync(tmp, json, 'utf8');
  fs.renameSync(tmp, DB_FILE);
  return Buffer.byteLength(json, 'utf8');
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const file = path.join(ROOT, path.normalize(rel));
  if (!file.startsWith(ROOT)) {
    send(res, 403, 'forbidden', { 'Content-Type': 'text/plain; charset=utf-8' });
    return;
  }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      send(res, 404, 'not found', { 'Content-Type': 'text/plain; charset=utf-8' });
      return;
    }
    const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
    fs.createReadStream(file).pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname;

  // 简单 CORS：允许 file:// 或其它端口调试时读取
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,PUT,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    send(res, 204, '');
    return;
  }

  if (pathname === '/api/health') {
    sendJson(res, 200, { ok: true, mode: 'server', hasDB: fs.existsSync(DB_FILE) });
    return;
  }

  if (pathname === '/api/config') {
    // 可选：env 里配 SUPABASE_URL / SUPABASE_ANON_KEY 时，页面自动启用云端
    const cfg = process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY
      ? { supabase: { url: process.env.SUPABASE_URL, key: process.env.SUPABASE_ANON_KEY } }
      : {};
    sendJson(res, 200, cfg);
    return;
  }

  if (pathname === '/api/db') {
    if (req.method === 'GET') {
      const db = readDB();
      if (!db) sendJson(res, 404, { ok: false, error: 'no-db' });
      else sendJson(res, 200, db);
      return;
    }
    if (req.method === 'PUT' || req.method === 'POST') {
      try {
        const raw = await readBody(req);
        const obj = JSON.parse(raw);
        if (!obj || !Array.isArray(obj.classes)) {
          sendJson(res, 400, { ok: false, error: 'invalid-db' });
          return;
        }
        const bytes = writeDB(obj);
        sendJson(res, 200, { ok: true, bytes: bytes, at: Date.now() });
      } catch (e) {
        sendJson(res, 400, { ok: false, error: e.message });
      }
      return;
    }
    sendJson(res, 405, { ok: false, error: 'method-not-allowed' });
    return;
  }

  if (req.method === 'GET' || req.method === 'HEAD') {
    serveStatic(req, res, pathname);
    return;
  }

  sendJson(res, 405, { ok: false, error: 'method-not-allowed' });
});

server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    console.error('端口 ' + PORT + ' 已被占用：换一个端口再启动，例如 PORT=8200 node server.js');
    process.exit(1);
  }
  console.error('服务启动失败：' + (err && err.message));
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  ensureData();
  const shown = HOST === '0.0.0.0' ? '0.0.0.0' : '127.0.0.1';
  console.log('速勤已启动： http://' + shown + ':' + PORT + '/');
  console.log('数据文件：   ' + DB_FILE);
  if (HOST === '0.0.0.0') console.log('局域网访问： http://<本机IP>:' + PORT + '/');
});
