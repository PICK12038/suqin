/*!
 * 速勤 SuQin · 班级考勤工作台 — 核心逻辑
 * 纯函数数据层：零依赖，可在浏览器与 Node 中运行。
 * 设计要点：record 键使用「日期ISO|时段ID」，不依赖行号/列号，换名单、删列都不会错位。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.SQCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var PY = (typeof PY_MAP !== 'undefined' && PY_MAP) ? PY_MAP : {};
  if (!Object.keys(PY).length && typeof require === 'function') {
    try { PY = require('./pinyin.js'); } catch (e) { /* 浏览器环境无 require */ }
  }

  /* ------------------------------------------------------------------ *
   * 常量
   * ------------------------------------------------------------------ */
  var APP = {
    name: '速勤',
    full: '速勤 · 班级考勤工作台',
    version: '1.0.0',
    dbKey: 'suqin_db_v1',
    metaKey: 'suqin_meta_v1'
  };

  // 顺序即「严重程度」：越靠后越严重，汇总取最严重者着色
  var STATUSES = [
    { key: 'late',   label: '迟到', short: '迟', color: '#E5484D', soft: '#FDEBEC', sev: 1, hint: '1' },
    { key: 'early',  label: '早退', short: '早', color: '#D97706', soft: '#FEF3C7', sev: 2, hint: '2' },
    { key: 'sick',   label: '病假', short: '病', color: '#059669', soft: '#DCFCE7', sev: 3, hint: '3' },
    { key: 'leave',  label: '事假', short: '事', color: '#2563EB', soft: '#DBEAFE', sev: 4, hint: '4' },
    { key: 'skip',   label: '旷课', short: '旷', color: '#C2410C', soft: '#FFEDD5', sev: 5, hint: '5' },
    { key: 'absent', label: '缺勤', short: '缺', color: '#9F1239', soft: '#FFE4E6', sev: 6, hint: '6' }
  ];

  var STATUS_BY_KEY = {}, STATUS_BY_SHORT = {}, STATUS_BY_LABEL = {}, STATUS_BY_SEV = [];
  STATUSES.forEach(function (s) {
    STATUS_BY_KEY[s.key] = s;
    STATUS_BY_SHORT[s.short] = s;
    STATUS_BY_LABEL[s.label] = s;
    STATUS_BY_SEV[s.sev] = s;
  });

  var WEEKDAYS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];

  /* ------------------------------------------------------------------ *
   * 基础工具
   * ------------------------------------------------------------------ */
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function toISO(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
  function parseISO(iso) {
    var p = String(iso).split('-');
    return new Date(+p[0], +p[1] - 1, +p[2], 12, 0, 0, 0);
  }
  function todayISO() { return toISO(new Date()); }
  function addDays(iso, n) { var d = parseISO(iso); d.setDate(d.getDate() + n); return toISO(d); }
  function weekdayIdx(iso) { return (parseISO(iso).getDay() + 6) % 7; } // 0 = 周一
  function weekdayName(iso) { return WEEKDAYS[weekdayIdx(iso)]; }
  function fmtLabel(iso) { var d = parseISO(iso); return (d.getMonth() + 1) + '月' + d.getDate() + '日'; }
  function mondayOf(iso) { return addDays(iso, -weekdayIdx(iso)); }
  function nowSec() { return Math.floor(Date.now() / 1000); }

  function uid(prefix) {
    return prefix + '_' + Date.now().toString(36).slice(-4) + Math.random().toString(36).slice(2, 7);
  }
  function clone(obj) { return JSON.parse(JSON.stringify(obj)); }
  function chunk(arr, size) {
    var out = [];
    for (var i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* ------------------------------------------------------------------ *
   * 日期生成
   * ------------------------------------------------------------------ */
  // 生成 weeks 周、每周 weekSize 天（默认周一~周六，跳过周日）的日期列
  function makeDates(startISO, weeks, weekSize) {
    var size = weekSize || 6;
    var want = Math.max(1, weeks | 0) * size;
    var out = [], cur = startISO, guard = 0;
    while (out.length < want && guard++ < 5000) {
      if (weekdayIdx(cur) < 6) out.push({ id: cur, iso: cur, label: fmtLabel(cur), tag: '' });
      cur = addDays(cur, 1);
    }
    return out;
  }

  // 补齐日期列：只保留字段，保证旧数据可用
  function normalizeDates(dates) {
    return (dates || []).filter(function (d) { return d && d.id; }).map(function (d) {
      return { id: d.id, iso: d.iso || d.id, label: d.label || fmtLabel(d.id), tag: d.tag || '' };
    });
  }

  /* ------------------------------------------------------------------ *
   * 数据模型
   * ------------------------------------------------------------------ */
  function emptyDB() {
    return {
      v: 1,
      meta: { createdAt: Date.now(), updatedAt: Date.now() },
      settings: {
        periods: [
          { id: 'p1', name: '上午' },
          { id: 'p2', name: '下午' },
          { id: 'p3', name: '晚上' }
        ],
        weekSize: 6
      },
      classes: [],
      trash: []
    };
  }

  function newStudent(name) {
    return { id: uid('s'), name: String(name == null ? '' : name).trim() };
  }
  function newClass(name) {
    return { id: uid('c'), name: String(name || '新班级').trim(), groups: [] };
  }
  function newGroup(name, names) {
    return {
      id: uid('g'),
      name: String(name || '1组').trim(),
      students: (names || []).map(newStudent).filter(function (s) { return s.name; }),
      dates: [],
      records: {},
      maxRows: 15,
      customCols: []
    };
  }

  // 兼容/修复：确保结构完整
  function normalizeDB(db) {
    if (!db || typeof db !== 'object') return emptyDB();
    if (!db.meta) db.meta = { createdAt: Date.now(), updatedAt: Date.now() };
    if (!db.settings) db.settings = emptyDB().settings;
    if (!Array.isArray(db.settings.periods) || !db.settings.periods.length) {
      db.settings.periods = emptyDB().settings.periods;
    }
    if (!db.settings.weekSize) db.settings.weekSize = 6;
    if (!Array.isArray(db.classes)) db.classes = [];
    if (!Array.isArray(db.trash)) db.trash = [];
    db.v = 1;
    db.classes.forEach(function (c) {
      if (!c.id) c.id = uid('c');
      if (!Array.isArray(c.groups)) c.groups = [];
      c.groups.forEach(function (g) {
        if (!g.id) g.id = uid('g');
        if (!Array.isArray(g.students)) g.students = [];
        g.students.forEach(function (s) { if (!s.id) s.id = uid('s'); if (!s.name) s.name = '未命名'; });
        g.dates = normalizeDates(g.dates);
        if (!g.records || typeof g.records !== 'object') g.records = {};
        if (!Array.isArray(g.customCols)) g.customCols = [];
        if (!g.maxRows) g.maxRows = 15;
      });
    });
    return db;
  }

  function findClass(db, classId) {
    return (db.classes || []).filter(function (c) { return c.id === classId; })[0] || null;
  }
  function findGroup(db, classId, groupId) {
    var c = findClass(db, classId);
    if (!c) return null;
    return (c.groups || []).filter(function (g) { return g.id === groupId; })[0] || null;
  }
  function periodById(db, pid) {
    return (db.settings.periods || []).filter(function (p) { return p.id === pid; })[0] || null;
  }

  /* ------------------------------------------------------------------ *
   * 记录读写
   * ------------------------------------------------------------------ */
  function recKey(dateId, periodId) { return dateId + '|' + periodId; }

  function getStatus(group, studentId, dateId, periodId) {
    var m = group.records && group.records[studentId];
    return (m && m[recKey(dateId, periodId)]) || '';
  }

  function setStatus(group, studentId, dateId, periodId, key) {
    if (!group.records) group.records = {};
    var m = group.records[studentId];
    var k = recKey(dateId, periodId);
    if (!key) {
      if (m) { delete m[k]; if (!Object.keys(m).length) delete group.records[studentId]; }
      return;
    }
    if (!m) m = group.records[studentId] = {};
    m[k] = key;
  }

  function clearStudent(group, studentId) {
    if (group.records) delete group.records[studentId];
  }

  // 把某个学生的某一格从一个时段复制到同一天其它时段
  function copyToPeriods(group, studentId, dateId, periodIds, key) {
    periodIds.forEach(function (pid) { setStatus(group, studentId, dateId, pid, key); });
  }

  /* ------------------------------------------------------------------ *
   * 汇总与统计
   * ------------------------------------------------------------------ */
  function emptyCounts() {
    var c = {};
    STATUSES.forEach(function (s) { c[s.key] = 0; });
    return c;
  }

  /**
   * 单个学生在给定日期/时段内的汇总
   */
  function summarize(group, studentId, dateIds, periods) {
    var counts = emptyCounts(), total = 0, abnormal = 0;
    for (var i = 0; i < dateIds.length; i++) {
      for (var j = 0; j < periods.length; j++) {
        total++;
        var st = getStatus(group, studentId, dateIds[i], periods[j].id);
        if (st && counts.hasOwnProperty(st)) { counts[st]++; abnormal++; }
      }
    }
    return {
      total: total,
      abnormal: abnormal,
      counts: counts,
      rate: total ? (total - abnormal) / total : 1,
      worst: worstStatus(counts),
      perfect: abnormal === 0
    };
  }

  function worstStatus(counts) {
    var worst = null;
    STATUSES.forEach(function (s) {
      if (counts[s.key] > 0 && (!worst || s.sev > worst.sev)) worst = s;
    });
    return worst;
  }

  function summaryText(counts) {
    var parts = [];
    STATUSES.forEach(function (s) { if (counts[s.key] > 0) parts.push(s.label + '×' + counts[s.key]); });
    return parts.join(' ');
  }

  /**
   * 整组统计。dateIds/periods 决定范围。
   */
  function computeStats(group, dateIds, periods) {
    var byStatus = emptyCounts(), slots = 0, filled = 0, abnormal = 0;
    var perStudent = [], perDate = [];
    var dateSet = {}, dIdx = {};

    dateIds.forEach(function (d, i) { dateSet[d] = i; dIdx[d] = 0; });
    dateIds.forEach(function (d) {
      perDate.push({ id: d, label: fmtLabel(d), total: 0, abnormal: 0, filled: 0 });
    });

    group.students.forEach(function (st, si) {
      var counts = emptyCounts(), ab = 0, t = 0;
      for (var i = 0; i < dateIds.length; i++) {
        var d = dateIds[i];
        var dayAb = 0;
        for (var j = 0; j < periods.length; j++) {
          slots++; t++;
          perDate[i].total++;
          var s = getStatus(group, st.id, d, periods[j].id);
          if (s && counts.hasOwnProperty(s)) {
            counts[s]++; byStatus[s]++;
            ab++; abnormal++; filled++;
            perDate[i].abnormal++; perDate[i].filled++;
            dayAb++;
          }
        }
        if (dayAb) dIdx[d] += dayAb;
      }
      perStudent.push({
        id: st.id, name: st.name, index: si, total: t, abnormal: ab,
        counts: counts, rate: t ? (t - ab) / t : 1, worst: worstStatus(counts)
      });
    });

    // 每人异常排行（用于「重点学生」）
    var ranking = perStudent.slice().sort(function (a, b) {
      return b.abnormal - a.abnormal || a.name.localeCompare(b.name, 'zh');
    });

    return {
      students: group.students.length,
      dates: dateIds.length,
      periods: periods.length,
      slots: slots,
      filled: filled,
      abnormal: abnormal,
      rate: slots ? (slots - abnormal) / slots : 1,
      byStatus: byStatus,
      perStudent: perStudent,
      perDate: perDate,
      ranking: ranking
    };
  }

  // 某一天某组整体情况（点名面板用）
  function dayStats(group, dateId, periods) {
    var out = { filled: 0, total: group.students.length * periods.length, byStatus: emptyCounts(), students: {} };
    group.students.forEach(function (st) {
      var c = emptyCounts(), n = 0;
      periods.forEach(function (p) {
        var s = getStatus(group, st.id, dateId, p.id);
        if (s) { c[s]++; n++; out.byStatus[s]++; out.filled++; }
      });
      out.students[st.id] = { counts: c, abnormal: n };
    });
    return out;
  }

  /* ------------------------------------------------------------------ *
   * 搜索（姓名 + 拼音首字母）
   * ------------------------------------------------------------------ */
  function initialsOf(name) {
    var out = '';
    name = String(name || '');
    for (var i = 0; i < name.length; i++) {
      var ch = name[i];
      if (/[a-zA-Z0-9]/.test(ch)) out += ch.toLowerCase();
      else out += PY[ch] || '';
    }
    return out;
  }

  function norm(s) { return String(s == null ? '' : s).toLowerCase().replace(/\s+/g, ''); }

  function matchScore(query, name) {
    var q = norm(query);
    if (!q) return 1;
    var n = norm(name);
    if (n === q) return 100;
    if (n.indexOf(q) === 0) return 90;
    if (n.indexOf(q) > 0) return 70;
    var ini = initialsOf(name);
    if (ini === q) return 85;
    if (ini.indexOf(q) === 0) return 75;
    if (ini.indexOf(q) > 0) return 50;
    // 首字母模糊：q 的字符按序出现在 ini 中
    var k = 0;
    for (var i = 0; i < ini.length && k < q.length; i++) if (ini[i] === q[k]) k++;
    if (k === q.length) return 30;
    return 0;
  }

  // 在整库中搜索学生，返回 [{classId, groupId, studentId, name, groupName, className, score}]
  function searchStudents(db, query) {
    var out = [];
    if (!norm(query)) return out;
    db.classes.forEach(function (c) {
      c.groups.forEach(function (g) {
        g.students.forEach(function (s) {
          var sc = matchScore(query, s.name);
          if (sc > 0) out.push({
            classId: c.id, groupId: g.id, studentId: s.id, name: s.name,
            groupName: g.name, className: c.name, score: sc
          });
        });
      });
    });
    out.sort(function (a, b) { return b.score - a.score || a.name.localeCompare(b.name, 'zh'); });
    return out;
  }

  /* ------------------------------------------------------------------ *
   * CSV / TSV
   * ------------------------------------------------------------------ */
  function csvCell(v) {
    var s = v == null ? '' : String(v);
    if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  function toCSV(rows) {
    return '\uFEFF' + rows.map(function (r) { return r.map(csvCell).join(','); }).join('\r\n') + '\r\n';
  }

  function toTSV(rows) {
    return rows.map(function (r) {
      return r.map(function (c) { return String(c == null ? '' : c).replace(/[\t\r\n]/g, ' '); }).join('\t');
    }).join('\n');
  }

  // 生成导出行（单行表头，适合 CSV）
  function groupCSVRows(group, periods, opts) {
    opts = opts || {};
    var rows = [], head = ['序号', '姓名'];
    group.dates.forEach(function (d) {
      periods.forEach(function (p) { head.push(d.label + ' ' + p.name); });
    });
    head.push('汇总');
    rows.push(head);
    var dateIds = group.dates.map(function (d) { return d.id; });
    group.students.forEach(function (st, i) {
      var row = [i + 1, st.name];
      var sum = summarize(group, st.id, dateIds, periods);
      group.dates.forEach(function (d) {
        periods.forEach(function (p) {
          var s = getStatus(group, st.id, d.id, p.id);
          row.push(s ? (STATUS_BY_KEY[s] || {}).label || s : '');
        });
      });
      row.push(sum.abnormal === 0 ? '全勤' : summaryText(sum.counts));
      rows.push(row);
    });
    return rows;
  }

  /* ------------------------------------------------------------------ *
   * XLSX（真·Excel，ZIP store 自实现，无第三方库）
   * ------------------------------------------------------------------ */
  var CRC_TABLE = (function () {
    var t = new Int32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c;
    }
    return t;
  })();

  function crc32(u8) {
    var c = -1;
    for (var i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  }

  function utf8(str) { return new TextEncoder().encode(str); }

  function zipStore(files) {
    var chunks = [], central = [], offset = 0;
    files.forEach(function (f) {
      var nameBytes = utf8(f.name);
      var data = f.data;
      var crc = crc32(data);
      var lh = new Uint8Array(30 + nameBytes.length);
      var dv = new DataView(lh.buffer);
      dv.setUint32(0, 0x04034b50, true);
      dv.setUint16(4, 20, true);
      dv.setUint16(6, 0x0800, true);   // UTF-8 文件名
      dv.setUint16(8, 0, true);        // store
      dv.setUint16(10, 0, true);
      dv.setUint16(12, 0x21, true);
      dv.setUint32(14, crc, true);
      dv.setUint32(18, data.length, true);
      dv.setUint32(22, data.length, true);
      dv.setUint16(26, nameBytes.length, true);
      dv.setUint16(28, 0, true);
      lh.set(nameBytes, 30);

      var ch = new Uint8Array(46 + nameBytes.length);
      var cv = new DataView(ch.buffer);
      cv.setUint32(0, 0x02014b50, true);
      cv.setUint16(4, 20, true);
      cv.setUint16(6, 20, true);
      cv.setUint16(8, 0x0800, true);
      cv.setUint16(10, 0, true);
      cv.setUint16(12, 0, true);
      cv.setUint16(14, 0x21, true);
      cv.setUint32(16, crc, true);
      cv.setUint32(20, data.length, true);
      cv.setUint32(24, data.length, true);
      cv.setUint16(28, nameBytes.length, true);
      cv.setUint16(30, 0, true);
      cv.setUint16(32, 0, true);
      cv.setUint16(34, 0, true);
      cv.setUint16(36, 0, true);
      cv.setUint32(38, 0, true);
      cv.setUint32(42, offset, true);
      ch.set(nameBytes, 46);

      chunks.push(lh, data);
      central.push(ch);
      offset += lh.length + data.length;
    });
    var cdSize = central.reduce(function (a, b) { return a + b.length; }, 0);
    var end = new Uint8Array(22);
    var ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, files.length, true);
    ev.setUint16(10, files.length, true);
    ev.setUint32(12, cdSize, true);
    ev.setUint32(16, offset, true);

    var total = offset + cdSize + 22;
    var out = new Uint8Array(total), pos = 0;
    chunks.concat(central, [end]).forEach(function (b) { out.set(b, pos); pos += b.length; });
    return out;
  }

  function colName(i) {
    var s = '';
    i = i + 1;
    while (i > 0) {
      var m = (i - 1) % 26;
      s = String.fromCharCode(65 + m) + s;
      i = Math.floor((i - m) / 26);
    }
    return s;
  }

  // styles.xml：0 默认 / 1 表头 / 2 居中 / 3 姓名 / 4-9 六种状态 / 10 汇总 / 11 标题
  function stylesXML() {
    var fills = ['<fill><patternFill patternType="none"/></fill>',
      '<fill><patternFill patternType="gray125"/></fill>',
      '<fill><patternFill patternType="solid"><fgColor rgb="FF1F2937"/><bgColor indexed="64"/></patternFill></fill>'];
    var softs = ['FFEFF1F3'];
    STATUSES.forEach(function (s) { fills.push('<fill><patternFill patternType="solid"><fgColor rgb="FF' + s.soft.slice(1) + '"/><bgColor indexed="64"/></patternFill></fill>'); });
    fills.push('<fill><patternFill patternType="solid"><fgColor rgb="FFF3F4F6"/><bgColor indexed="64"/></patternFill></fill>');
    var fonts = [
      '<font><sz val="11"/><color rgb="FF1F2937"/><name val="等线"/></font>',
      '<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="等线"/></font>',
      '<font><b/><sz val="11"/><color rgb="FF111827"/><name val="等线"/></font>',
      '<font><b/><sz val="10"/><color rgb="FF6B7280"/><name val="等线"/></font>',
      '<font><b/><sz val="14"/><color rgb="FF111827"/><name val="等线"/></font>'
    ];
    STATUSES.forEach(function (s) { fonts.push('<font><b/><sz val="11"/><color rgb="FF' + s.color.slice(1) + '"/><name val="等线"/></font>'); });

    var border = '<border><left style="thin"><color rgb="FFE5E7EB"/></left><right style="thin"><color rgb="FFE5E7EB"/></right><top style="thin"><color rgb="FFE5E7EB"/></top><bottom style="thin"><color rgb="FFE5E7EB"/></bottom></border>';
    var xfs = [
      '<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment vertical="center"/></xf>',
      '<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>',
      '<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>',
      '<xf numFmtId="0" fontId="2" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="left" vertical="center"/></xf>',
      '<xf numFmtId="0" fontId="3" fillId="10" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>',
      '<xf numFmtId="0" fontId="4" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment vertical="center"/></xf>'
    ];
    STATUSES.forEach(function (s, i) {
      xfs.push('<xf numFmtId="0" fontId="' + (5 + i) + '" fillId="' + (3 + i) + '" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>');
    });

    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<fonts count="' + fonts.length + '">' + fonts.join('') + '</fonts>' +
      '<fills count="' + fills.length + '">' + fills.join('') + '</fills>' +
      '<borders count="2"><border/>' + border + '</borders>' +
      '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
      '<cellXfs count="' + xfs.length + '">' + xfs.join('') + '</cellXfs>' +
      '<cellStyles count="1"><cellStyle name="常规" xfId="0" builtinId="0"/></cellStyles>' +
      '</styleSheet>';
  }

  function sheetXML(sheet, sheetId) {
    var rows = sheet.rows || [];
    var cols = sheet.cols || [];
    var merges = sheet.merges || [];
    var out = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'];

    if (sheet.freeze) {
      out.push('<sheetViews><sheetView workbookViewId="0"><pane xSplit="' + (sheet.freeze.x || 0) +
        '" ySplit="' + (sheet.freeze.y || 0) + '" topLeftCell="' +
        colName(sheet.freeze.x || 0) + (sheet.freeze.y + 1) +
        '" activePane="bottomRight" state="frozen"/></sheetView></sheetViews>');
    }
    if (cols.length) {
      out.push('<cols>');
      cols.forEach(function (w, i) {
        out.push('<col min="' + (i + 1) + '" max="' + (i + 1) + '" width="' + w + '" customWidth="1"/>');
      });
      out.push('</cols>');
    }
    out.push('<sheetData>');
    rows.forEach(function (row, r) {
      if (!row || !row.length) return;
      out.push('<row r="' + (r + 1) + '">');
      row.forEach(function (cell, c) {
        if (cell == null || cell === '') return;
        var v = cell, style = 0, type = 's';
        if (typeof cell === 'object') { v = cell.v; style = cell.s || 0; type = cell.t || 's'; }
        if (v == null || v === '') {
          if (!style) return;
          out.push('<c r="' + colName(c) + (r + 1) + '" s="' + style + '"/>');
          return;
        }
        if (typeof v === 'number' || type === 'n') {
          out.push('<c r="' + colName(c) + (r + 1) + '" s="' + style + '"><v>' + v + '</v></c>');
        } else {
          out.push('<c r="' + colName(c) + (r + 1) + '" s="' + style + '" t="inlineStr"><is><t xml:space="preserve">' +
            esc(v) + '</t></is></c>');
        }
      });
      out.push('</row>');
    });
    out.push('</sheetData>');
    if (merges.length) {
      out.push('<mergeCells count="' + merges.length + '">');
      merges.forEach(function (m) { out.push('<mergeCell ref="' + m + '"/>'); });
      out.push('</mergeCells>');
    }
    out.push('</worksheet>');
    return out.join('');
  }

  function sanitizeSheetName(name, used) {
    var n = String(name || 'Sheet').replace(/[\\\/\?\*\[\]:]/g, ' ').slice(0, 31).trim() || 'Sheet';
    var base = n, i = 2;
    while (used[n]) { n = (base.slice(0, 28) + '(' + i + ')'); i++; }
    used[n] = 1;
    return n;
  }

  /**
   * sheets: [{name, rows, cols, merges, freeze}]
   * 返回 Uint8Array（.xlsx 文件内容）
   */
  function buildXLSX(sheets) {
    var used = {};
    var names = sheets.map(function (s) { return sanitizeSheetName(s.name, used); });
    var files = [];

    files.push({
      name: '[Content_Types].xml',
      data: utf8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
        sheets.map(function (s, i) {
          return '<Override PartName="/xl/worksheets/sheet' + (i + 1) + '.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>';
        }).join('') +
        '</Types>')
    });

    files.push({
      name: '_rels/.rels',
      data: utf8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
        '</Relationships>')
    });

    files.push({
      name: 'xl/workbook.xml',
      data: utf8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
        '<sheets>' + names.map(function (n, i) {
          return '<sheet name="' + esc(n) + '" sheetId="' + (i + 1) + '" r:id="rId' + (i + 1) + '"/>';
        }).join('') + '</sheets></workbook>')
    });

    files.push({
      name: 'xl/_rels/workbook.xml.rels',
      data: utf8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        sheets.map(function (s, i) {
          return '<Relationship Id="rId' + (i + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet' + (i + 1) + '.xml"/>';
        }).join('') +
        '<Relationship Id="rId' + (sheets.length + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
        '</Relationships>')
    });

    files.push({ name: 'xl/styles.xml', data: utf8(stylesXML()) });

    sheets.forEach(function (s, i) {
      files.push({ name: 'xl/worksheets/sheet' + (i + 1) + '.xml', data: utf8(sheetXML(s, i + 1)) });
    });

    return zipStore(files);
  }

  /**
   * 把一组导出为 sheet 定义（两行表头 + 冻结窗格 + 合并日期）
   */
  function groupSheet(group, periods, title) {
    var rows = [], merges = [], cols = [5, 12];
    var head1 = [{ v: '序号', s: 1 }, { v: '姓名', s: 1 }];
    var head2 = [{ v: '', s: 1 }, { v: '', s: 1 }];
    var colIndex = 2;

    group.dates.forEach(function (d) {
      var span = periods.length;
      head1.push({ v: d.label + (d.tag ? ' ' + d.tag : ''), s: 1 });
      for (var k = 1; k < span; k++) head1.push({ v: '', s: 1 });
      if (span > 1) merges.push(colName(colIndex) + '1:' + colName(colIndex + span - 1) + '1');
      periods.forEach(function (p) {
        head2.push({ v: p.name, s: 1 });
        cols.push(4.2);
      });
      colIndex += span;
    });
    head1.push({ v: '汇总', s: 1 });
    head2.push({ v: '', s: 1 });
    cols.push(20);

    var topOffset = 0;
    if (title) {
      rows.push([{ v: title, s: 5 }]);
      rows.push([]);
      topOffset = 2;
      merges = merges.map(function (m) {
        return m.replace(/([A-Z]+)(\d+):([A-Z]+)(\d+)/, function (_, c1, r1, c2, r2) {
          return c1 + (+r1 + topOffset) + ':' + c2 + (+r2 + topOffset);
        });
      });
      merges.push('A1:' + colName(head1.length - 1) + '1');
    }
    rows.push(head1);
    rows.push(head2);

    var dateIds = group.dates.map(function (d) { return d.id; });
    group.students.forEach(function (st, i) {
      var row = [{ v: i + 1, s: 2, t: 'n' }, { v: st.name, s: 3 }];
      var sum = summarize(group, st.id, dateIds, periods);
      group.dates.forEach(function (d) {
        periods.forEach(function (p) {
          var s = getStatus(group, st.id, d.id, p.id);
          var stDef = STATUS_BY_KEY[s];
          row.push(stDef ? { v: stDef.label, s: 6 + STATUSES.indexOf(stDef) } : { v: '', s: 2 });
        });
      });
      row.push({ v: sum.abnormal === 0 ? '★ 全勤' : summaryText(sum.counts), s: 4 });
      rows.push(row);
    });

    return {
      name: group.name,
      rows: rows,
      cols: cols,
      merges: merges,
      freeze: { x: 2, y: 2 + topOffset }
    };
  }

  function exportXLSX(db, options) {
    options = options || {};
    var periods = db.settings.periods;
    var sheets = [];
    db.classes.forEach(function (c) {
      c.groups.forEach(function (g) {
        if (!g.students.length && !g.dates.length) return;
        var sheet = groupSheet(g, periods, c.name + ' · ' + g.name);
        sheet.name = c.name + '-' + g.name;
        sheets.push(sheet);
      });
    });
    if (!sheets.length) sheets.push({ name: '空表', rows: [['暂无数据']], cols: [20] });
    return {
      filename: '速勤-考勤表-' + todayISO() + '.xlsx',
      bytes: buildXLSX(sheets)
    };
  }

  /* ------------------------------------------------------------------ *
   * 导入解析
   * ------------------------------------------------------------------ */
  function parseNames(text) {
    var bad = /^(姓名|名字|学生|学生姓名|名单|序号|班级|组别|小组)$/;
    // 先去掉每行行首的序号（"1. " / "2、" / "3）"），否则被分隔符切开后序号会残留成姓名
    var s = String(text || '')
      .replace(/\r\n?/g, '\n')
      .replace(/(^|\n)[ \t]*\d{1,3}[ \t]*[.、)）．][ \t]*/g, '$1');
    return s
      .split(/[\n\r,，、;；\t]+/)
      .map(function (x) { return x.replace(/^\s*\d+\s*[.、)）]\s*/, '').trim(); })
      .filter(function (x) { return x && !bad.test(x); });
  }

  function sniffDelim(text) {
    var head = String(text || '').split(/\r?\n/).slice(0, 3).join('\n');
    if (head.indexOf('\t') >= 0) return '\t';
    if (head.indexOf(',') >= 0) return ',';
    return '\t';
  }

  function parseDelimited(text, delim) {
    var rows = [], row = [], cur = '', q = false;
    text = String(text || '').replace(/^\uFEFF/, '');
    for (var i = 0; i < text.length; i++) {
      var c = text[i];
      if (q) {
        if (c === '"') {
          if (text[i + 1] === '"') { cur += '"'; i++; } else q = false;
        } else cur += c;
      } else if (c === '"') {
        q = true;
      } else if (c === delim) {
        row.push(cur); cur = '';
      } else if (c === '\n') {
        row.push(cur); rows.push(row); row = []; cur = '';
      } else if (c !== '\r') {
        cur += c;
      }
    }
    if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
    return rows.filter(function (r) { return r.some(function (c) { return String(c).trim() !== ''; }); });
  }

  function statusFromText(v) {
    var s = String(v == null ? '' : v).replace(/\s+/g, '');
    if (!s) return '';
    if (/^(全勤|出勤|正常|到|√|✓|✔|v|V)$/.test(s)) return '';
    var hit = STATUS_BY_LABEL[s] || STATUS_BY_SHORT[s] || STATUS_BY_KEY[s];
    if (hit) return hit.key;
    if (/迟到/.test(s)) return 'late';
    if (/早退/.test(s)) return 'early';
    if (/病假|病/.test(s)) return 'sick';
    if (/事假|请事/.test(s)) return 'leave';
    if (/旷课|旷/.test(s)) return 'skip';
    if (/缺勤|缺/.test(s)) return 'absent';
    return '';
  }

  // 解析表头里的日期与时段
  function resolveColumns(header, group, periods) {
    var nameCol = -1;
    for (var i = 0; i < header.length; i++) {
      if (/姓名|学生/.test(String(header[i]))) { nameCol = i; break; }
    }
    if (nameCol < 0) nameCol = 0;

    var byLabel = {}, byISO = {};
    group.dates.forEach(function (d) {
      byLabel[d.label.replace(/\s+/g, '')] = d.id;
      byISO[d.id] = d.id;
      var mm = d.label.match(/(\d{1,2})月(\d{1,2})日/);
      if (mm) byLabel[(+mm[1]) + '月' + (+mm[2]) + '日'] = d.id;
      byLabel[d.label.replace(/^0/, '')] = d.id;
    });

    var cols = [];
    for (var c = nameCol + 1; c < header.length; c++) {
      var raw = String(header[c] == null ? '' : header[c]).replace(/\s+/g, '');
      if (!raw) continue;
      if (/汇总|合计|总计|备注/.test(raw)) continue;
      var rest = raw;
      var pid = '';
      periods.forEach(function (p) {
        if (rest.indexOf(p.name) >= 0) { pid = p.id; rest = rest.replace(p.name, ''); }
      });
      if (!pid) {
        if (/上午|早上|早读/.test(rest)) pid = periods[0] && periods[0].id;
        else if (/下午|中午/.test(rest)) pid = (periods[1] || periods[0] || {}).id;
        else if (/晚上|晚修|晚自习/.test(rest)) pid = (periods[2] || periods[periods.length - 1] || {}).id;
      }
      var did = byISO[rest] || byLabel[rest];
      if (!did) {
        var mm = rest.match(/(\d{1,2})[月\/.-](\d{1,2})/);
        if (mm) did = byLabel[(+mm[1]) + '月' + (+mm[2]) + '日'] || byLabel[mm[1] + '月' + mm[2] + '日'];
      }
      if (!did) continue;
      cols.push({ col: c, dateId: did, periodId: pid });
    }
    // 同一日期连续出现且未标时段 → 按顺序分配时段
    var i = 0;
    while (i < cols.length) {
      var j = i, arr = [];
      while (j < cols.length && cols[j].dateId === cols[i].dateId) { arr.push(cols[j]); j++; }
      if (arr.length > 1) {
        var anyPid = arr.some(function (x) { return x.periodId; });
        if (!anyPid) arr.forEach(function (x, k) { x.periodId = periods[k % periods.length].id; });
        else if (arr.some(function (x) { return !x.periodId; })) {
          var used = {}, next = 0;
          arr.forEach(function (x) { if (x.periodId) used[x.periodId] = 1; });
          arr.forEach(function (x) {
            if (!x.periodId) { while (used[periods[next % periods.length].id]) next++; x.periodId = periods[next % periods.length].id; used[x.periodId] = 1; }
          });
        }
      } else if (!arr[0].periodId) {
        arr[0].periodId = periods[0].id;
      }
      i = j;
    }
    return { nameCol: nameCol, cols: cols };
  }

  /**
   * 解析考勤表文本，返回待写入的 cells
   */
  function parseAttendance(text, group, periods) {
    var delim = sniffDelim(text);
    var rows = parseDelimited(text, delim);
    if (!rows.length) return { cells: [], unmatched: [], unmatchedCols: [], rowCount: 0 };

    var headerIdx = 0;
    for (var i = 0; i < Math.min(rows.length, 5); i++) {
      if (rows[i].some(function (c) { return /姓名|学生/.test(String(c)); })) { headerIdx = i; break; }
    }
    var header = rows[headerIdx];
    var resolved = resolveColumns(header, group, periods);

    var nameMap = {};
    group.students.forEach(function (s) {
      nameMap[s.name.replace(/\s+/g, '')] = s.id;
      nameMap[s.name.replace(/\s+/g, '').toLowerCase()] = s.id;
    });

    var cells = [], unmatched = [], unmatchedCols = [];
    if (!resolved.cols.length) {
      return { cells: [], unmatched: [], unmatchedCols: header.map(function (h) { return String(h); }), rowCount: 0 };
    }
    for (var r = headerIdx + 1; r < rows.length; r++) {
      var row = rows[r];
      var nm = String(row[resolved.nameCol] == null ? '' : row[resolved.nameCol]).replace(/\s+/g, '');
      if (!nm) continue;
      var sid = nameMap[nm] || nameMap[nm.toLowerCase()];
      if (!sid) { unmatched.push(nm); continue; }
      resolved.cols.forEach(function (col) {
        var raw = row[col.col];
        if (raw == null || String(raw).trim() === '') return;
        var key = statusFromText(raw);
        cells.push({ studentId: sid, dateId: col.dateId, periodId: col.periodId, status: key });
      });
    }
    return { cells: cells, unmatched: unmatched, unmatchedCols: [], rowCount: rows.length - headerIdx - 1 };
  }

  function applyAttendance(group, cells) {
    cells.forEach(function (c) { setStatus(group, c.studentId, c.dateId, c.periodId, c.status); });
    return cells.length;
  }

  /* ------------------------------------------------------------------ *
   * 示例数据
   * ------------------------------------------------------------------ */
  function seedDemo() {
    var db = emptyDB();
    var start = mondayOf(addDays(todayISO(), -7 * 8));
    var dates = makeDates(start, 24, 6);
    var tags = {};
    if (dates[12]) tags[dates[12].id] = '月考';
    if (dates[27]) tags[dates[27].id] = '运动会';
    if (dates[45]) tags[dates[45].id] = '期中';

    var roster = [
      ['王梓涵', '李雨桐', '张浩然', '刘思远', '陈欣怡', '杨子轩', '赵可馨', '黄俊杰'],
      ['周雅琪', '吴天佑', '徐若曦', '孙嘉豪', '马诗涵', '朱奕辰', '胡一诺'],
      ['郭沐阳', '何雨欣', '高子墨', '林书瑶', '罗嘉怡', '郑宇航', '梁思彤', '谢明轩'],
      ['唐语嫣', '许博文', '邓紫涵', '冯浩宇', '曹梦琪', '彭子豪', '董雨萱']
    ];
    var today = todayISO();
    var cls = newClass('高一(1)班');
    var seedBase = 20260907;

    roster.forEach(function (names, gi) {
      var g = newGroup((gi + 1) + '组', names);
      g.dates = dates.map(function (d) { return { id: d.id, iso: d.iso, label: d.label, tag: tags[d.id] || '' }; });
      var seed = seedBase + gi * 977;
      function rnd() {
        seed = (seed * 1103515245 + 12345) & 0x7FFFFFFF;
        return seed / 0x7FFFFFFF;
      }
      g.students.forEach(function (st) {
        var map = {};
        g.dates.forEach(function (d) {
          if (d.id > today) return;
          [['p1'], ['p2'], ['p3']].forEach(function (pp) {
            var r = rnd();
            var key = '';
            if (r < 0.030) key = 'late';
            else if (r < 0.045) key = 'early';
            else if (r < 0.060) key = 'sick';
            else if (r < 0.075) key = 'leave';
            else if (r < 0.082) key = 'skip';
            else if (r < 0.088) key = 'absent';
            if (key) map[d.id + '|' + pp[0]] = key;
          });
        });
        if (Object.keys(map).length) g.records[st.id] = map;
      });
      cls.groups.push(g);
    });
    db.classes.push(cls);
    return db;
  }

  /* ------------------------------------------------------------------ *
   * 导出 API
   * ------------------------------------------------------------------ */
  return {
    APP: APP,
    STATUSES: STATUSES,
    STATUS_BY_KEY: STATUS_BY_KEY,
    STATUS_BY_SHORT: STATUS_BY_SHORT,
    STATUS_BY_LABEL: STATUS_BY_LABEL,
    WEEKDAYS: WEEKDAYS,
    // utils
    pad2: pad2, toISO: toISO, parseISO: parseISO, todayISO: todayISO,
    addDays: addDays, weekdayIdx: weekdayIdx, weekdayName: weekdayName,
    fmtLabel: fmtLabel, mondayOf: mondayOf, uid: uid, clone: clone, chunk: chunk, esc: esc,
    // dates & model
    makeDates: makeDates, normalizeDates: normalizeDates, emptyDB: emptyDB,
    newStudent: newStudent, newClass: newClass, newGroup: newGroup, normalizeDB: normalizeDB,
    findClass: findClass, findGroup: findGroup, periodById: periodById,
    // records
    recKey: recKey, getStatus: getStatus, setStatus: setStatus,
    clearStudent: clearStudent, copyToPeriods: copyToPeriods,
    // stats
    summarize: summarize, computeStats: computeStats, dayStats: dayStats,
    summaryText: summaryText, worstStatus: worstStatus, emptyCounts: emptyCounts,
    // search
    initialsOf: initialsOf, matchScore: matchScore, searchStudents: searchStudents,
    // export
    toCSV: toCSV, toTSV: toTSV, groupCSVRows: groupCSVRows,
    buildXLSX: buildXLSX, exportXLSX: exportXLSX, groupSheet: groupSheet,
    // import
    parseNames: parseNames, parseDelimited: parseDelimited, parseAttendance: parseAttendance,
    applyAttendance: applyAttendance, statusFromText: statusFromText, sniffDelim: sniffDelim,
    // demo
    seedDemo: seedDemo
  };
});
