/*!
 * 速勤 SuQin · 班级考勤工作台
 * app.js — 界面与交互（无依赖）
 *
 * 交互设计要点：
 *  1. 选中 → 点标记（最多两次点击），或直接按 1-6 数字键；不再需要循环点击 7 次。
 *  2. 拖选 / Shift 点选 / Shift+方向键 形成矩形区域，批量标记。
 *  3. 「点名」面板一屏看到全班，默认全出勤，只需点异常的学生。
 *  4. 所有写操作可撤销（快照栈），误点不怕。
 */
(function () {
  'use strict';

  var C = window.SQCore;
  var STATUSES = C.STATUSES;
  var esc = C.esc;
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

  /* ------------------------------------------------------------------ *
   * 图标
   * ------------------------------------------------------------------ */
  var S = 'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';
  var ICON = {
    search: '<svg viewBox="0 0 24 24" ' + S + '><circle cx="11" cy="11" r="7"/><path d="M20.5 20.5L16.7 16.7"/></svg>',
    check: '<svg viewBox="0 0 24 24" ' + S + '><path d="M4 12.5l5 5L20 6.5"/></svg>',
    chart: '<svg viewBox="0 0 24 24" ' + S + '><path d="M4 20V10M10 20V4M16 20v-6M22 20H2"/></svg>',
    download: '<svg viewBox="0 0 24 24" ' + S + '><path d="M12 3v12m0 0l-4-4m4 4l4-4M4 21h16"/></svg>',
    upload: '<svg viewBox="0 0 24 24" ' + S + '><path d="M12 21V9m0 0L8 13m4-4l4 4M4 3h16"/></svg>',
    moon: '<svg viewBox="0 0 24 24" ' + S + '><path d="M21 12.8A9 9 0 1111.2 3a7 7 0 009.8 9.8z"/></svg>',
    sun: '<svg viewBox="0 0 24 24" ' + S + '><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4"/></svg>',
    gear: '<svg viewBox="0 0 24 24" ' + S + '><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9L17 7M7 17l-2.1 2.1"/></svg>',
    left: '<svg viewBox="0 0 24 24" ' + S + '><path d="M15 5l-7 7 7 7"/></svg>',
    right: '<svg viewBox="0 0 24 24" ' + S + '><path d="M9 5l7 7-7 7"/></svg>',
    undo: '<svg viewBox="0 0 24 24" ' + S + '><path d="M9 14L4 9l5-5"/><path d="M4 9h11a5 5 0 010 10h-4"/></svg>',
    redo: '<svg viewBox="0 0 24 24" ' + S + '><path d="M15 14l5-5-5-5"/><path d="M20 9H9a5 5 0 000 10h4"/></svg>',
    close: '<svg viewBox="0 0 24 24" ' + S + '><path d="M6 6l12 12M18 6L6 18"/></svg>',
    plus: '<svg viewBox="0 0 24 24" ' + S + '><path d="M12 5v14M5 12h14"/></svg>',
    copy: '<svg viewBox="0 0 24 24" ' + S + '><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 012-2h10"/></svg>'
  };

  /* ------------------------------------------------------------------ *
   * 全局状态
   * ------------------------------------------------------------------ */
  var state = {
    db: null,
    classId: null,
    groupId: null,
    week: 0,
    view: 'grid',
    statsRange: 'week',
    sel: null,          // {r1,c1,r2,c2} 局部坐标（行=学生序，列=日期*时段）
    anchor: null,       // {r,c}
    active: null,       // {r,c}
    undo: [],
    redo: [],
    pop: null,          // 当前 popover 元素
    modal: null,
    roll: null,
    saveTimer: 0,
    mode: 'local',
    lastSaved: 0
  };
  var MAX_UNDO = 40;
  var storeOK = true;

  /* ------------------------------------------------------------------ *
   * 存储：优先本机服务器 /api/db，退化为 localStorage
   * ------------------------------------------------------------------ */
  var API_DB = '/api/db';

  function loadDB() {
    try {
      var raw = localStorage.getItem(C.APP.dbKey);
      if (!raw) return null;
      return C.normalizeDB(JSON.parse(raw));
    } catch (e) {
      console.warn('读取本地数据失败', e);
      return null;
    }
  }

  /** 探测服务器存储：{ ok, db }。ok=false 表示没有服务器（静态托管 / file://）。 */
  function fetchRemoteDB() {
    return new Promise(function (resolve) {
      var done = false;
      var timer = null;
      function armTimeout(ms) {
        timer = setTimeout(function () {
          if (done) return;
          done = true;
          resolve({ ok: false, db: null });
        }, ms);
      }
      function finish(v) {
        if (done) return;
        done = true;
        if (timer) clearTimeout(timer);
        resolve(v);
      }
      // 优先看云端配置（内置默认 / 本地 / 服务器注入）；云端路径网络可能慢，给足 8s
      ensureCloudConfig().then(function (cloud) {
        if (cloud) {
          armTimeout(8000);
          cloudFetch('GET').then(function (res) {
            if (res.ok) {
              finish({ ok: true, db: res.db, cloud: true });
            } else {
              // 云端配置了但读不到（表未建 / key 错）→ 别退回本机静默保存，提示出来
              finish({ ok: false, db: null, cloudError: res.error });
            }
          });
          return;
        }
        // 用 /api/health 判断是不是速勤的服务端，避免把普通静态服务器的 404 当成可用
        armTimeout(1500);
        fetch('/api/health', { cache: 'no-store' })
          .then(function (r) {
            if (!r.ok) throw new Error('no-api');
            return r.json();
          })
          .then(function (j) {
            if (!j || !j.ok) throw new Error('no-api');
            return fetch(API_DB, { cache: 'no-store' });
          })
          .then(function (r) {
            if (r.status === 404) return null;
            if (!r.ok) throw new Error('db-error');
            return r.json();
          })
          .then(function (obj) {
            finish({ ok: true, db: obj && Array.isArray(obj.classes) ? C.normalizeDB(obj) : null });
          })
          .catch(function () {
            finish({ ok: false, db: null });
          });
      });
    });
  }

  /* ---------------- Supabase 云端共享 ---------------- */
  // 单行存储：表 attendance_state(id=1, data jsonb, updated_at timestamptz)
  // anon key 只开放 select/insert/update 这一行，泄漏也只影响这一份考勤数据。
  var SUPA_ID_KEY = 'suqin_supabase';
  function cloudConfig() {
    try {
      var raw = localStorage.getItem(SUPA_ID_KEY);
      if (!raw) return null;
      var v = JSON.parse(raw);
      if (v && v.url && v.key) return v;
    } catch (e) { /* ignore */ }
    return null;
  }

  function saveCloudConfig(cfg) {
    if (cfg && cfg.url && cfg.key) localStorage.setItem(SUPA_ID_KEY, JSON.stringify(cfg));
    else localStorage.removeItem(SUPA_ID_KEY);
  }

  var cloudCfgPromise = null;
  // 内置默认云端：让所有打开本页的设备零配置自动共享同一份数据。
  // anon key 本就是设计为公开的（RLS 只放行 attendance_state 一行），放前端是 Supabase 官方用法。
  var DEFAULT_CLOUD = {
    url: 'https://qcvefxutsncfbhfnrczh.supabase.co',
    key: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFjdmVmeHV0c25jZmJoZm5yY3poIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA0MTc4MTcsImV4cCI6MjA5NTk5MzgxN30.pjdqBGfpxR4IVSjSRf8dnMicndErvrEMK-pRY7gUQkU'
  };
  function ensureCloudConfig() {
    // 优先本地配置（设置里可覆盖）→ 服务器注入 → GitHub Pages 托管时用内置默认云端。
    // 门控：仅 github.io 托管才默认云端，保证本机服务器版 / file:// 离线版行为不变。
    if (!cloudCfgPromise) {
      cloudCfgPromise = new Promise(function (resolve) {
        var saved = cloudConfig();
        if (saved) return resolve(saved);
        var isPages = /\.github\.io$/.test(location.hostname) || location.hostname === 'github.io';
        var finish = function (cfg) {
          if (cfg) saveCloudConfig(cfg);
          resolve(cfg);
        };
        if (location.protocol === 'file:') return resolve(null);
        if (isPages) return finish(DEFAULT_CLOUD);
        fetch('/api/config', { cache: 'no-store' })
          .then(function (r) { return r.ok ? r.json() : null; })
          .then(function (j) {
            finish(j && j.supabase && j.supabase.url && j.supabase.key ? j.supabase : null);
          })
          .catch(function () { resolve(null); });
      });
    }
    return cloudCfgPromise;
  }

  function supaHeaders(extra) {
    var cfg = cloudConfig();
    var h = {
      apikey: cfg.key,
      Authorization: 'Bearer ' + cfg.key,
      'Content-Type': 'application/json',
      Prefer: 'return=representation'
    };
    if (extra) for (var k in extra) h[k] = extra[k];
    return h;
  }

  /** 云端读写。GET → {ok,db}；PUT → {ok}。出错返回 {ok:false,error}。 */
  function cloudFetch(method, body) {
    return new Promise(function (resolve) {
      var cfg = cloudConfig();
      if (!cfg) return resolve({ ok: false, error: '未配置云端' });
      var url = cfg.url.replace(/\/+$/, '') + '/rest/v1/attendance_state';
      if (method === 'GET') {
        fetch(url + '?id=eq.1&select=data,updated_at', { headers: supaHeaders(), cache: 'no-store' })
          .then(function (r) {
            if (!r.ok) throw new Error('HTTP ' + r.status);
            return r.json();
          })
          .then(function (rows) {
            if (!rows || !rows.length) return resolve({ ok: true, db: null });
            var obj = rows[0].data;
            resolve({ ok: true, db: obj && Array.isArray(obj.classes) ? C.normalizeDB(obj) : null });
          })
          .catch(function (e) { resolve({ ok: false, error: e.message }); });
        return;
      }
      // upsert 单行
      fetch(url, {
        method: 'POST',
        headers: supaHeaders({ Prefer: 'return=representation,resolution=merge-duplicates' }),
        body: JSON.stringify([{ id: 1, data: body, updated_at: new Date().toISOString() }])
      })
        .then(function (r) {
          if (!r.ok) throw new Error('HTTP ' + r.status);
          return r.json();
        })
        .then(function () { resolve({ ok: true }); })
        .catch(function (e) { resolve({ ok: false, error: e.message }); });
    });
  }

  function updateStorageNote() {
    var el = $('#storageNote');
    if (!el) return;
    var t = {
      cloud: '数据保存在 Supabase 云端，所有打开此页面的人共享',
      server: '数据保存在本机服务器 data/db.json，可用局域网访问',
      local: '数据保存在本机浏览器，不会上传（仅当云端连接失败时出现）'
    };
    el.textContent = t[state.mode] || t.local;
  }

  function saveNow() {
    if (!state.db) return;
    state.db.meta.updatedAt = Date.now();
    var json = JSON.stringify(state.db);
    var localOK = true;
    try {
      localStorage.setItem(C.APP.dbKey, json);
    } catch (e) {
      localOK = false;
    }

    if (state.mode === 'cloud') {
      // 云端模式：本地始终留一份兜底，远端为主
      cloudFetch('PUT', state.db).then(function (res) {
        if (res.ok) {
          state.lastSaved = Date.now();
          setSaveState('saved');
        } else {
          setSaveState('error');
          toast('云端保存失败：' + (res.error || '网络错误') + '（本地已留底）', 'err', 5000);
        }
      });
      return;
    }

    if (state.mode !== 'server') {
      if (localOK) {
        state.lastSaved = Date.now();
        setSaveState('saved');
      } else {
        storeOK = false;
        setSaveState('error');
        toast('保存失败：浏览器存储空间可能已满，请先导出备份', 'err', 6000);
      }
      return;
    }

    fetch(API_DB, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: json })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        state.lastSaved = Date.now();
        setSaveState('saved');
      })
      .catch(function (e) {
        state.mode = 'local';
        updateStorageNote();
        setSaveState(localOK ? 'saved' : 'error');
        toast('服务器保存失败，已切回本机保存', 'warn', 4000);
        console.warn(e);
      });
  }

  function save() {
    setSaveState('saving');
    clearTimeout(state.saveTimer);
    state.saveTimer = setTimeout(saveNow, 300);
  }

  function setSaveState(kind) {
    var el = $('#saveState');
    if (!el) return;
    el.className = 'save-state' + (kind === 'saving' ? ' saving' : kind === 'error' ? ' err' : '');
    var txt = kind === 'saving' ? '保存中…' : kind === 'error' ? '保存失败' : '已保存';
    if (state.mode === 'cloud') txt += ' · 云端';
    else if (state.mode !== 'server') txt += ' · 本机';
    el.innerHTML = '<i></i>' + txt;
  }

  /* ------------------------------------------------------------------ *
   * 撤销 / 重做
   * ------------------------------------------------------------------ */
  function pushUndo() {
    if (!state.db) return;
    try {
      state.undo.push(JSON.stringify(state.db));
      if (state.undo.length > MAX_UNDO) state.undo.shift();
      state.redo.length = 0;
    } catch (e) { /* ignore */ }
    updateUndoButtons();
  }

  function undo() {
    if (!state.undo.length) return toast('没有可撤销的操作');
    state.redo.push(JSON.stringify(state.db));
    state.db = C.normalizeDB(JSON.parse(state.undo.pop()));
    ensureSelectionValid();
    save(); renderAll();
    toast('已撤销');
  }

  function redo() {
    if (!state.redo.length) return;
    state.undo.push(JSON.stringify(state.db));
    state.db = C.normalizeDB(JSON.parse(state.redo.pop()));
    ensureSelectionValid();
    save(); renderAll();
  }

  function updateUndoButtons() {
    var u = $('#btnUndo'), r = $('#btnRedo');
    if (u) u.disabled = !state.undo.length;
    if (r) r.disabled = !state.redo.length;
  }

  /* ------------------------------------------------------------------ *
   * 取数
   * ------------------------------------------------------------------ */
  function curClass() { return C.findClass(state.db, state.classId); }
  function curGroup() {
    var c = curClass();
    if (!c) return null;
    return c.groups.filter(function (g) { return g.id === state.groupId; })[0] || c.groups[0] || null;
  }
  function periods() { return state.db.settings.periods; }
  function weekSize() { return state.db.settings.weekSize || 6; }
  function weekCount(g) {
    g = g || curGroup();
    if (!g) return 1;
    return Math.max(1, Math.ceil(g.dates.length / weekSize()));
  }
  function weekStart() { return state.week * weekSize(); }
  function weekDates() {
    var g = curGroup();
    if (!g) return [];
    return g.dates.slice(weekStart(), weekStart() + weekSize());
  }
  function weekDateIds() { return weekDates().map(function (d) { return d.id; }); }
  function allDateIds(g) { return (g || curGroup()).dates.map(function (d) { return d.id; }); }

  function ensureSelectionValid() {
    var g = curGroup();
    if (!g) { state.sel = state.anchor = state.active = null; return; }
    if (!g.students.length) { state.sel = state.anchor = state.active = null; return; }
    var rows = g.students.length;
    var cols = weekDates().length * periods().length;
    if (!cols) { state.sel = state.anchor = state.active = null; return; }
    function clamp(p) {
      if (!p) return null;
      return { r: Math.max(0, Math.min(rows - 1, p.r)), c: Math.max(0, Math.min(cols - 1, p.c)) };
    }
    state.anchor = clamp(state.anchor);
    state.active = clamp(state.active) || (state.anchor ? { r: state.anchor.r, c: state.anchor.c } : null);
    if (state.anchor && state.active) {
      state.sel = {
        r1: Math.min(state.anchor.r, state.active.r), r2: Math.max(state.anchor.r, state.active.r),
        c1: Math.min(state.anchor.c, state.active.c), c2: Math.max(state.anchor.c, state.active.c)
      };
    } else state.sel = null;
  }

  function selCells() {
    var out = [];
    if (!state.sel) return out;
    for (var r = state.sel.r1; r <= state.sel.r2; r++)
      for (var c = state.sel.c1; c <= state.sel.c2; c++) out.push({ r: r, c: c });
    return out;
  }

  function cellInfo(r, c) {
    var g = curGroup(), dates = weekDates(), ps = periods();
    if (!g || !dates.length) return null;
    var dayIdx = Math.floor(c / ps.length), pid = ps[c % ps.length].id;
    var d = dates[dayIdx];
    if (!d) return null;
    return { g: g, student: g.students[r], date: d, periodId: pid, period: ps[c % ps.length], dayIdx: dayIdx };
  }

  /* ------------------------------------------------------------------ *
   * 渲染：整体
   * ------------------------------------------------------------------ */
  function renderAll() {
    renderChrome();
    if (state.view === 'stats') renderStats();
    else renderGrid();
    updateUndoButtons();
  }

  function renderChrome() {
    var db = state.db, c = curClass(), g = curGroup();

    // 班级
    $('#classTabs').innerHTML = db.classes.map(function (k) {
      var n = k.groups.reduce(function (a, x) { return a + x.students.length; }, 0);
      return '<button class="sitem' + (c && k.id === c.id ? ' on' : '') + '" data-class="' + k.id + '">' +
        '<span class="sname">' + esc(k.name) + '</span><span class="cnt">' + n + '</span></button>';
    }).join('') + '<button class="sitem add" data-add-class title="新建班级">＋ 新建班级</button>';

    // 小组
    if (c) {
      $('#groupTabs').innerHTML = c.groups.map(function (k) {
        return '<button class="gchip' + (g && k.id === g.id ? ' on' : '') + '" data-group="' + k.id + '">' +
          '<span class="sname">' + esc(k.name) + '</span><span class="cnt">' + k.students.length + '</span></button>';
      }).join('') + '<button class="gchip add" data-add-group title="新建小组">＋</button>';
    } else $('#groupTabs').innerHTML = '';

    // 左栏本周概览
    var sum = $('#sideSummary');
    if (sum) {
      if (g) {
        var sst = C.computeStats(g, weekDateIds(), periods());
        var srate = (sst.rate * 100).toFixed(1);
        sum.innerHTML = '<div class="ss-title">本周概览 · ' + esc(g.name) + '</div>' +
          '<div class="ss-row"><b>' + srate + '%</b><span>出勤率</span></div>' +
          '<div class="ss-bar"><i style="width:' + srate + '%"></i></div>' +
          '<div class="ss-row"><span>应到格</span><b style="font-size:13px">' + sst.slots + '</b></div>' +
          '<div class="ss-row"><span>异常格</span><b style="font-size:13px;color:' + (sst.abnormal ? 'var(--bad)' : 'var(--text)') + '">' + sst.abnormal + '</b></div>';
      } else {
        sum.innerHTML = '<div class="ss-title">本周概览</div><div class="ss-row"><span>还没有小组</span></div>';
      }
    }

    // 周
    var dates = weekDates();
    var total = weekCount();
    if (state.week >= total) state.week = total - 1;
    $('#weekLabel').textContent = '第 ' + (state.week + 1) + ' 周';
    $('#weekRange').textContent = dates.length
      ? (dates[0].label + (dates.length > 1 ? ' – ' + dates[dates.length - 1].label : ''))
      : '暂无日期';
    $('#weekPrev').disabled = state.week <= 0;
    $('#weekNext').disabled = state.week >= total - 1;

    // 演示提示
    var demo = db.meta && db.meta.demo;
    $('#demoBanner').hidden = !demo;

    // 视图按钮态
    $('#btnStats').classList.toggle('btn-soft', state.view === 'stats');
    $('#btnStats').classList.toggle('btn-ghost', state.view !== 'stats');
    $('#viewGrid').hidden = state.view !== 'grid';
    $('#viewStats').hidden = state.view !== 'stats';

    // 主题图标
    var dark = document.documentElement.getAttribute('data-theme') === 'dark';
    var tb = $('#btnTheme .ico');
    if (tb) tb.innerHTML = dark ? ICON.sun : ICON.moon;
  }

  /* ------------------------------------------------------------------ *
   * 渲染：表格
   * ------------------------------------------------------------------ */
  function renderGrid() {
    var wrap = $('#gridWrap'), grid = $('#grid'), empty = $('#gridEmpty');
    var g = curGroup();
    var keep = { l: wrap.scrollLeft, t: wrap.scrollTop };

    if (!g) {
      grid.innerHTML = '';
      empty.hidden = false;
      empty.innerHTML = '<div class="ge-box"><h3>还没有班级</h3><p>先新建一个班级，再把学生名单粘进来。</p>' +
        '<button class="btn btn-primary" data-empty-act="new-class">新建班级</button></div>';
      bindEmpty();
      return;
    }
    if (!g.dates.length) {
      grid.innerHTML = '';
      empty.hidden = false;
      empty.innerHTML = '<div class="ge-box"><h3>还没有日期列</h3><p>生成一学期的日期列（默认周一至周六），或用「添加日期」逐天添加。</p>' +
        '<button class="btn btn-primary" data-empty-act="gen-dates">生成日期列</button></div>';
      bindEmpty();
      return;
    }

    var dates = weekDates(), ps = periods(), today = C.todayISO();
    var cols = dates.length * ps.length;
    var students = g.students;
    var dateIds = dates.map(function (d) { return d.id; });

    var html = '<colgroup><col style="width:' + '38px' + '"><col style="width:108px">';
    dates.forEach(function () { ps.forEach(function () { html += '<col style="width:34px">'; }); });
    html += '<col style="width:96px"></colgroup>';

    // 表头
    html += '<thead><tr>';
    html += '<th class="c-seq" rowspan="2">#</th><th class="c-name" rowspan="2">姓名</th>';
    dates.forEach(function (d) {
      var wd = C.weekdayName(d.id);
      var isToday = d.id === today;
      var isSat = wd === '周六';
      html += '<th class="day' + (isToday ? ' is-today' : '') + (isSat ? ' is-sat' : '') + '" colspan="' + ps.length +
        '" data-date="' + d.id + '" title="点击编辑日期 / 标签 / 删除">' +
        '<div class="day-inner"><div class="day-top">' + esc(d.label) + '</div>' +
        '<div class="day-wd">' + wd + (d.tag ? ' · <span class="day-tag">' + esc(d.tag) + '</span>' : '') + '</div></div></th>';
    });
    html += '<th class="c-sum" rowspan="2" style="width:96px">本周</th>';
    html += '</tr><tr>';
    dates.forEach(function (d) {
      ps.forEach(function (p, i) {
        html += '<th class="period' + (i === 0 ? ' p-first' : '') + '">' + esc(p.name) + '</th>';
      });
    });
    html += '</tr></thead><tbody>';

    // 学生行
    students.forEach(function (st, r) {
      var sum = C.summarize(g, st.id, dateIds, ps);
      var sumHtml = sum.abnormal === 0
        ? '<span class="full">★ 全勤</span>'
        : '<span class="' + (sum.worst && sum.worst.sev >= 5 ? 'bad-l' : 'warn-l') + '">' + esc(shortSummary(sum.counts)) + '</span>';
      html += '<tr data-r="' + r + '" data-sid="' + st.id + '">';
      html += '<td class="c-seq">' + (r + 1) + '</td>';
      html += '<td class="c-name"><div class="name-cell"><span class="nm" title="' + esc(st.name) + '">' + esc(st.name) + '</span>' +
        '<button class="row-btn" data-row-menu="' + r + '" title="学生操作">⋯</button></div></td>';
      dates.forEach(function (d, di) {
        ps.forEach(function (p, pi) {
          var s = C.getStatus(g, st.id, d.id, p.id);
          var def = C.STATUS_BY_KEY[s];
          var ci = di * ps.length + pi;
          html += '<td class="cell' + (def ? ' has' : '') + (d.id === today ? ' is-today' : '') +
            '" data-r="' + r + '" data-c="' + ci + '"' +
            ' data-date="' + d.id + '" data-period="' + p.id + '" data-sid="' + st.id + '"' +
            (def ? ' style="--c:' + def.color + ';--soft:' + def.soft + '"' : '') +
            ' title="' + esc(st.name + ' · ' + d.label + ' ' + p.name + (def ? ' · ' + def.label : '')) + '">' +
            (def ? '<span class="chip">' + def.short + '</span>' : '') + '</td>';
        });
      });
      html += '<td class="sum" data-sum="' + r + '" title="查看 ' + esc(st.name) + ' 的统计">' + sumHtml + '</td>';
      html += '</tr>';
    });

    // 添加学生行
    html += '<tr class="add-row"><td class="c-seq"></td><td class="c-add" colspan="' + (cols + 2) + '">' +
      '<div class="add-inner"><input class="add-input" id="addInput" placeholder="添加学生：输入姓名后回车，可一次粘贴多个（逗号 / 换行分隔）" autocomplete="off">' +
      '<button class="btn btn-xs btn-soft" id="addBtn">添加</button></div></td></tr>';
    html += '</tbody>';

    // 每日异常合计
    html += '<tfoot><tr><td class="c-seq"></td><td class="c-name">当日异常</td>';
    dates.forEach(function (d, di) {
      var n = 0;
      students.forEach(function (st) {
        ps.forEach(function (p) { if (C.getStatus(g, st.id, d.id, p.id)) n++; });
      });
      html += '<td colspan="' + ps.length + '" class="' + (n ? 'ab' : '') + '">' + (n ? n + ' 次' : '—') + '</td>';
    });
    html += '<td></td></tr></tfoot>';

    grid.innerHTML = html;
    grid.style.minWidth = '100%';
    empty.hidden = students.length > 0;
    if (!students.length) {
      empty.innerHTML = '<div class="ge-box"><h3>这个小组还没有学生</h3><p>在表格底部输入姓名，或从其它地方整段粘贴名单。</p>' +
        '<button class="btn btn-outline" data-empty-act="import">批量导入名单</button></div>';
      bindEmpty();
    }

    bindGridEvents();
    paintSel();
    wrap.scrollLeft = keep.l; wrap.scrollTop = keep.t;
  }

  function shortSummary(counts) {
    var parts = [];
    STATUSES.forEach(function (s) { if (counts[s.key] > 0) parts.push(s.short + counts[s.key]); });
    return parts.join(' ');
  }

  function bindEmpty() {
    $$('#gridEmpty [data-empty-act]').forEach(function (b) {
      b.onclick = function () {
        var a = b.getAttribute('data-empty-act');
        if (a === 'new-class') addClass();
        else if (a === 'gen-dates') generateDatesDialog();
        else if (a === 'import') openImport('roster');
      };
    });
  }

  /* ------------------------------------------------------------------ *
   * 选择与绘制
   * ------------------------------------------------------------------ */
  function paintSel() {
    var grid = $('#grid');
    if (!grid) return;
    var sel = state.sel, act = state.active;
    $$('td.cell', grid).forEach(function (td) {
      var r = +td.dataset.r, c = +td.dataset.c;
      var inSel = sel && r >= sel.r1 && r <= sel.r2 && c >= sel.c1 && c <= sel.c2;
      td.classList.toggle('sel', !!inSel);
      td.classList.toggle('active', !!act && act.r === r && act.c === c);
    });
    $$('tr[data-sid]', grid).forEach(function (tr) {
      tr.classList.toggle('sel-row', !!(sel && +tr.dataset.r >= sel.r1 && +tr.dataset.r <= sel.r2));
    });
  }

  function selectCell(r, c, extend) {
    var g = curGroup();
    if (!g || !g.students.length) return;
    var cols = weekDates().length * periods().length;
    r = Math.max(0, Math.min(g.students.length - 1, r));
    c = Math.max(0, Math.min(cols - 1, c));
    if (extend && state.anchor) {
      state.active = { r: r, c: c };
    } else {
      state.anchor = { r: r, c: c };
      state.active = { r: r, c: c };
    }
    state.sel = {
      r1: Math.min(state.anchor.r, state.active.r), r2: Math.max(state.anchor.r, state.active.r),
      c1: Math.min(state.anchor.c, state.active.c), c2: Math.max(state.anchor.c, state.active.c)
    };
    paintSel();
    scrollCellIntoView(r, c);
  }

  function scrollCellIntoView(r, c) {
    var td = $('#grid td.cell[data-r="' + r + '"][data-c="' + c + '"]');
    if (td && td.scrollIntoView) td.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  /* ------------------------------------------------------------------ *
   * 标记
   * ------------------------------------------------------------------ */
  function applyStatus(key) {
    applyStatusToScope(key, 'cell');
  }

  /**
   * 把一个状态写到选区内。
   * scope='cell' 只写命中的格子；scope='day' 把同一日期该行的所有时段一起写。
   */
  function applyStatusToScope(key, scope) {
    var g = curGroup();
    if (!g) return;
    var cells = selCells();
    if (!cells.length) { toast('先选中要标记的格子'); return; }
    var ps = periods();
    var seen = {};
    pushUndo();
    var n = 0;
    cells.forEach(function (x) {
      var info = cellInfo(x.r, x.c);
      if (!info) return;
      var use = scope === 'day' ? ps : [info.period];
      use.forEach(function (p) {
        var k = info.student.id + '|' + info.date.id + '|' + p.id;
        if (seen[k]) return;
        seen[k] = 1;
        C.setStatus(g, info.student.id, info.date.id, p.id, key);
        n++;
      });
    });
    save();
    renderGrid();
    updateUndoButtons();
    if (n > 1) {
      toast('已' + (key ? '标记 ' : '清除 ') + n + ' 格' +
        (key ? '：' + C.STATUS_BY_KEY[key].label : ''), 'ok', 1200);
    }
  }

  function clearSelection() {
    state.sel = state.anchor = state.active = null;
    paintSel();
  }

  /* ------------------------------------------------------------------ *
   * 浮动面板
   * ------------------------------------------------------------------ */
  function closePop() {
    if (state.pop) { state.pop.remove(); state.pop = null; }
    if (state.popBack) { state.popBack.remove(); state.popBack = null; }
  }

  function openPop(html, opts) {
    opts = opts || {};
    closePop();
    var layer = $('#popLayer');
    var back = document.createElement('div');
    back.className = 'pop-backdrop';
    back.addEventListener('pointerdown', function (e) { e.preventDefault(); closePop(); });
    var pop = document.createElement('div');
    pop.className = 'pop' + (opts.cls ? ' ' + opts.cls : '');
    pop.innerHTML = html;
    layer.appendChild(back);
    layer.appendChild(pop);
    state.pop = pop;
    state.popBack = back;

    // 定位
    var rect = opts.anchor ? opts.anchor.getBoundingClientRect() : null;
    var pw = pop.offsetWidth, ph = pop.offsetHeight;
    var x, y;
    if (rect) {
      x = rect.left + rect.width / 2 - pw / 2;
      y = rect.top - ph - 8;
      if (y < 8) y = rect.bottom + 8;
    } else {
      x = (window.innerWidth - pw) / 2;
      y = 90;
    }
    x = Math.max(8, Math.min(window.innerWidth - pw - 8, x));
    y = Math.max(8, Math.min(window.innerHeight - ph - 8, y));
    pop.style.left = x + 'px';
    pop.style.top = y + 'px';
    return pop;
  }

  function openCellPop(td) {
    var r = +td.dataset.r, c = +td.dataset.c;
    var info = cellInfo(r, c);
    if (!info) return;
    var cur = C.getStatus(info.g, info.student.id, info.date.id, info.periodId);
    var multi = state.sel && (state.sel.r1 !== state.sel.r2 || state.sel.c1 !== state.sel.c2);
    var scope = state.pendingScope || 'cell';

    function headText() {
      if (multi) {
        return (state.sel.r2 - state.sel.r1 + 1) + ' 行 × ' + (state.sel.c2 - state.sel.c1 + 1) +
          ' 列 · 共 ' + selCells().length + ' 格';
      }
      return esc(info.student.name) + ' · ' + esc(info.date.label) + ' ' + esc(info.period.name);
    }

    function build() {
      var html = '<div class="pop-head"><b>' + headText() + '</b></div><div class="st-grid">';
      STATUSES.forEach(function (s) {
        html += '<button class="st-opt' + (!multi && cur === s.key ? ' on' : '') + '" data-mark="' + s.key +
          '" style="--c:' + s.color + ';--soft:' + s.soft + '">' +
          '<span class="sw">' + s.short + '</span><span>' + s.label + '</span><span class="k">' + s.hint + '</span></button>';
      });
      html += '<button class="st-opt none' + (!multi && !cur ? ' on' : '') + '" data-mark="" style="grid-column:1/-1">' +
        '<span class="sw">○</span><span>出勤 / 清除标记</span><span class="k">0</span></button>';
      html += '</div>';
      html += '<div class="pop-foot scope"><span class="scope-lbl">标记范围</span>' +
        '<div class="seg seg-sm">' +
        '<button data-scope="cell" class="' + (scope === 'cell' ? 'on' : '') + '">本节</button>' +
        '<button data-scope="day" class="' + (scope === 'day' ? 'on' : '') + '">整天</button>' +
        '</div></div>';
      return html;
    }

    var pop = openPop(build(), { anchor: td });
    function wire() {
      $$('[data-mark]', pop).forEach(function (b) {
        b.onclick = function () { applyStatusToScope(b.getAttribute('data-mark'), scope); closePop(); };
      });
      $$('[data-scope]', pop).forEach(function (b) {
        b.onclick = function () {
          scope = b.getAttribute('data-scope');
          state.pendingScope = scope;
          pop.innerHTML = build();
          wire();
        };
      });
    }
    wire();
  }

  function openDatePop(th) {
    var dateId = th.getAttribute('data-date');
    var g = curGroup();
    var d = g.dates.filter(function (x) { return x.id === dateId; })[0];
    if (!d) return;
    var html = '<div class="pop-head"><b>' + esc(d.label) + ' ' + C.weekdayName(d.id) + '</b>' +
      '<span style="margin-left:auto">' + esc(C.parseISO(d.id).getFullYear()) + '</span></div>' +
      '<div class="field"><label>标签 / 备注</label><input class="input" id="dpTag" value="' + esc(d.tag || '') +
      '" placeholder="如 月考、运动会、家长会"></div>' +
      '<div class="field"><label>添加日期</label><div class="inline"><input type="date" class="input" id="dpNew" value="' + C.addDays(d.id, 1) + '">' +
      '<button class="btn btn-sm btn-outline" id="dpAdd">插入</button></div></div>' +
      '<div class="pop-foot"><button class="btn btn-sm btn-danger" id="dpDel">删除此列</button>' +
      '<button class="btn btn-sm btn-primary" id="dpSave">保存标签</button></div>';
    var pop = openPop(html, { anchor: th });
    $('#dpSave', pop).onclick = function () {
      pushUndo();
      d.tag = $('#dpTag', pop).value.trim();
      save(); renderGrid(); closePop();
      toast('已保存', 'ok', 1200);
    };
    $('#dpAdd', pop).onclick = function () {
      var iso = $('#dpNew', pop).value;
      if (!iso) return;
      if (g.dates.some(function (x) { return x.id === iso; })) return toast('该日期已存在', 'warn');
      pushUndo();
      var idx = g.dates.indexOf(d);
      g.dates.splice(idx + 1, 0, { id: iso, iso: iso, label: C.fmtLabel(iso), tag: '' });
      save(); renderGrid(); closePop();
      toast('已插入 ' + C.fmtLabel(iso), 'ok');
    };
    $('#dpDel', pop).onclick = function () {
      closePop();
      confirmBox('删除这一列日期？', '该日期下所有学生的考勤记录都会一起删除，且可以用 Ctrl+Z 撤销。', function () {
        pushUndo();
        g.dates = g.dates.filter(function (x) { return x.id !== d.id; });
        save(); renderGrid(); renderChrome();
        toast('已删除 ' + d.label);
      }, '删除');
    };
  }

  function openRowMenu(btn, r) {
    var g = curGroup();
    var st = g.students[r];
    if (!st) return;
    var html = '<div class="menu"><div class="pop-title" style="padding:4px 9px 6px">' + esc(st.name) + '</div>' +
      '<button class="menu-item" data-row-act="rename">重命名</button>' +
      '<button class="menu-item" data-row-act="up">上移</button>' +
      '<button class="menu-item" data-row-act="down">下移</button>' +
      '<div class="menu-sep"></div>' +
      '<button class="menu-item" data-row-act="stats">查看统计</button>' +
      '<button class="menu-item" data-row-act="clear">清空本周记录</button>' +
      '<div class="menu-sep"></div>' +
      '<button class="menu-item danger" data-row-act="del">删除学生</button></div>';
    var pop = openPop(html, { anchor: btn, cls: 'p-0' });
    $$('[data-row-act]', pop).forEach(function (b) {
      b.onclick = function () {
        var act = b.getAttribute('data-row-act');
        if (act === 'rename') {
          closePop();
          var name = window.prompt('重命名学生', st.name);
          if (name && name.trim() && name.trim() !== st.name) {
            pushUndo(); st.name = name.trim(); save(); renderGrid();
          }
          return;
        }
        if (act === 'up' || act === 'down') {
          var i = g.students.indexOf(st), j = act === 'up' ? i - 1 : i + 1;
          if (j < 0 || j >= g.students.length) return closePop();
          pushUndo();
          g.students.splice(i, 1); g.students.splice(j, 0, st);
          save(); renderGrid(); closePop();
          return;
        }
        if (act === 'stats') { closePop(); openStudentModal(st); return; }
        if (act === 'clear') {
          pushUndo();
          weekDateIds().forEach(function (d) {
            periods().forEach(function (p) { C.setStatus(g, st.id, d, p.id, ''); });
          });
          save(); renderGrid(); closePop();
          toast('已清空 ' + st.name + ' 本周记录', 'ok');
          return;
        }
        if (act === 'del') {
          closePop();
          confirmBox('删除学生「' + st.name + '」？', '该学生的所有考勤记录将一并删除。可用 Ctrl+Z 撤销。', function () {
            pushUndo();
            g.students = g.students.filter(function (x) { return x.id !== st.id; });
            C.clearStudent(g, st.id);
            save(); renderGrid(); renderChrome();
            toast('已删除');
          }, '删除');
        }
      };
    });
  }

  /* ------------------------------------------------------------------ *
   * 表格事件
   * ------------------------------------------------------------------ */
  var drag = null;

  function bindGridEvents() {
    var grid = $('#grid');
    if (!grid || grid.__bound) return;
    grid.__bound = true;

    grid.addEventListener('pointerdown', function (e) {
      var td = e.target.closest && e.target.closest('td.cell');
      if (!td || e.button !== 0) return;
      e.preventDefault();
      var r = +td.dataset.r, c = +td.dataset.c;
      if (e.shiftKey && state.anchor) {
        state.active = { r: r, c: c };
        state.sel = {
          r1: Math.min(state.anchor.r, r), r2: Math.max(state.anchor.r, r),
          c1: Math.min(state.anchor.c, c), c2: Math.max(state.anchor.c, c)
        };
        paintSel();
      } else {
        selectCell(r, c, false);
      }
      drag = { x: e.clientX, y: e.clientY, moved: false, r: r, c: c, td: td };
      closePop();
    });

    grid.addEventListener('click', function (e) {
      var th = e.target.closest && e.target.closest('th.day');
      if (th) { openDatePop(th); return; }
      var rb = e.target.closest && e.target.closest('[data-row-menu]');
      if (rb) { e.stopPropagation(); openRowMenu(rb, +rb.getAttribute('data-row-menu')); return; }
      var sum = e.target.closest && e.target.closest('[data-sum]');
      if (sum) { openStudentModal(curGroup().students[+sum.getAttribute('data-sum')]); return; }
    });

    grid.addEventListener('contextmenu', function (e) {
      var td = e.target.closest && e.target.closest('td.cell');
      if (!td) return;
      e.preventDefault();
      var r = +td.dataset.r, c = +td.dataset.c;
      if (!state.sel || r < state.sel.r1 || r > state.sel.r2 || c < state.sel.c1 || c > state.sel.c2) selectCell(r, c, false);
      openCellPop(td);
    });

    // 添加学生
    grid.addEventListener('keydown', function (e) {
      if (e.target.id !== 'addInput') return;
      if (e.key === 'Enter') { e.preventDefault(); addStudentsFromInput(); }
      if (e.key === 'Escape') { e.target.value = ''; e.target.blur(); }
    });
    grid.addEventListener('click', function (e) {
      if (e.target.id === 'addBtn') addStudentsFromInput();
    });
  }

  document.addEventListener('pointermove', function (e) {
    if (!drag) return;
    if (!drag.moved && Math.abs(e.clientX - drag.x) + Math.abs(e.clientY - drag.y) > 4) drag.moved = true;
    if (!drag.moved) return;
    var el = document.elementFromPoint(e.clientX, e.clientY);
    var td = el && el.closest ? el.closest('td.cell') : null;
    if (!td) return;
    var r = +td.dataset.r, c = +td.dataset.c;
    state.active = { r: r, c: c };
    state.sel = {
      r1: Math.min(state.anchor.r, r), r2: Math.max(state.anchor.r, r),
      c1: Math.min(state.anchor.c, c), c2: Math.max(state.anchor.c, c)
    };
    paintSel();
  });

  document.addEventListener('pointerup', function (e) {
    if (!drag) return;
    var d = drag;
    drag = null;
    if (!d.moved) {
      var td = d.td;
      if (td && td.isConnected) openCellPop(td);
    }
  });

  /* ------------------------------------------------------------------ *
   * 添加学生
   * ------------------------------------------------------------------ */
  function addStudentsFromInput() {
    var inp = $('#addInput');
    if (!inp) return;
    var names = C.parseNames(inp.value);
    if (!names.length) return;
    var g = curGroup();
    pushUndo();
    var exists = {};
    g.students.forEach(function (s) { exists[s.name] = 1; });
    var added = 0;
    names.forEach(function (n) {
      if (exists[n]) return;
      exists[n] = 1;
      g.students.push(C.newStudent(n));
      added++;
    });
    inp.value = '';
    save(); renderGrid(); renderChrome();
    if (added) toast('已添加 ' + added + ' 名学生', 'ok', 1300);
    else toast('这些姓名都已存在', 'warn');
    var again = $('#addInput');
    if (again) again.focus();
  }

  /* ------------------------------------------------------------------ *
   * 班级 / 小组
   * ------------------------------------------------------------------ */
  function addClass() {
    var name = window.prompt('新班级名称', (state.db.classes.length + 1) + '班');
    if (!name || !name.trim()) return;
    pushUndo();
    var c = C.newClass(name.trim());
    // 默认 4 个组
    for (var i = 1; i <= 4; i++) {
      var g = C.newGroup(i + '组', []);
      g.dates = C.makeDates(C.mondayOf(C.addDays(C.todayISO(), -28)), 24, weekSize());
      c.groups.push(g);
    }
    state.db.classes.push(c);
    state.classId = c.id; state.groupId = c.groups[0].id; state.week = 0;
    state.sel = state.anchor = state.active = null;
    save(); renderAll();
    toast('已创建 ' + c.name, 'ok');
  }

  function addGroup() {
    var c = curClass();
    if (!c) return addClass();
    var name = window.prompt('新小组名称', (c.groups.length + 1) + '组');
    if (!name || !name.trim()) return;
    pushUndo();
    var g = C.newGroup(name.trim(), []);
    var first = c.groups[0];
    g.dates = first && first.dates.length ? first.dates.map(function (d) { return { id: d.id, iso: d.iso, label: d.label, tag: d.tag }; })
      : C.makeDates(C.mondayOf(C.addDays(C.todayISO(), -28)), 24, weekSize());
    c.groups.push(g);
    state.groupId = g.id; state.week = 0;
    save(); renderAll();
  }

  /* ------------------------------------------------------------------ *
   * 日期生成
   * ------------------------------------------------------------------ */
  function generateDatesDialog() {
    var g = curGroup();
    var start = g && g.dates.length ? g.dates[0].id : C.mondayOf(C.addDays(C.todayISO(), -28));
    openModal({
      title: '生成学期日期列',
      sub: '按周生成，默认周一至周六（跳过周日），可随时在表头单独增删。',
      cls: 'sm',
      body: '<div class="row"><div class="field"><label>起始日期</label><input type="date" class="input" id="gdStart" value="' + start + '"></div>' +
        '<div class="field"><label>周数</label><input type="number" class="input" id="gdWeeks" value="24" min="1" max="60"></div></div>' +
        '<div class="note">将覆盖当前小组的日期列；已有记录按「日期」保留，被删除日期的记录不会立刻消失，但不再显示。</div>',
      foot: '<div class="right"><button class="btn btn-outline" data-close>取消</button>' +
        '<button class="btn btn-primary" id="gdOk">生成</button></div>',
      onMount: function (root) {
        $('#gdOk', root).onclick = function () {
          var s = $('#gdStart', root).value, w = Math.max(1, Math.min(60, +$('#gdWeeks', root).value || 24));
          if (!s) return;
          pushUndo();
          var dates = C.makeDates(s, w, weekSize());
          var g2 = curGroup();
          var old = {};
          g2.dates.forEach(function (d) { old[d.id] = d.tag; });
          g2.dates = dates.map(function (d) { return { id: d.id, iso: d.iso, label: d.label, tag: old[d.id] || '' }; });
          state.week = 0;
          save(); closeModal(); renderAll();
          toast('已生成 ' + dates.length + ' 天', 'ok');
        };
      }
    });
  }

  /* ------------------------------------------------------------------ *
   * 统计视图
   * ------------------------------------------------------------------ */
  function rangeDates(g, mode) {
    if (!g) return [];
    var ds = g.dates;
    if (mode === 'week') return ds.slice(weekStart(), weekStart() + weekSize()).map(function (d) { return d.id; });
    if (mode === 'month') {
      var ym = C.todayISO().slice(0, 7);
      var inMonth = ds.filter(function (d) { return d.id.slice(0, 7) === ym; });
      if (inMonth.length) return inMonth.map(function (d) { return d.id; });
      return ds.map(function (d) { return d.id; });
    }
    return ds.map(function (d) { return d.id; });
  }

  function renderStats() {
    var view = $('#viewStats');
    var g = curGroup(), c = curClass();
    if (!g) { view.innerHTML = '<div class="grid-empty" style="position:static"><div class="ge-box"><h3>先建一个班级</h3></div></div>'; return; }
    var ps = periods();
    var dIds = rangeDates(g, state.statsRange);
    var st = C.computeStats(g, dIds, ps);
    var fullCount = st.perStudent.filter(function (x) { return x.abnormal === 0 && x.total > 0; }).length;
    var rangeName = state.statsRange === 'week' ? '本周' : state.statsRange === 'month' ? '本月' : '全部';

    function card(k, v, sub, cls) {
      return '<div class="card"><div class="k">' + k + '</div><div class="v ' + (cls || '') + '">' + v + '</div>' +
        '<div class="sub">' + (sub || '') + '</div></div>';
    }

    var ratePct = (st.rate * 100).toFixed(1);
    var rateCls = st.rate >= 0.97 ? 'ok' : st.rate >= 0.9 ? 'warn' : 'bad';

    var html = '<div class="stats-head"><h2>统计 · ' + esc((c ? c.name + ' / ' : '') + g.name) + '</h2>' +
      '<span class="tag badge">' + esc(rangeName) + ' · ' + dIds.length + ' 天 · ' + st.students + ' 人</span>' +
      '<div class="seg">' +
      ['week', 'month', 'all'].map(function (k) {
        return '<button data-range="' + k + '" class="' + (state.statsRange === k ? 'on' : '') + '">' +
          (k === 'week' ? '本周' : k === 'month' ? '本月' : '全部') + '</button>';
      }).join('') + '</div></div>';

    html += '<div class="cards">' +
      card('出勤率', ratePct + '<small>%</small>', st.abnormal + ' 次异常 / ' + st.slots + ' 格', rateCls) +
      card('异常人次', st.abnormal, '共 ' + st.slots + ' 个应到格', st.abnormal ? 'warn' : '') +
      card('全勤人数', fullCount + '<small>/ ' + st.students + '</small>',
        fullCount === st.students ? '全部全勤' : '另有 ' + (st.students - fullCount) + ' 人有过异常', 'ok') +
      card('人均异常', st.students ? (st.abnormal / st.students).toFixed(1) : '0', '按 ' + st.students + ' 人计', '') +
      '</div>';

    html += '<div class="stats-grid" style="margin-top:12px">';

    // 左列
    html += '<div>';
    html += '<div class="panel"><h3>状态分布 <span class="tag">占异常人次</span></h3><div class="dist">';
    STATUSES.forEach(function (s) {
      var n = st.byStatus[s.key], pct = st.abnormal ? (n / st.abnormal * 100) : 0;
      html += '<div class="dist-row"><span style="color:' + s.color + ';font-weight:600">' + s.label + '</span>' +
        '<div class="dist-bar"><i style="--c:' + s.color + ';width:' + pct.toFixed(1) + '%"></i></div>' +
        '<span class="dist-n">' + n + '</span></div>';
    });
    html += '</div><div class="legend">' +
      '<span>迟到 ' + st.byStatus.late + '</span><span>早退 ' + st.byStatus.early + '</span>' +
      '<span>病假 ' + st.byStatus.sick + '</span><span>事假 ' + st.byStatus.leave + '</span>' +
      '<span>旷课 ' + st.byStatus.skip + '</span><span>缺勤 ' + st.byStatus.absent + '</span></div></div>';

    // 排名
    var top = st.perStudent.slice().sort(function (a, b) { return b.abnormal - a.abnormal || a.name.localeCompare(b.name, 'zh'); });
    html += '<div class="panel"><h3>学生排名 <span class="tag">按异常人次</span></h3>' +
      '<div style="max-height:340px;overflow:auto"><table class="rank"><thead><tr>' +
      '<th>#</th><th>姓名</th><th class="num">异常</th><th class="num">出勤率</th><th>主要问题</th></tr></thead><tbody>';
    top.forEach(function (s, i) {
      var rate = (s.rate * 100).toFixed(0);
      var cls = s.rate >= 0.97 ? '' : s.rate >= 0.9 ? 'low' : 'bad';
      html += '<tr><td class="num" style="color:var(--muted)">' + (i + 1) + '</td><td><b>' + esc(s.name) + '</b></td>' +
        '<td class="num">' + (s.abnormal || '—') + '</td>' +
        '<td class="num"><span class="rate ' + cls + '"><span class="bar"><i style="width:' + rate + '%"></i></span>' + rate + '%</span></td>' +
        '<td>' + (s.worst ? '<span class="pill" style="--c:' + s.worst.color + ';--soft:' + s.worst.soft + '">' +
          s.worst.label + ' ' + s.counts[s.worst.key] + '</span>' : '<span style="color:var(--muted)">—</span>') + '</td></tr>';
    });
    html += '</tbody></table></div></div></div>';

    // 右列
    html += '<div>';
    // 趋势
    var show = st.perDate;
    if (state.statsRange === 'all' && show.length > 40) show = show.slice(-40);
    var maxN = Math.max(1, Math.max.apply(null, show.map(function (x) { return x.abnormal; })));
    var small = show.length <= 14;
    html += '<div class="panel"><h3>每日异常趋势 <span class="tag">' +
      (state.statsRange === 'all' && st.perDate.length > 40 ? '最近 40 天' : '单日最多 ' + maxN + ' 次') +
      '</span></h3><div class="trend' + (small ? ' is-small' : '') + '">';
    show.forEach(function (d) {
      var hgt = d.abnormal ? Math.max(8, d.abnormal / maxN * 100) + '%' : '0px';
      html += '<div class="trend-col' + (d.abnormal ? '' : ' zero') + '" title="' + esc(d.label) + '：异常 ' + d.abnormal + ' 格">' +
        (small ? '<b class="tv">' + (d.abnormal || '') + '</b>' : '') +
        '<i style="height:' + hgt + '"></i></div>';
    });
    html += '</div><div class="trend-axis' + (small ? ' is-small' : '') + '">';
    if (small) {
      show.forEach(function (d) {
        html += '<span>' + esc(d.label.replace(/^\d+月/, '').replace(/日$/, '')) +
          '<i>' + esc(C.weekdayName(d.id).slice(1)) + '</i></span>';
      });
    } else {
      html += '<span>' + esc(show.length ? show[0].label : '') + '</span><span>' +
        esc(show.length ? show[show.length - 1].label : '') + '</span>';
    }
    html += '</div></div>';

    // 小组对比
    html += '<div class="panel"><h3>小组对比 <span class="tag">' + esc(rangeName) + '</span></h3>' +
      '<table class="rank"><thead><tr><th>小组</th><th class="num">人数</th><th class="num">异常</th><th class="num">出勤率</th></tr></thead><tbody>';
    (c ? c.groups : []).forEach(function (gg) {
      var ids = rangeDates(gg, state.statsRange);
      var s2 = C.computeStats(gg, ids, ps);
      var r2 = (s2.rate * 100).toFixed(1);
      html += '<tr><td>' + (gg.id === g.id ? '<b>' + esc(gg.name) + '</b>' : esc(gg.name)) + '</td>' +
        '<td class="num">' + s2.students + '</td><td class="num">' + s2.abnormal + '</td>' +
        '<td class="num"><span class="rate ' + (s2.rate >= 0.97 ? '' : s2.rate >= 0.9 ? 'low' : 'bad') + '">' +
        '<span class="bar"><i style="width:' + r2 + '%"></i></span>' + r2 + '%</span></td></tr>';
    });
    html += '</tbody></table></div>';
    html += '</div></div>';

    view.innerHTML = html;
    $$('[data-range]', view).forEach(function (b) {
      b.onclick = function () { state.statsRange = b.getAttribute('data-range'); renderStats(); };
    });
  }

  /* ------------------------------------------------------------------ *
   * 学生详情
   * ------------------------------------------------------------------ */
  function openStudentModal(st) {
    var g = curGroup();
    var allIds = allDateIds(g);
    var sumAll = C.summarize(g, st.id, allIds, periods());
    var sumWeek = C.summarize(g, st.id, weekDateIds(), periods());
    var html = '<div class="cards" style="grid-template-columns:repeat(3,1fr)">' +
      '<div class="card"><div class="k">全部出勤率</div><div class="v ' + (sumAll.rate >= 0.97 ? 'ok' : sumAll.rate >= 0.9 ? 'warn' : 'bad') + '">' +
      (sumAll.rate * 100).toFixed(1) + '<small>%</small></div><div class="sub">' + allIds.length + ' 天 × ' + periods().length + ' 时段</div></div>' +
      '<div class="card"><div class="k">本周异常</div><div class="v ' + (sumWeek.abnormal ? 'warn' : 'ok') + '">' + sumWeek.abnormal + '</div><div class="sub">本周 ' + weekDateIds().length + ' 天</div></div>' +
      '<div class="card"><div class="k">累计异常</div><div class="v">' + sumAll.abnormal + '</div><div class="sub">全部日期</div></div>' +
      '</div>';
    html += '<div class="panel" style="margin-top:14px;border:0;padding:0"><h3>状态统计 <span class="tag">全部日期</span></h3><div class="dist">';
    STATUSES.forEach(function (s) {
      var n = sumAll.counts[s.key], pct = sumAll.abnormal ? n / sumAll.abnormal * 100 : 0;
      html += '<div class="dist-row"><span style="color:' + s.color + ';font-weight:600">' + s.label + '</span>' +
        '<div class="dist-bar"><i style="--c:' + s.color + ';width:' + pct.toFixed(1) + '%"></i></div>' +
        '<span class="dist-n">' + n + '</span></div>';
    });
    html += '</div></div>';
    // 最近记录
    var recent = [];
    var cur = curGroup();
    cur.dates.forEach(function (d) {
      periods().forEach(function (p) {
        var s = C.getStatus(cur, st.id, d.id, p.id);
        if (s) recent.push({ d: d, p: p, s: C.STATUS_BY_KEY[s] });
      });
    });
    recent = recent.slice(-12).reverse();
    if (recent.length) {
      html += '<div style="margin-top:14px"><h3 style="font-size:13px;margin-bottom:8px">最近异常</h3><table class="rank"><tbody>';
      recent.forEach(function (x) {
        html += '<tr><td style="width:110px">' + esc(x.d.label) + '</td><td style="width:70px;color:var(--muted)">' + esc(x.p.name) + '</td>' +
          '<td><span class="pill" style="--c:' + x.s.color + ';--soft:' + x.s.soft + '">' + x.s.label + '</span></td></tr>';
      });
      html += '</tbody></table></div>';
    }
    openModal({
      title: st.name, sub: (curClass() ? curClass().name + ' / ' : '') + (g ? g.name : ''), cls: 'sm', body: html,
      foot: '<div class="right"><button class="btn btn-outline" data-close>关闭</button></div>'
    });
  }

  /* ------------------------------------------------------------------ *
   * 点名面板
   * ------------------------------------------------------------------ */
  function openRoll() {
    var g = curGroup();
    if (!g) return;
    var dates = g.dates.map(function (d) { return d.id; });
    if (!dates.length) return toast('先给小组生成日期列', 'warn');
    var today = C.todayISO();
    var dateId = dates.indexOf(today) >= 0 ? today : (dates.filter(function (d) { return d >= today; })[0] || dates[dates.length - 1]);
    var roll = { dateId: dateId, scope: 'all', cur: 0 };

    openModal({
      title: '点名 · ' + g.name,
      sub: '默认全部出勤：只点异常的学生即可。数字键 1-6 标记，0 清除，↑↓ 换行。',
      cls: 'md', bodyCls: 'p-0',
      body: '<div class="roll">' +
        '<div class="roll-top">' +
        '<div class="field" style="margin:0;flex:0 0 190px"><label style="font-size:11px">日期</label>' +
        '<select class="select" id="rollDate">' + dates.map(function (id, i) {
          var d = g.dates[i];
          return '<option value="' + id + '"' + (id === dateId ? ' selected' : '') + '>' + esc(d.label + ' ' + C.weekdayName(id)) + (d.tag ? ' · ' + esc(d.tag) : '') + '</option>';
        }).join('') + '</select></div>' +
        '<div class="field" style="margin:0;flex:0 0 120px"><label style="font-size:11px">时段</label>' +
        '<select class="select" id="rollScope"><option value="all">全天</option>' +
        periods().map(function (p) { return '<option value="' + p.id + '">' + esc(p.name) + '</option>'; }).join('') + '</select></div>' +
        '<div class="roll-sum" id="rollSum"></div>' +
        '<button class="btn btn-sm btn-outline" id="rollClear">清空本日</button>' +
        '</div>' +
        '<div class="roll-list" id="rollList"></div>' +
        '</div>',
      foot: '<div class="right">' +
        '<button class="btn btn-outline" id="rollPrevDay">上一天</button>' +
        '<button class="btn btn-outline" id="rollNextDay">下一天</button>' +
        '<button class="btn btn-primary" data-close>完成</button></div>',
      onMount: function (root) {
        state.roll = roll;
        bindRoll(root);
      }
    });
  }

  function rollStudents() {
    var g = curGroup();
    return g ? g.students : [];
  }

  function rollState(st) {
    var g = curGroup(), r = state.roll;
    var ps = periods();
    var use = r.scope === 'all' ? ps : ps.filter(function (p) { return p.id === r.scope; });
    var counts = {}, n = 0;
    use.forEach(function (p) {
      var s = C.getStatus(g, st.id, r.dateId, p.id);
      if (s) { counts[s] = (counts[s] || 0) + 1; n++; }
    });
    var keys = Object.keys(counts);
    return { counts: counts, n: n, all: keys.length === 1 && n === use.length ? keys[0] : (keys.length ? 'mixed' : ''), use: use };
  }

  function fillRoll() {
    var root = state.modal;
    if (!root || !state.roll) return;
    var g = curGroup(), r = state.roll;
    var ps = periods();
    var list = $('#rollList', root);
    var html = '';
    g.students.forEach(function (st, i) {
      var rs = rollState(st);
      html += '<div class="roll-row' + (i === r.cur ? ' cur' : '') + '" data-ri="' + i + '">' +
        '<div class="rn">' + (i + 1) + '</div>' +
        '<div class="rname" title="' + esc(st.name) + '">' + esc(st.name) + '</div>' +
        '<div class="roll-opts">';
      STATUSES.forEach(function (s) {
        html += '<button class="ropt' + (rs.all === s.key ? ' on' : '') + '" data-rsid="' + st.id + '" data-rkey="' + s.key +
          '" style="--c:' + s.color + ';--soft:' + s.soft + '">' + s.label + '<span class="k">' + s.hint + '</span></button>';
      });
      html += '<button class="ropt none' + (rs.all === '' ? ' on' : '') + '" data-rsid="' + st.id + '" data-rkey="">出勤<span class="k">0</span></button>';
      html += '</div></div>';
    });
    list.innerHTML = html;

    var ab = g.students.filter(function (st) { return rollState(st).n > 0; }).length;
    var totalAb = 0;
    g.students.forEach(function (st) { if (rollState(st).n) totalAb++; });
    var sum = $('#rollSum', root);
    if (sum) sum.innerHTML = '已标记异常 <b>' + ab + '</b> / ' + g.students.length + ' 人';

    $$('[data-rkey]', list).forEach(function (b) {
      b.onclick = function () {
        rollMark(b.getAttribute('data-rsid'), b.getAttribute('data-rkey'));
      };
    });
    $$('.roll-row', list).forEach(function (row) {
      row.onclick = function (e) {
        if (e.target.closest('[data-rkey]')) return;
        state.roll.cur = +row.getAttribute('data-ri');
        fillRoll();
      };
    });
  }

  function rollMark(sid, key) {
    var g = curGroup(), r = state.roll;
    var ps = periods();
    var use = r.scope === 'all' ? ps : ps.filter(function (p) { return p.id === r.scope; });
    pushUndo();
    use.forEach(function (p) { C.setStatus(g, sid, r.dateId, p.id, key); });
    save();
    fillRoll();
    updateUndoButtons();
  }

  function bindRoll(root) {
    $('#rollDate', root).onchange = function () {
      state.roll.dateId = this.value; state.roll.cur = 0; fillRoll();
    };
    $('#rollScope', root).onchange = function () {
      state.roll.scope = this.value; fillRoll();
    };
    $('#rollClear', root).onclick = function () {
      var g = curGroup();
      var use = state.roll.scope === 'all' ? periods()
        : periods().filter(function (p) { return p.id === state.roll.scope; });
      pushUndo();
      g.students.forEach(function (st) {
        use.forEach(function (p) { C.setStatus(g, st.id, state.roll.dateId, p.id, ''); });
      });
      save(); fillRoll();
      toast('已清空' + (state.roll.scope === 'all' ? '本日' : '该时段') + '记录', 'ok', 1200);
    };
    $('#rollPrevDay', root).onclick = function () { rollShiftDay(-1); };
    $('#rollNextDay', root).onclick = function () { rollShiftDay(1); };
    fillRoll();
  }

  function rollShiftDay(delta) {
    var g = curGroup();
    var i = g.dates.map(function (d) { return d.id; }).indexOf(state.roll.dateId);
    var j = i + delta;
    if (j < 0 || j >= g.dates.length) return toast('已经是' + (delta > 0 ? '最后一' : '第一') + '天', 'warn');
    state.roll.dateId = g.dates[j].id;
    state.roll.cur = 0;
    var sel = $('#rollDate');
    if (sel) sel.value = state.roll.dateId;
    fillRoll();
  }

  /* ------------------------------------------------------------------ *
   * 导入
   * ------------------------------------------------------------------ */
  function openImport(tab) {
    var c = curClass(), g = curGroup();
    var html = '<div class="mtabs">' +
      '<button data-itab="roster" class="' + (tab !== 'att' && tab !== 'backup' ? 'on' : '') + '">导入名单</button>' +
      '<button data-itab="att" class="' + (tab === 'att' ? 'on' : '') + '">导入考勤</button>' +
      '<button data-itab="backup" class="' + (tab === 'backup' ? 'on' : '') + '">恢复备份</button>' +
      '</div><div id="importBody"></div>';

    openModal({
      title: '导入', sub: '名单与考勤都可以直接从 Excel / 微信里粘贴，不需要装插件。',
      cls: 'md', body: html,
      foot: '<div class="right"><button class="btn btn-outline" data-close>关闭</button></div>',
      onMount: function (root) {
        function show(t) {
          $$('[data-itab]', root).forEach(function (b) { b.classList.toggle('on', b.getAttribute('data-itab') === t); });
          var box = $('#importBody', root);
          if (t === 'roster') box.innerHTML = rosterPane(c, g);
          else if (t === 'att') box.innerHTML = attPane(g);
          else box.innerHTML = backupPane();
          bindImport(t, root);
        }
        $$('[data-itab]', root).forEach(function (b) { b.onclick = function () { show(b.getAttribute('data-itab')); }; });
        show(tab || 'roster');
      }
    });
  }

  function rosterPane(c, g) {
    var classes = state.db.classes.map(function (k) {
      return '<option value="' + k.id + '"' + (c && k.id === c.id ? ' selected' : '') + '>' + esc(k.name) + '</option>';
    }).join('');
    var groups = (c ? c.groups : []).map(function (k) {
      return '<option value="' + k.id + '"' + (g && k.id === g.id ? ' selected' : '') + '>' + esc(k.name) + '</option>';
    }).join('');
    return '<div class="row"><div class="field"><label>班级</label><select class="select" id="impClass">' + classes + '</select></div>' +
      '<div class="field"><label>小组</label><select class="select" id="impGroup">' + groups + '</select></div></div>' +
      '<div class="field"><label>姓名列表</label>' +
      '<textarea class="textarea" id="impNames" style="min-height:168px" placeholder="每行一个姓名，也可以粘贴带「1组 / 2组」表头的整段名单。&#10;&#10;王梓涵&#10;李雨桐&#10;&#10;2组&#10;周雅琪"></textarea>' +
      '<div class="desc">支持换行、逗号、空格、顿号分隔；会自动去掉行首序号；默认跳过重名。</div></div>' +
      '<div class="inline" style="margin-bottom:10px">' +
      '<label class="check"><input type="checkbox" id="impSplit"> 按「1组 / 2组」自动分组</label>' +
      '<label class="check"><input type="checkbox" id="impReplace"> 替换该组原有名单（否则追加）</label></div>' +
      '<div id="impPreview"></div>' +
      '<div class="modal-foot" style="padding:12px 0 0;background:none;border:0"><div class="right">' +
      '<button class="btn btn-primary" id="impDo">导入</button></div></div>';
  }

  function attPane(g) {
    return '<div class="field"><label>目标小组</label><div class="inline">' +
      '<span class="badge">' + esc(g ? g.name : '—') + '</span>' +
      '<span class="desc">数据按「姓名 + 日期 + 时段」匹配，只覆盖表里出现的格子。</span></div></div>' +
      '<div class="field"><label>粘贴考勤表（或选择 .csv 文件）</label>' +
      '<textarea class="textarea" id="impAtt" style="min-height:190px" placeholder="把 Excel 里框选的内容直接粘贴进来，第一行需要包含「姓名」和日期表头。"></textarea>' +
      '<div class="inline"><input type="file" id="impFile" accept=".csv,.txt,.tsv"><span class="desc">CSV 会自动识别逗号 / 制表符</span></div></div>' +
      '<div id="impAttPreview"></div>' +
      '<div class="modal-foot" style="padding:12px 0 0;background:none;border:0"><div class="right">' +
      '<button class="btn btn-outline" id="impAttPreviewBtn">预览</button>' +
      '<button class="btn btn-primary" id="impAttDo">导入</button></div></div>';
  }

  function backupPane() {
    return '<div class="note" style="margin-bottom:14px">备份文件包含<b>全部班级、名单、考勤、标签</b>，是一份 JSON。<br>' +
      '换电脑或换浏览器时，导入这份文件即可完整恢复。</div>' +
      '<div class="set-list">' +
      '<div class="set-row"><div class="grow"><div class="t">导出当前备份</div><div class="d">' +
      (state.db ? '共 ' + state.db.classes.length + ' 个班级' : '') + ' · ' + (Math.round(JSON.stringify(state.db).length / 1024)) + ' KB</div></div>' +
      '<button class="btn btn-outline btn-sm" id="bkExport">导出</button></div>' +
      '<div class="set-row"><div class="grow"><div class="t">从备份恢复</div><div class="d">将覆盖当前全部数据</div></div>' +
      '<label class="btn btn-outline btn-sm" for="bkFile">选择文件</label><input type="file" id="bkFile" accept=".json" hidden></div>' +
      '</div>';
  }

  function bindImport(tab, root) {
    if (tab === 'roster') {
      var clsSel = $('#impClass', root), grpSel = $('#impGroup', root);
      clsSel.onchange = function () {
        var cc = C.findClass(state.db, clsSel.value);
        grpSel.innerHTML = (cc ? cc.groups : []).map(function (k) {
          return '<option value="' + k.id + '">' + esc(k.name) + '</option>';
        }).join('');
      };
      $('#impNames', root).oninput = updateRosterPreview;
      $('#impSplit', root).onchange = updateRosterPreview;
      updateRosterPreview();
      $('#impDo', root).onclick = doRosterImport;
    } else if (tab === 'att') {
      var ta = $('#impAtt', root);
      $('#impFile', root).onchange = function (e) {
        var f = e.target.files[0]; if (!f) return;
        var rd = new FileReader();
        rd.onload = function () { ta.value = rd.result; previewAtt(root); };
        rd.readAsText(f, 'utf-8');
      };
      ta.oninput = function () { $('#impAttPreview', root).innerHTML = ''; };
      $('#impAttPreviewBtn', root).onclick = function () { previewAtt(root); };
      $('#impAttDo', root).onclick = function () { doAttImport(root); };
    } else {
      $('#bkExport', root).onclick = exportBackup;
      $('#bkFile', root).onchange = function (e) {
        var f = e.target.files[0]; if (!f) return;
        var rd = new FileReader();
        rd.onload = function () {
          try {
            var obj = JSON.parse(rd.result);
            var db = C.normalizeDB(obj && obj.db ? obj.db : obj);
            if (!db.classes || !db.classes.length) throw new Error('bad');
            pushUndo();
            state.db = db;
            state.classId = db.classes[0] && db.classes[0].id;
            state.groupId = db.classes[0] && db.classes[0].groups[0] && db.classes[0].groups[0].id;
            state.week = 0;
            save(); closeModal(); renderAll();
            toast('备份已恢复', 'ok');
          } catch (err) {
            toast('文件格式不正确', 'err');
          }
        };
        rd.readAsText(f, 'utf-8');
      };
    }
  }

  function parseRosterBlocks(text) {
    var lines = String(text || '').split(/\r?\n/);
    var blocks = [], cur = { name: '', names: [] };
    lines.forEach(function (line) {
      var s = line.trim();
      if (!s) return;
      var m = s.match(/^第?\s*([0-9一二三四五六七八九十]+)\s*组\s*[:：]?$/);
      if (m) {
        if (cur.names.length) blocks.push(cur);
        cur = { name: '第' + m[1] + '组', names: [] };
        return;
      }
      cur.names = cur.names.concat(C.parseNames(s));
    });
    if (cur.names.length) blocks.push(cur);
    return blocks;
  }

  function updateRosterPreview() {
    var root = state.modal;
    if (!root) return;
    var text = $('#impNames', root).value;
    var split = $('#impSplit', root).checked;
    var box = $('#impPreview', root);
    if (!text.trim()) { box.innerHTML = ''; return; }
    var blocks = split ? parseRosterBlocks(text) : [{ name: '', names: C.parseNames(text) }];
    var total = blocks.reduce(function (a, b) { return a + b.names.length; }, 0);
    box.innerHTML = '<div class="note">识别到 <b>' + total + '</b> 个姓名' +
      (blocks.length > 1 ? '，分 <b>' + blocks.length + '</b> 组' : '') +
      (blocks.filter(function (b) { return b.names.length; }).some(function (b) { return b.name; })
        ? '，分组：' + blocks.map(function (b) { return (b.name || '默认') + '(' + b.names.length + ')'; }).join('、') : '') + '</div>';
  }

  function doRosterImport() {
    var root = state.modal;
    var split = $('#impSplit', root).checked;
    var replace = $('#impReplace', root).checked;
    var text = $('#impNames', root).value;
    var names = C.parseNames(text);
    if (!names.length) return toast('先粘贴姓名', 'warn');
    var cc = C.findClass(state.db, $('#impClass', root).value);
    if (!cc) return;
    pushUndo();

    var blocks = split ? parseRosterBlocks(text) : [];
    if (blocks.length === 1 && !blocks[0].name) blocks = [];   // 没写「1组/2组」就按单组处理

    if (blocks.length) {
      blocks.forEach(function (blk, i) {
        var g = cc.groups[i];
        if (!g) { g = C.newGroup((i + 1) + '组', []); cc.groups.push(g); }
        if (replace) { g.students = []; g.records = {}; }
        var exists = {};
        g.students.forEach(function (s) { exists[s.name] = 1; });
        var count = 0;
        blk.names.forEach(function (n) {
          if (exists[n]) return;
          exists[n] = 1; g.students.push(C.newStudent(n)); count++;
        });
        if (!g.dates.length) g.dates = C.makeDates(C.mondayOf(C.addDays(C.todayISO(), -28)), 24, weekSize());
      });
      state.classId = cc.id;
      state.groupId = cc.groups[0].id;
      state.week = 0;
      save(); closeModal(); renderAll();
      toast('已导入 ' + blocks.length + ' 个小组', 'ok');
      return;
    }

    var gid = $('#impGroup', root).value;
    var g = C.findGroup(state.db, cc.id, gid);
    if (!g) return;
    if (replace) { g.students = []; g.records = {}; }
    var exists2 = {};
    g.students.forEach(function (s) { exists2[s.name] = 1; });
    var added = 0;
    names.forEach(function (n) {
      if (exists2[n]) return;
      exists2[n] = 1; g.students.push(C.newStudent(n)); added++;
    });
    if (!g.dates.length) g.dates = C.makeDates(C.mondayOf(C.addDays(C.todayISO(), -28)), 24, weekSize());
    state.classId = cc.id; state.groupId = g.id; state.week = 0;
    save(); closeModal(); renderAll();
    toast('已导入 ' + added + ' 名学生' + (added < names.length ? '（跳过 ' + (names.length - added) + ' 个重复）' : ''), 'ok');
  }

  function previewAtt(root) {
    var g = curGroup();
    var text = $('#impAtt', root).value;
    var box = $('#impAttPreview', root);
    if (!text.trim()) return box.innerHTML = '<div class="note warn">没有内容</div>';
    var res = C.parseAttendance(text, g, periods());
    if (!res.cells.length && res.unmatchedCols.length) {
      box.innerHTML = '<div class="note warn">没有识别到日期列。表头里需要出现「姓名」以及「9月1日」这样的日期（可带 上午/下午/晚上）。</div>';
      return;
    }
    var byDate = {};
    res.cells.forEach(function (x) { byDate[x.dateId] = (byDate[x.dateId] || 0) + 1; });
    var dates = Object.keys(byDate);
    box.innerHTML = '<div class="note">识别到 <b>' + res.cells.length + '</b> 个考勤格，覆盖 <b>' + dates.length + '</b> 天' +
      (res.unmatched.length ? '；未匹配姓名：<b>' + esc(res.unmatched.slice(0, 8).join('、')) + (res.unmatched.length > 8 ? '…' : '') + '</b>' : '') +
      '</div>' + (dates.length ? '<div class="prev-table"><table><thead><tr><th>日期</th><th>识别格数</th></tr></thead><tbody>' +
        dates.slice(0, 12).map(function (d) { return '<tr><td>' + C.fmtLabel(d) + '</td><td>' + byDate[d] + '</td></tr>'; }).join('') +
        '</tbody></table></div>' : '');
  }

  function doAttImport(root) {
    var g = curGroup();
    var text = $('#impAtt', root).value;
    if (!text.trim()) return toast('先粘贴考勤表', 'warn');
    var res = C.parseAttendance(text, g, periods());
    if (!res.cells.length) return toast('没有可导入的数据', 'warn');
    pushUndo();
    C.applyAttendance(g, res.cells);
    save(); closeModal(); renderAll();
    toast('已写入 ' + res.cells.length + ' 个格', 'ok');
  }

  /* ------------------------------------------------------------------ *
   * 导出
   * ------------------------------------------------------------------ */
  function download(filename, data, mime) {
    var blob = data instanceof Blob ? data : new Blob([data], { type: mime || 'application/octet-stream' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 500);
  }

  function stamp() {
    var d = new Date();
    return d.getFullYear() + C.pad2(d.getMonth() + 1) + C.pad2(d.getDate()) + '-' + C.pad2(d.getHours()) + C.pad2(d.getMinutes());
  }

  function exportBackup() {
    var data = JSON.stringify(state.db, null, 1);
    download('速勤备份-' + stamp() + '.json', data, 'application/json');
    toast('备份已导出', 'ok');
  }

  function exportXLSX(scope) {
    var g = curGroup();
    var sheets = [];
    if (scope === 'group') {
      if (!g) return;
      var sh = C.groupSheet(g, periods(), (curClass() ? curClass().name + ' · ' : '') + g.name);
      sh.name = g.name;
      sheets.push(sh);
    } else {
      var c = curClass();
      if (!c) return;
      c.groups.forEach(function (k) {
        if (!k.students.length && !k.dates.length) return;
        var s2 = C.groupSheet(k, periods(), c.name + ' · ' + k.name);
        s2.name = c.name + '-' + k.name;
        sheets.push(s2);
      });
      if (!sheets.length) return toast('没有可导出的数据', 'warn');
    }
    try {
      var bytes = C.buildXLSX(sheets);
      download('速勤-' + (scope === 'group' ? (g ? g.name : '') : (curClass() ? curClass().name : '')) + '-' + stamp() + '.xlsx',
        new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
      toast('已导出 Excel', 'ok');
    } catch (e) {
      console.error(e);
      toast('导出失败：' + e.message, 'err');
    }
  }

  function exportCSV() {
    var g = curGroup();
    if (!g) return;
    var csv = C.toCSV(C.groupCSVRows(g, periods()));
    download('速勤-' + g.name + '-' + stamp() + '.csv', csv, 'text/csv;charset=utf-8');
    toast('已导出 CSV', 'ok');
  }

  function copyWeekTSV() {
    var g = curGroup(), dates = weekDates(), ps = periods(), today = C.todayISO();
    var rows = [['姓名'].concat(dates.map(function (d) { return d.label; }))];
    g.students.forEach(function (st) {
      rows.push([st.name].concat(dates.map(function (d) {
        var parts = [];
        ps.forEach(function (p) {
          var s = C.getStatus(g, st.id, d.id, p.id);
          if (s) parts.push(p.name + C.STATUS_BY_KEY[s].label);
        });
        return parts.join(' ');
      })));
    });
    var tsv = C.toTSV(rows);
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(tsv).then(function () { toast('本周表格已复制，可直接粘贴到 Excel', 'ok'); },
        function () { fallbackCopy(tsv); });
    } else fallbackCopy(tsv);
  }

  function fallbackCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); toast('已复制', 'ok'); } catch (e) { toast('复制失败', 'err'); }
    ta.remove();
  }

  function openExport() {
    var g = curGroup(), c = curClass();
    var btn = $('#btnExport');
    var html = '<div class="menu">' +
      '<button class="menu-item" data-ex="xlsx-group">导出当前组 Excel' + (g ? '（' + esc(g.name) + '）' : '') + '</button>' +
      '<button class="menu-item" data-ex="xlsx-class">导出全班 Excel（每组一个表）</button>' +
      '<button class="menu-item" data-ex="csv">导出当前组 CSV</button>' +
      '<button class="menu-item" data-ex="tsv">复制本周表格（TSV）</button>' +
      '<div class="menu-sep"></div>' +
      '<button class="menu-item" data-ex="backup">备份全部数据（JSON）</button>' +
      '<button class="menu-item" data-ex="import">从备份恢复…</button>' +
      '</div>';
    var pop = openPop(html, { anchor: btn });
    pop.style.minWidth = '260px';
    $$('[data-ex]', pop).forEach(function (b) {
      b.onclick = function () {
        var a = b.getAttribute('data-ex');
        closePop();
        if (a === 'xlsx-group') exportXLSX('group');
        else if (a === 'xlsx-class') exportXLSX('class');
        else if (a === 'csv') exportCSV();
        else if (a === 'tsv') copyWeekTSV();
        else if (a === 'backup') exportBackup();
        else if (a === 'import') openImport('backup');
      };
    });
  }

  /* ------------------------------------------------------------------ *
   * 设置
   * ------------------------------------------------------------------ */
  function openSettings() {
    var c = curClass(), g = curGroup();
    var html = '<div class="mtabs"><button class="on" data-st="org">班级与小组</button>' +
      '<button data-st="period">时段</button><button data-st="dates">日期</button>' +
      '<button data-st="data">数据</button><button data-st="share">云端共享</button></div><div id="setBody"></div>';
    openModal({
      title: '设置', sub: '所有改动立即保存。', cls: 'md', body: html,
      foot: '<div class="right"><button class="btn btn-outline" data-close>关闭</button></div>',
      onMount: function (root) {
        function show(t) {
          $$('[data-st]', root).forEach(function (b) { b.classList.toggle('on', b.getAttribute('data-st') === t); });
          var body = $('#setBody', root);
          if (t === 'org') body.innerHTML = setOrg();
          else if (t === 'period') body.innerHTML = setPeriod();
          else if (t === 'dates') body.innerHTML = setDates();
          else if (t === 'share') body.innerHTML = setShare();
          else body.innerHTML = setData();
          bindSet(t, root);
        }
        $$('[data-st]', root).forEach(function (b) { b.onclick = function () { show(b.getAttribute('data-st')); }; });
        show('org');
      }
    });
  }

  function setShare() {
    var cfg = cloudConfig();
    var modeName = { cloud: 'Supabase 云端', server: '本机服务器', local: '本机浏览器' }[state.mode] || state.mode;
    return '<div class="note" style="margin-bottom:12px">本页已<b>内置云端自动同步</b>：所有打开此页面的人读写同一份数据，' +
      '任何设备改动会在 15 秒内自动同步到其他设备，无需任何设置。当前存储：<b>' + esc(modeName) + '</b>。</div>' +
      (cfg && (cfg.url !== DEFAULT_CLOUD.url || cfg.key !== DEFAULT_CLOUD.key)
        ? '<div class="field"><label>Supabase 项目地址</label>' +
          '<input class="input" id="cloudUrl" placeholder="https://xxxx.supabase.co" value="' + esc(cfg.url) + '">' +
          '<div class="desc">Supabase 控制台 → Project Settings → API → Project URL</div></div>' +
          '<div class="field"><label>anon 公开密钥</label>' +
          '<textarea class="input" id="cloudKey" style="min-height:84px">' + esc(cfg.key) + '</textarea>' +
          '<div class="desc">Project Settings → API → Project API Keys → anon public。只给 anon 权限，不要用 service_role。</div></div>' +
          '<div class="inline" style="margin-top:4px">' +
          '<button class="btn btn-primary" id="cloudSave">保存自定义云端</button>' +
          '<button class="btn btn-outline" id="cloudTest">测试连接</button>' +
          '<button class="btn btn-danger" id="cloudOff">恢复默认云端</button>' +
          '</div><div id="cloudMsg" class="desc" style="margin-top:10px"></div>' +
          '<div class="note" style="margin-top:14px"><b>自建云端：</b>在 Supabase 的 SQL Editor 里执行下面这条建表语句：<br>' +
          '<code style="display:block;margin-top:8px;padding:10px;background:var(--bg-2);border-radius:8px;white-space:pre-wrap;font-size:11.5px">create table if not exists attendance_state (\n  id int primary key,\n  data jsonb not null,\n  updated_at timestamptz not null default now()\n);\nalter table attendance_state enable row level security;\ncreate policy "attend all" on attendance_state\n  for all to anon using (true) with check (true);</code></div>'
        : '<div class="desc" style="margin-top:6px">如需换成自己的 Supabase 项目，先在下方粘贴配置。</div>' +
          '<div class="field"><label>Supabase 项目地址</label>' +
          '<input class="input" id="cloudUrl" placeholder="https://xxxx.supabase.co"></div>' +
          '<div class="field"><label>anon 公开密钥</label>' +
          '<textarea class="input" id="cloudKey" style="min-height:84px" placeholder="eyJhbGciOi…（anon public key）"></textarea></div>' +
          '<div class="inline" style="margin-top:4px">' +
          '<button class="btn btn-primary" id="cloudSave">使用我的云端</button>' +
          '<button class="btn btn-outline" id="cloudTest">测试连接</button>' +
          '</div><div id="cloudMsg" class="desc" style="margin-top:10px"></div>');
  }

  function setOrg() {
    var c = curClass();
    var html = '<div class="set-list">';
    state.db.classes.forEach(function (k) {
      html += '<div class="set-row"><div class="grow"><div class="t">' + esc(k.name) + '</div>' +
        '<div class="d">' + k.groups.length + ' 个小组 · ' + k.groups.reduce(function (a, x) { return a + x.students.length; }, 0) + ' 人</div></div>' +
        '<button class="btn btn-sm btn-outline" data-sact="rename-class" data-id="' + k.id + '">重命名</button>' +
        '<button class="btn btn-sm btn-danger" data-sact="del-class" data-id="' + k.id + '">删除</button></div>';
    });
    html += '</div><div class="inline" style="margin-top:12px"><button class="btn btn-primary btn-sm" data-sact="add-class">新建班级</button></div>';

    if (c) {
      html += '<h3 style="font-size:13px;margin:20px 0 10px">' + esc(c.name) + ' 的小组</h3><div class="set-list">';
      c.groups.forEach(function (k) {
        html += '<div class="set-row"><div class="grow"><div class="t">' + esc(k.name) + '</div>' +
          '<div class="d">' + k.students.length + ' 人 · ' + k.dates.length + ' 天</div></div>' +
          '<button class="btn btn-sm btn-outline" data-sact="rename-group" data-id="' + k.id + '">重命名</button>' +
          '<button class="btn btn-sm btn-outline" data-sact="clear-group" data-id="' + k.id + '">清空记录</button>' +
          '<button class="btn btn-sm btn-danger" data-sact="del-group" data-id="' + k.id + '">删除</button></div>';
      });
      html += '</div><div class="inline" style="margin-top:12px"><button class="btn btn-outline btn-sm" data-sact="add-group">新建小组</button></div>';
    }
    return html;
  }

  function setPeriod() {
    var ps = periods();
    var html = '<div class="note" style="margin-bottom:12px">时段会作为每一天的列。多数班级用「上午 / 下午 / 晚上」，可以按需改名或增减。</div><div class="set-list">';
    ps.forEach(function (p, i) {
      html += '<div class="set-row"><span class="badge">' + (i + 1) + '</span>' +
        '<input class="input" style="max-width:220px" data-pid="' + p.id + '" value="' + esc(p.name) + '">' +
        '<button class="btn btn-sm btn-outline" data-pact="up" data-id="' + p.id + '">上移</button>' +
        '<button class="btn btn-sm btn-outline" data-pact="down" data-id="' + p.id + '">下移</button>' +
        '<button class="btn btn-sm btn-danger" data-pact="del" data-id="' + p.id + '">删除</button></div>';
    });
    html += '</div><div class="inline" style="margin-top:12px"><button class="btn btn-outline btn-sm" data-pact="add">添加时段</button>' +
      '<span class="desc">最多 5 个</span></div>';
    return html;
  }

  function setDates() {
    var g = curGroup();
    if (!g) return '<div class="note">先选择一个小组</div>';
    var first = g.dates[0], last = g.dates[g.dates.length - 1];
    return '<div class="note" style="margin-bottom:12px">当前：<b>' + (first ? first.label : '—') + '</b> 至 <b>' +
      (last ? last.label : '—') + '</b>，共 <b>' + g.dates.length + '</b> 天。' +
      '单独某天的标签 / 增删，直接点表头日期。</div>' +
      '<div class="row"><div class="field"><label>起始日期</label><input type="date" class="input" id="setStart" value="' +
      (first ? first.id : C.mondayOf(C.todayISO())) + '"></div>' +
      '<div class="field"><label>周数</label><input type="number" class="input" id="setWeeks" value="' +
      Math.ceil(g.dates.length / weekSize()) + '" min="1" max="60"></div>' +
      '<div class="field" style="flex:0 0 auto"><label>&nbsp;</label><button class="btn btn-primary" id="setGen">重新生成</button></div></div>' +
      '<div class="row"><div class="field"><label>添加单日</label><input type="date" class="input" id="setOne" value="' + C.addDays(C.todayISO(), 1) + '"></div>' +
      '<div class="field" style="flex:0 0 auto"><label>&nbsp;</label><button class="btn btn-outline" id="setAddOne">添加</button></div></div>';
  }

  function setData() {
    var bytes = 0;
    try { bytes = new Blob([JSON.stringify(state.db)]).size; } catch (e) { }
    var val = localStorage.getItem(C.APP.dbKey) || '';
    return '<dl class="kv">' +
      '<dt>班级</dt><dd>' + state.db.classes.length + ' 个</dd>' +
      '<dt>小组</dt><dd>' + state.db.classes.reduce(function (a, c) { return a + c.groups.length; }, 0) + ' 个</dd>' +
      '<dt>学生</dt><dd>' + state.db.classes.reduce(function (a, c) {
        return a + c.groups.reduce(function (b, g) { return b + g.students.length; }, 0);
      }, 0) + ' 人</dd>' +
      '<dt>数据大小</dt><dd>' + (bytes / 1024).toFixed(1) + ' KB（本机存储上限约 5 MB）</dd>' +
      '<dt>保存时间</dt><dd>' + (state.lastSaved ? new Date(state.lastSaved).toLocaleString('zh-CN') : '—') + '</dd>' +
      '<dt>存储位置</dt><dd style="word-break:break-all;color:var(--muted)">localStorage · ' + esc(C.APP.dbKey) + '</dd>' +
      '</dl>' +
      '<div class="set-list" style="margin-top:16px">' +
      '<div class="set-row"><div class="grow"><div class="t">导出备份</div><div class="d">建议每周导出一份，微信发给自己也安全</div></div>' +
      '<button class="btn btn-outline btn-sm" data-dact="backup">导出</button></div>' +
      '<div class="set-row"><div class="grow"><div class="t">载入示例数据</div><div class="d">会覆盖当前数据</div></div>' +
      '<button class="btn btn-outline btn-sm" data-dact="demo">载入</button></div>' +
      '<div class="set-row"><div class="grow"><div class="t">清空全部数据</div><div class="d">不可恢复，请先备份</div></div>' +
      '<button class="btn btn-danger btn-sm" data-dact="wipe">清空</button></div>' +
      '</div>';
  }

  function bindSet(tab, root) {
    if (tab === 'org') {
      $$('[data-sact]', root).forEach(function (b) {
        b.onclick = function () {
          var act = b.getAttribute('data-sact'), id = b.getAttribute('data-id');
          if (act === 'add-class') { closeModal(); addClass(); return; }
          if (act === 'add-group') { closeModal(); addGroup(); return; }
          if (act === 'rename-class') {
            var cc = C.findClass(state.db, id);
            var n1 = window.prompt('班级名称', cc.name);
            if (n1 && n1.trim()) { pushUndo(); cc.name = n1.trim(); save(); renderAll(); openSettings(); }
            return;
          }
          if (act === 'rename-group') {
            var gg = null;
            state.db.classes.forEach(function (c) { c.groups.forEach(function (x) { if (x.id === id) gg = x; }); });
            var n2 = window.prompt('小组名称', gg.name);
            if (n2 && n2.trim()) { pushUndo(); gg.name = n2.trim(); save(); renderAll(); openSettings(); }
            return;
          }
          if (act === 'del-class') {
            confirmBox('删除班级？', '该班级下所有小组、名单、考勤都会删除。可用 Ctrl+Z 撤销。', function () {
              pushUndo();
              state.db.classes = state.db.classes.filter(function (c) { return c.id !== id; });
              if (state.classId === id) {
                state.classId = state.db.classes[0] ? state.db.classes[0].id : null;
                state.groupId = state.db.classes[0] && state.db.classes[0].groups[0] ? state.db.classes[0].groups[0].id : null;
              }
              save(); renderAll(); openSettings();
            }, '删除');
            return;
          }
          if (act === 'del-group') {
            confirmBox('删除小组？', '该小组的名单与考勤会一起删除。可用 Ctrl+Z 撤销。', function () {
              pushUndo();
              var c2 = curClass();
              c2.groups = c2.groups.filter(function (x) { return x.id !== id; });
              if (state.groupId === id) state.groupId = c2.groups[0] ? c2.groups[0].id : null;
              save(); renderAll(); openSettings();
            }, '删除');
            return;
          }
          if (act === 'clear-group') {
            confirmBox('清空该组全部考勤记录？', '名单保留，记录清空。可用 Ctrl+Z 撤销。', function () {
              pushUndo();
              var gg2 = null;
              state.db.classes.forEach(function (c) { c.groups.forEach(function (x) { if (x.id === id) gg2 = x; }); });
              gg2.records = {};
              save(); renderAll(); openSettings();
              toast('已清空记录', 'ok');
            }, '清空');
          }
        };
      });
      return;
    }
    if (tab === 'period') {
      $$('[data-pid]', root).forEach(function (inp) {
        inp.onchange = function () {
          var p = C.periodById(state.db, inp.getAttribute('data-pid'));
          var v = inp.value.trim();
          if (p && v) { pushUndo(); p.name = v; save(); renderAll(); }
        };
      });
      $$('[data-pact]', root).forEach(function (b) {
        b.onclick = function () {
          var act = b.getAttribute('data-pact'), id = b.getAttribute('data-id');
          var ps = periods();
          if (act === 'add') {
            if (ps.length >= 5) return toast('最多 5 个时段', 'warn');
            pushUndo();
            ps.push({ id: 'p' + Date.now().toString(36), name: '时段' + (ps.length + 1) });
            save(); openSettings(); renderAll();
            return;
          }
          var i = ps.map(function (p) { return p.id; }).indexOf(id);
          if (act === 'del') {
            if (ps.length <= 1) return toast('至少保留一个时段', 'warn');
            pushUndo(); ps.splice(i, 1); save(); openSettings(); renderAll();
            return;
          }
          var j = act === 'up' ? i - 1 : i + 1;
          if (j < 0 || j >= ps.length) return;
          pushUndo();
          var tmp = ps[i]; ps[i] = ps[j]; ps[j] = tmp;
          save(); openSettings(); renderAll();
        };
      });
      return;
    }
    if (tab === 'dates') {
      $('#setGen', root).onclick = function () {
        var s = $('#setStart', root).value, w = Math.max(1, Math.min(60, +$('#setWeeks', root).value || 24));
        if (!s) return;
        confirmBox('重新生成日期列？', '将按新范围覆盖该小组的日期列，已有记录按日期保留。', function () {
          pushUndo();
          var g = curGroup(), old = {};
          g.dates.forEach(function (d) { old[d.id] = d.tag; });
          g.dates = C.makeDates(s, w, weekSize()).map(function (d) { return { id: d.id, iso: d.iso, label: d.label, tag: old[d.id] || '' }; });
          state.week = 0;
          save(); renderAll(); openSettings();
          toast('已生成 ' + g.dates.length + ' 天', 'ok');
        }, '生成');
      };
      $('#setAddOne', root).onclick = function () {
        var iso = $('#setOne', root).value;
        if (!iso) return;
        var g = curGroup();
        if (g.dates.some(function (d) { return d.id === iso; })) return toast('该日期已存在', 'warn');
        pushUndo();
        g.dates.push({ id: iso, iso: iso, label: C.fmtLabel(iso), tag: '' });
        g.dates.sort(function (a, b) { return a.id < b.id ? -1 : 1; });
        save(); renderAll(); openSettings();
      };
      return;
    }
    if (tab === 'share') {
      var msg = $('#cloudMsg', root);
      function showMsg(t, kind) {
        msg.innerHTML = '<span style="color:' + (kind === 'err' ? 'var(--bad)' : kind === 'ok' ? 'var(--ok)' : 'var(--muted)') + '">' + esc(t) + '</span>';
      }
      $('#cloudSave', root).onclick = function () {
        var url = $('#cloudUrl', root).value.trim().replace(/\/+$/, '');
        var key = $('#cloudKey', root).value.trim();
        if (!/^https:\/\/.+\.supabase\.co/.test(url)) return showMsg('地址要以 https:// 开头、.supabase.co 结尾', 'err');
        if (!key || key.length < 30) return showMsg('anon key 看起来不对，应该是一长串以 eyJ 开头的字符', 'err');
        saveCloudConfig({ url: url, key: key });
        cloudCfgPromise = null;
        showMsg('正在测试…');
        cloudFetch('GET').then(function (res) {
          if (res.ok) {
            showMsg('连接成功！正在切换到云端存储…', 'ok');
            setTimeout(function () { location.reload(); }, 700);
          } else {
            showMsg('连上了地址但读不到数据表：' + (res.error || '') + '。请先在 Supabase SQL Editor 里执行上面的建表语句。', 'err');
          }
        });
      };
      $('#cloudTest', root).onclick = function () {
        var url = $('#cloudUrl', root).value.trim().replace(/\/+$/, '');
        var key = $('#cloudKey', root).value.trim();
        if (!url || !key) return showMsg('先填地址和 key', 'err');
        saveCloudConfig({ url: url, key: key });
        cloudCfgPromise = null;
        showMsg('正在测试…');
        cloudFetch('GET').then(function (res) {
          if (res.ok) showMsg(res.db ? '连接成功，云端已有数据（' + res.db.classes.length + ' 个班级）' : '连接成功，云端还没有数据', 'ok');
          else showMsg('失败：' + (res.error || '') + '。若 404，先执行上面的建表语句。', 'err');
        });
      };
      var off = $('#cloudOff', root);
      if (off) off.onclick = function () {
        confirmBox('恢复默认云端？', '将清除自定义 Supabase 配置，回到页面内置的云端共享。', function () {
          saveCloudConfig(null);
          cloudCfgPromise = null;
          location.reload();
        }, '恢复默认');
      };
      return;
    }
    if (tab === 'data') {
      $$('[data-dact]', root).forEach(function (b) {
        b.onclick = function () {
          var a = b.getAttribute('data-dact');
          if (a === 'backup') return exportBackup();
          if (a === 'demo') {
            confirmBox('载入示例数据？', '会覆盖当前全部数据。', function () {
              pushUndo();
              state.db = C.seedDemo();
              state.db.meta.demo = true;
              state.classId = state.db.classes[0].id;
              state.groupId = state.db.classes[0].groups[0].id;
              state.week = 0;
              save(); renderAll(); closeModal();
              toast('示例数据已载入', 'ok');
            }, '载入');
            return;
          }
          if (a === 'wipe') {
            confirmBox('清空全部数据？', '所有班级、名单、考勤都会被删除，且无法撤销。建议先导出备份。', function () {
              state.undo.length = 0; state.redo.length = 0;
              state.db = blankDB();
              state.classId = state.db.classes[0].id;
              state.groupId = state.db.classes[0].groups[0].id;
              state.week = 0;
              saveNow(); renderAll(); closeModal();
              toast('已清空');
            }, '清空');
          }
        };
      });
    }
  }

  function blankDB() {
    var db = C.emptyDB();
    var c = C.newClass('1班');
    for (var i = 1; i <= 4; i++) {
      var g = C.newGroup(i + '组', []);
      g.dates = C.makeDates(C.mondayOf(C.addDays(C.todayISO(), -28)), 24, db.settings.weekSize);
      c.groups.push(g);
    }
    db.classes.push(c);
    return db;
  }

  /* ------------------------------------------------------------------ *
   * 通用弹窗 / 提示
   * ------------------------------------------------------------------ */
  function openModal(opts) {
    closeModal();
    var layer = $('#modalLayer');
    layer.classList.add('open');
    layer.innerHTML = '<div class="modal-mask"></div>' +
      '<div class="modal ' + (opts.cls || '') + '">' +
      '<div class="modal-head"><div><h2>' + (opts.title || '') + '</h2>' +
      (opts.sub ? '<p>' + opts.sub + '</p>' : '') + '</div>' +
      '<button class="modal-close" data-close>' + ICON.close + '</button></div>' +
      '<div class="modal-body ' + (opts.bodyCls || '') + '">' + (opts.body || '') + '</div>' +
      (opts.foot ? '<div class="modal-foot">' + opts.foot + '</div>' : '') +
      '</div>';
    state.modal = layer;
    layer.querySelector('.modal-mask').onclick = closeModal;
    $$('[data-close]', layer).forEach(function (b) { b.onclick = closeModal; });
    if (opts.onMount) opts.onMount(layer);
  }

  function closeModal() {
    var layer = $('#modalLayer');
    layer.classList.remove('open');
    layer.innerHTML = '';
    state.modal = null;
    state.roll = null;
  }

  function confirmBox(title, body, onOk, okLabel) {
    openModal({
      title: title, cls: 'sm',
      body: '<div class="note">' + body + '</div>',
      foot: '<div class="right"><button class="btn btn-outline" data-close>取消</button>' +
        '<button class="btn btn-primary" id="cfmOk">' + (okLabel || '确定') + '</button></div>',
      onMount: function (root) {
        $('#cfmOk', root).onclick = function () { closeModal(); onOk(); };
      }
    });
  }

  var toastTimer = 0;
  function toast(msg, kind, ms) {
    var layer = $('#toastLayer');
    var el = document.createElement('div');
    el.className = 'toast ' + (kind || '');
    el.textContent = msg;
    layer.appendChild(el);
    setTimeout(function () {
      el.style.transition = 'opacity .25s, transform .25s';
      el.style.opacity = '0'; el.style.transform = 'translateY(6px)';
      setTimeout(function () { el.remove(); }, 260);
    }, ms || 2200);
  }

  /* ------------------------------------------------------------------ *
   * 搜索
   * ------------------------------------------------------------------ */
  function bindSearch() {
    var input = $('#searchInput'), box = $('#searchResults');
    function run() {
      var q = input.value.trim();
      if (!q) { box.hidden = true; box.innerHTML = ''; return; }
      var list = C.searchStudents(state.db, q);
      if (!list.length) {
        box.innerHTML = '<div class="sr-empty">没有找到「' + esc(q) + '」</div>';
        box.hidden = false;
        return;
      }
      box.innerHTML = list.slice(0, 24).map(function (s, i) {
        return '<div class="sr-item' + (i === 0 ? ' on' : '') + '" data-cid="' + s.classId + '" data-gid="' + s.groupId + '" data-sid="' + s.studentId + '">' +
          '<span class="sr-name">' + esc(s.name) + '</span>' +
          '<span class="sr-meta">' + esc(s.className + ' · ' + s.groupName) + '</span></div>';
      }).join('');
      box.hidden = false;
      $$('.sr-item', box).forEach(function (it) {
        it.onclick = function () {
          gotoStudent(it.getAttribute('data-cid'), it.getAttribute('data-gid'), it.getAttribute('data-sid'));
          input.value = ''; box.hidden = true;
        };
      });
    }
    input.addEventListener('input', run);
    input.addEventListener('focus', function () { if (input.value.trim()) run(); });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { input.value = ''; box.hidden = true; input.blur(); }
      if (e.key === 'Enter') {
        var first = $('.sr-item', box);
        if (first) { first.click(); }
      }
    });
    document.addEventListener('click', function (e) {
      if (!e.target.closest || !e.target.closest('.search')) box.hidden = true;
    });
  }

  function gotoStudent(cid, gid, sid) {
    state.classId = cid; state.groupId = gid; state.view = 'grid';
    var g = curGroup();
    if (!g) return;
    var idx = g.students.map(function (s) { return s.id; }).indexOf(sid);
    state.week = Math.min(state.week, weekCount(g) - 1);
    state.sel = state.anchor = state.active = null;
    save(); renderAll();
    if (idx < 0) return;
    selectCell(idx, 0, false);
    setTimeout(function () {
      var td = $('#grid td.cell[data-r="' + idx + '"][data-c="0"]');
      if (!td) return;
      td.classList.add('pulse');
      setTimeout(function () { td.classList.remove('pulse'); }, 900);
    }, 30);
  }

  /* ------------------------------------------------------------------ *
   * 快捷键
   * ------------------------------------------------------------------ */
  function bindKeys() {
    document.addEventListener('keydown', function (e) {
      // 点名面板优先
      if (state.modal && state.roll) {
        var tag = (e.target.tagName || '').toUpperCase();
        if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
        var rows = rollStudents();
        if (e.key === 'Escape') { state.roll = null; closeModal(); return; }
        if (e.key === 'ArrowDown') { e.preventDefault(); state.roll.cur = Math.min(rows.length - 1, state.roll.cur + 1); fillRoll(); scrollRollCur(); return; }
        if (e.key === 'ArrowUp') { e.preventDefault(); state.roll.cur = Math.max(0, state.roll.cur - 1); fillRoll(); scrollRollCur(); return; }
        if (e.key === 'Enter') { e.preventDefault(); state.roll.cur = Math.min(rows.length - 1, state.roll.cur + 1); fillRoll(); scrollRollCur(); return; }
        if (/^[0-6]$/.test(e.key)) {
          e.preventDefault();
          var st = rows[state.roll.cur];
          if (!st) return;
          var key = e.key === '0' ? '' : STATUSES[+e.key - 1].key;
          rollMark(st.id, key);
          state.roll.cur = Math.min(rows.length - 1, state.roll.cur + 1);
          fillRoll(); scrollRollCur();
          return;
        }
        return;
      }
      if (state.modal) {
        if (e.key === 'Escape') return closeModal();
        return;
      }
      var t = e.target;
      var tagName = (t && t.tagName || '').toUpperCase();
      if (tagName === 'INPUT' || tagName === 'TEXTAREA' || tagName === 'SELECT' || (t && t.isContentEditable)) return;

      var mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) redo(); else undo();
        return;
      }
      if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
      if (mod && e.key === 'Enter') { e.preventDefault(); openRoll(); return; }
      if (mod && e.key.toLowerCase() === 'f') { e.preventDefault(); $('#searchInput').focus(); return; }
      if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); saveNow(); toast('已保存', 'ok', 1000); return; }
      if (e.key === 'Escape') { closePop(); clearSelection(); return; }
      if (state.view !== 'grid') return;

      if (e.altKey && e.key === 'ArrowLeft') { e.preventDefault(); goWeek(state.week - 1); return; }
      if (e.altKey && e.key === 'ArrowRight') { e.preventDefault(); goWeek(state.week + 1); return; }

      var g = curGroup();
      if (!g || !g.students.length) return;
      var rows = g.students.length, cols = weekDates().length * periods().length;

      if (!state.active) {
        if (/^[1-6]$/.test(e.key) || e.key === '0') { selectCell(0, 0, false); applyStatus(e.key === '0' ? '' : STATUSES[+e.key - 1].key); return; }
        if (e.key.indexOf('Arrow') === 0) { e.preventDefault(); selectCell(0, 0, false); return; }
        return;
      }

      if (/^[1-6]$/.test(e.key)) { e.preventDefault(); applyStatus(STATUSES[+e.key - 1].key); return; }
      if (e.key === '0' || e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); applyStatus(''); return; }
      if (e.key === 'Enter') {
        e.preventDefault();
        var td = $('#grid td.cell[data-r="' + state.active.r + '"][data-c="' + state.active.c + '"]');
        if (td) openCellPop(td);
        return;
      }
      var dr = 0, dc = 0;
      if (e.key === 'ArrowUp') dr = -1;
      else if (e.key === 'ArrowDown') dr = 1;
      else if (e.key === 'ArrowLeft') dc = -1;
      else if (e.key === 'ArrowRight') dc = 1;
      else return;
      e.preventDefault();
      var nr = state.active.r + dr, nc = state.active.c + dc;
      if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) return;
      selectCell(nr, nc, e.shiftKey);
    });
  }

  function scrollRollCur() {
    var el = $('#modalLayer .roll-row.cur');
    if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
  }

  /* ------------------------------------------------------------------ *
   * 周导航
   * ------------------------------------------------------------------ */
  function goWeek(i) {
    var total = weekCount();
    var n = Math.max(0, Math.min(total - 1, i));
    if (n === state.week) return;
    state.week = n;
    state.sel = state.anchor = state.active = null;
    renderChrome(); renderGrid();
  }

  function goToday() {
    var g = curGroup();
    if (!g) return;
    var today = C.todayISO();
    var idx = g.dates.map(function (d) { return d.id; }).indexOf(today);
    if (idx < 0) {
      toast('当前日期不在日期列中，可以在「设置 → 日期」里调整', 'warn', 3000);
      return;
    }
    state.week = Math.floor(idx / weekSize());
    state.sel = state.anchor = state.active = null;
    renderChrome(); renderGrid();
    setTimeout(function () {
      var td = $('#grid td.cell.is-today');
      if (td) td.scrollIntoView({ block: 'nearest', inline: 'center' });
    }, 20);
  }

  /* ------------------------------------------------------------------ *
   * 主题
   * ------------------------------------------------------------------ */
  function applyTheme(t) {
    document.documentElement.setAttribute('data-theme', t);
    try { localStorage.setItem('suqin_theme', t); } catch (e) { }
  }

  function toggleTheme() {
    var cur = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    applyTheme(cur);
    renderChrome();
  }

  /* ------------------------------------------------------------------ *
   * 帮助
   * ------------------------------------------------------------------ */
  function openHelp() {
    var rows = [
      ['单击格子', '打开标记面板'],
      ['拖动 / Shift+单击', '矩形批量选择'],
      ['1 – 6', '标记迟到 / 早退 / 病假 / 事假 / 旷课 / 缺勤'],
      ['0 或 Delete', '清除标记（= 出勤）'],
      ['方向键 / Shift+方向键', '移动 / 扩展选区'],
      ['Enter', '打开当前格标记面板'],
      ['Ctrl + Z / Ctrl + Shift + Z', '撤销 / 重做'],
      ['Alt + ← / →', '上一周 / 下一周'],
      ['Ctrl + Enter', '打开点名面板'],
      ['Ctrl + F', '搜索学生'],
      ['Ctrl + S', '立即保存（平时自动保存）']
    ];
    openModal({
      title: '快捷键与使用说明', cls: 'md',
      body: '<div class="kbd-grid">' + rows.map(function (r) {
        return '<div><span>' + r[1] + '</span><kbd>' + r[0] + '</kbd></div>';
      }).join('') + '</div>' +
        '<div class="note" style="margin-top:16px">' +
        '<b>数据在哪？</b> 只存在当前浏览器的 localStorage 里，不上传任何服务器。换电脑、清理浏览器数据前，请用「导出 → 备份全部数据」保存一份 JSON。' +
        '</div>',
      foot: '<div class="right"><button class="btn btn-primary" data-close>知道了</button></div>'
    });
  }

  /* ------------------------------------------------------------------ *
   * 启动
   * ------------------------------------------------------------------ */
  function bindChrome() {
    $('#classTabs').addEventListener('click', function (e) {
      var b = e.target.closest('[data-class]');
      if (b) {
        state.classId = b.getAttribute('data-class');
        var c = curClass();
        state.groupId = c && c.groups[0] ? c.groups[0].id : null;
        state.week = 0;
        state.sel = state.anchor = state.active = null;
        save(); renderAll();
        return;
      }
      if (e.target.closest('[data-add-class]')) addClass();
    });

    $('#groupTabs').addEventListener('click', function (e) {
      var b = e.target.closest('[data-group]');
      if (b) {
        state.groupId = b.getAttribute('data-group');
        var g = curGroup();
        state.week = Math.min(state.week, weekCount(g) - 1);
        state.sel = state.anchor = state.active = null;
        save(); renderAll();
        return;
      }
      if (e.target.closest('[data-add-group]')) addGroup();
    });

    $('#weekPrev').onclick = function () { goWeek(state.week - 1); };
    $('#weekNext').onclick = function () { goWeek(state.week + 1); };
    $('#weekToday').onclick = goToday;
    $('#weekJump').onclick = goToday;
    $('#btnRoll').onclick = openRoll;
    $('#btnStats').onclick = function () {
      state.view = state.view === 'stats' ? 'grid' : 'stats';
      renderChrome();
      if (state.view === 'stats') renderStats(); else renderGrid();
    };
    $('#btnImport').onclick = function () { openImport('roster'); };
    $('#btnExport').onclick = openExport;
    $('#btnSettings').onclick = openSettings;
    $('#btnTheme').onclick = toggleTheme;
    $('#btnHelp').onclick = openHelp;
    $('#btnUndo').onclick = undo;
    $('#btnRedo').onclick = redo;
    $('#btnClearDemo').onclick = function () {
      confirmBox('清空示例数据，开始建班？', '会删除示例班级，并新建一个空白的「1班」（含 4 个小组、24 周日期）。', function () {
        state.undo.length = 0; state.redo.length = 0;
        state.db = blankDB();
        state.classId = state.db.classes[0].id;
        state.groupId = state.db.classes[0].groups[0].id;
        state.week = 0;
        saveNow(); renderAll();
        toast('已清空，先在下方输入学生姓名', 'ok', 3000);
      }, '清空');
    };

    // 标记面板
    var items = STATUSES.map(function (s) {
      return '<button class="st-chip" data-key="' + s.key + '" style="--c:' + s.color + ';--soft:' + s.soft + '">' +
        '<span class="dot"></span>' + s.label + '<span class="k">' + s.hint + '</span></button>';
    }).join('') +
      '<button class="st-chip" data-key="" style="--c:var(--muted);--soft:var(--bg-2)"><span class="dot" style="background:var(--line-2)"></span>出勤<span class="k">0</span></button>';
    $('#paletteItems').innerHTML = items;
    $$('#paletteItems [data-key]').forEach(function (b) {
      b.onclick = function () { applyStatus(b.getAttribute('data-key')); };
    });

    window.addEventListener('beforeunload', function (e) {
      if (state.saveTimer) { saveNow(); }
    });
  }

  async function boot() {
    applyTheme((function () {
      try { return localStorage.getItem('suqin_theme') || 'light'; } catch (e) { return 'light'; }
    })());

    $$('[data-ico]').forEach(function (el) { el.innerHTML = ICON[el.getAttribute('data-ico')] || ''; });
    $('#searchIco').innerHTML = ICON.search;

    // 先看云端（Supabase）→ 再看本机服务器 → 最后退回 localStorage
    var remote = { ok: false, db: null };
    try { remote = await fetchRemoteDB(); } catch (e) { remote = { ok: false, db: null }; }
    if (remote.cloud) {
      state.mode = 'cloud';
      if (!remote.db) {
        // 云端是空的：如果本机有旧数据就把它推上去，否则用示例
        var local0 = loadDB();
        if (local0 && local0.classes.length) {
          state.db = local0;
          setTimeout(function () { toast('已把本机数据同步到云端', 'ok', 3000); }, 600);
        } else {
          state.db = C.seedDemo();
          state.db.meta.demo = true;
        }
      } else {
        state.db = remote.db;
      }
    } else {
      state.mode = remote.ok ? 'server' : 'local';
      if (remote.cloudError) {
        setTimeout(function () { toast('云端连接失败：' + remote.cloudError, 'err', 6000); }, 600);
      }
      if (remote.db) state.db = remote.db;
      else {
        state.db = loadDB();
        if (!state.db) {
          state.db = C.seedDemo();
          state.db.meta.demo = true;
        }
      }
    }
    if (!state.db.classes.length) state.db = blankDB();

    var c0 = state.db.classes[0];
    state.classId = c0.id;
    state.groupId = c0.groups[0] ? c0.groups[0].id : null;
    state.week = 0;

    // 回写有效的班级 / 小组，避免备份里 id 失效时标签高亮错位
    var g0 = curGroup();
    if (g0) { state.classId = curClass().id; state.groupId = g0.id; }

    // 定位到本周
    if (g0) {
      var idx = g0.dates.map(function (d) { return d.id; }).indexOf(C.todayISO());
      if (idx >= 0) state.week = Math.floor(idx / weekSize());
      else {
        var upcoming = g0.dates.filter(function (d) { return d.id >= C.todayISO(); })[0];
        if (upcoming) state.week = Math.floor(g0.dates.indexOf(upcoming) / weekSize());
      }
    }

    bindChrome();
    bindSearch();
    bindKeys();
    renderAll();
    updateStorageNote();
    setSaveState('saved');
    // 服务器/云端可用但还没有数据：把本地/示例数据写上去
    if ((state.mode === 'server' || state.mode === 'cloud') && !remote.db) saveNow();
    // 云端模式：定时拉远端，别人改了能自动刷进来
    if (state.mode === 'cloud') setInterval(cloudSyncPull, 15000);
    if (state.db.meta && state.db.meta.demo) {
      setTimeout(function () { toast('这是示例数据，可直接点格子试用', 'ok', 3000); }, 600);
    }
  }

  /** 云端轮询：远端比本地新就拉下来（简单 Last-Write-Win，适合老师主用的场景） */
  var cloudPulling = false;
  function cloudSyncPull() {
    if (cloudPulling || state.mode !== 'cloud' || !state.db) return;
    if (state.saveTimer) return; // 有待保存的本地改动，等保存完再说
    cloudPulling = true;
    cloudFetch('GET').then(function (res) {
      cloudPulling = false;
      if (!res.ok || !res.db) return;
      var remoteAt = res.db.meta && res.db.meta.updatedAt;
      var localAt = state.db.meta && state.db.meta.updatedAt;
      if (remoteAt && localAt && remoteAt > localAt + 500) {
        state.db = res.db;
        ensureSelectionValid();
        renderAll();
        toast('已同步其他设备的更新', 'ok', 1800);
      }
    }).catch(function () { cloudPulling = false; });
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
