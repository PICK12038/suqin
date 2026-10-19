/**
 * core.test.js — 纯逻辑自测（不需要浏览器）
 *
 *   node test/core.test.js
 */
'use strict';

const C = require('../src/core.js');

let pass = 0;
let fail = 0;

function eq(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    pass++;
    console.log('  ok   ' + name + (e.length < 60 ? '  [' + e + ']' : ''));
  } else {
    fail++;
    console.log('  FAIL ' + name + '\n       期望 ' + e + '\n       实际 ' + a);
  }
}

function ok(name, cond, extra) {
  if (cond) {
    pass++;
    console.log('  ok   ' + name + (extra !== undefined ? '  [' + extra + ']' : ''));
  } else {
    fail++;
    console.log('  FAIL ' + name + (extra !== undefined ? '  [' + extra + ']' : ''));
  }
}

const P3 = [
  { id: 'p1', name: '上午' },
  { id: 'p2', name: '下午' },
  { id: 'p3', name: '晚上' }
];

console.log('\n日期与周');
const dates = C.makeDates('2026-09-07', 24);
eq('24 周 × 6 天 = 144 天', dates.length, 144);
ok('跳过周日', dates.every((d) => C.parseISO(d.iso).getDay() !== 0));
eq('第一天是周一', C.parseISO(dates[0].iso).getDay(), 1);
eq('第一天标签', dates[0].label, '9月7日');
eq('第 7 天回到周一', C.parseISO(dates[6].iso).getDay(), 1);
eq('toISO 往返', C.toISO(C.parseISO('2026-12-06')), '2026-12-06');
eq('weekdayIdx 周一=0', C.weekdayIdx('2026-09-07'), 0);
eq('weekdayIdx 周六=5', C.weekdayIdx('2026-09-12'), 5);

console.log('\n数据模型与记录');
const db = C.emptyDB();
const g = C.newGroup('1组', ['王梓涵', '李雨桐', '张浩然']);
g.dates = C.makeDates('2026-09-07', 1);
const cls = Object.assign(C.newClass('高一(1)班'), { groups: [g] });
db.classes.push(cls);
eq('新组 3 人', g.students.length, 3);
eq('新组 6 天', g.dates.length, 6);
const sid = g.students[0].id;
C.setStatus(g, sid, g.dates[0].id, 'p1', 'late');
eq('写入迟到', C.getStatus(g, sid, g.dates[0].id, 'p1'), 'late');
eq('未写入为空', C.getStatus(g, sid, g.dates[0].id, 'p2'), '');
C.setStatus(g, sid, g.dates[0].id, 'p1', '');
eq('清空后无键', Object.keys(g.records).length, 0);
C.setStatus(g, sid, g.dates[0].id, 'p2', 'sick');
C.setStatus(g, sid, g.dates[1].id, 'p3', 'absent');
eq('两条记录', Object.keys(g.records[sid]).length, 2);

console.log('\n汇总');
const d2 = [g.dates[0].id, g.dates[1].id];
const sum = C.summarize(g, sid, d2, P3);
eq('总格数 6', sum.total, 6);
eq('异常 2', sum.abnormal, 2);
eq('出勤率 4/6', Math.round(sum.rate * 100), 67);
eq('最严重=缺勤', sum.worst && sum.worst.key, 'absent');
C.setStatus(g, sid, g.dates[0].id, 'p2', '');
C.setStatus(g, sid, g.dates[1].id, 'p3', '');
eq('全清后全勤', C.summarize(g, sid, d2, P3).perfect, true);

const stats = C.computeStats(g, d2, P3);
eq('统计学生数', stats.students, 3);
eq('统计格数', stats.slots, 18);
eq('排名长度', stats.ranking.length, 3);

console.log('\n姓名解析与搜索');
eq('解析换行/逗号/顿号', C.parseNames('王梓涵\n李雨桐，张浩然、赵一鸣; 孙悦'), [
  '王梓涵',
  '李雨桐',
  '张浩然',
  '赵一鸣',
  '孙悦'
]);
eq('剔除行首序号', C.parseNames('1. 王梓涵\n2、李雨桐\n3）张浩然'), ['王梓涵', '李雨桐', '张浩然']);
eq('剔除表头', C.parseNames('姓名\n王梓涵'), ['王梓涵']);
eq('拼音首字母', C.initialsOf('王梓涵'), 'wzh');
eq('首字母全等 85', C.matchScore('wzh', '王梓涵'), 85);
eq('姓名全等 100', C.matchScore('王梓涵', '王梓涵'), 100);
eq('姓名前缀 90', C.matchScore('王梓', '王梓涵'), 90);
eq('首字母前缀 75', C.matchScore('wz', '王梓涵'), 75);
eq('包含 70', C.matchScore('梓', '王梓涵'), 70);
ok('搜索命中', C.searchStudents(db, 'wzh').length === 1);
ok('搜索无命中', C.searchStudents(db, 'zzz').length === 0);

console.log('\nCSV 往返');
const rows = C.groupCSVRows(g, P3);
const csv = C.toCSV(rows);
ok('CSV 带 BOM', csv.charCodeAt(0) === 0xfeff);
ok('CSV 行数 = 表头 + 3 人', csv.split('\r\n').filter(Boolean).length === 4);
const parsed = C.parseAttendance(csv, g, P3);
eq('解析回 3 行', parsed.rowCount, 3);
eq('无未匹配', parsed.unmatched.length, 0);
eq('无未知列', parsed.unmatchedCols.length, 0);

// 造一批状态，导出再导入，逐格比对
const seedCells = [];
['late', 'early', 'sick', 'leave', 'skip', 'absent'].forEach((k, i) => {
  seedCells.push([g.students[i % 3].id, g.dates[i].id, P3[i % 3].id, k]);
});
seedCells.forEach(([s, d, p, k]) => C.setStatus(g, s, d, p, k));
const csv2 = C.toCSV(C.groupCSVRows(g, P3));
const g2 = C.newGroup('1组', g.students.map((s) => s.name));
 g2.dates = g.dates;
const parsed2 = C.parseAttendance(csv2, g2, P3);
C.applyAttendance(g2, parsed2.cells);
let same = 0;
seedCells.forEach(([s, d, p, k]) => {
  const stu = g2.students.find((x) => x.name === g.students.find((y) => y.id === s).name);
  if (C.getStatus(g2, stu.id, d, p) === k) same++;
});
eq('CSV 往返状态一致', same, seedCells.length);

console.log('\nTSV');
const tsv = C.toTSV([['a', 'b'], ['1', '2']]);
eq('TSV 第一行', tsv.split(/\r?\n/)[0], 'a\tb');
eq('TSV 两行', tsv.split(/\r?\n/).length, 2);

console.log('\nXLSX 结构');
// 4 个组 → 4 个 sheet
const xdb = C.emptyDB();
const xcls = C.newClass('高一(1)班');
xcls.groups = ['1组', '2组', '3组', '4组'].map((n, gi) => {
  const gg = C.newGroup(n, ['王梓涵', '李雨桐', '张浩然']);
  gg.dates = C.makeDates('2026-09-07', 1);
  C.setStatus(gg, gg.students[0].id, gg.dates[0].id, 'p1', 'late');
  if (gi === 0) C.setStatus(gg, gg.students[1].id, gg.dates[1].id, 'p2', 'sick');
  return gg;
});
xdb.classes.push(xcls);

const xl = C.exportXLSX(xdb);
ok('返回文件名', /\.xlsx$/.test(xl.filename), xl.filename);
const bytes = Buffer.from(xl.bytes);
ok('ZIP 头', bytes.slice(0, 2).toString() === 'PK');
ok('体积 > 10KB', bytes.length > 10240, bytes.length + ' bytes');

// 手写解析 store-only ZIP：顺序扫描本地文件头
function unzipStore(buf) {
  const out = {};
  let i = 0;
  while (i < buf.length - 4) {
    if (buf.readUInt32LE(i) !== 0x04034b50) {
      i++;
      continue;
    }
    const method = buf.readUInt16LE(i + 8);
    const size = buf.readUInt32LE(i + 18);
    const nameLen = buf.readUInt16LE(i + 26);
    const extraLen = buf.readUInt16LE(i + 28);
    const name = buf.slice(i + 30, i + 30 + nameLen).toString('utf8');
    const start = i + 30 + nameLen + extraLen;
    if (method === 0) out[name] = buf.slice(start, start + size);
    i = start + size;
  }
  return out;
}
const files = unzipStore(bytes);
const names = Object.keys(files);
ok('含 4 个 sheet', names.filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).length === 4, names.length + ' entries');
ok('含 styles', !!files['xl/styles.xml']);
ok('含 workbook', !!files['xl/workbook.xml']);
ok('含 4 个 worksheet 关系', (files['xl/_rels/workbook.xml.rels'].toString('utf8').match(/Target="worksheets\/sheet/g) || []).length === 4);

const s1 = files['xl/worksheets/sheet1.xml'].toString('utf8');
ok('sheet 含冻结窗格', /<pane[^>]*state="frozen"/.test(s1));
ok('sheet 含合并单元格', /<mergeCells/.test(s1));
ok('sheet 含姓名', s1.includes('王梓涵'));
ok('sheet 含日期表头', s1.includes('9月7日'));
ok('sheet 含状态样式 6-11', /s="(?:6|7|8|9|10|11)"/.test(s1));
ok('冻结在 C5', /topLeftCell="C5"/.test(s1));
ok('合并 A1 到末列', /<mergeCell ref="A1:[A-Z]+1"\/>/.test(s1));

const wb = files['xl/workbook.xml'].toString('utf8');
ok('工作簿 4 个表', (wb.match(/<sheet /g) || []).length === 4);
ok('表名含「组」', wb.includes('1组'));

console.log('\n演示数据');
const demo = C.seedDemo();
eq('演示 1 班', demo.classes.length, 1);
eq('演示 4 组', demo.classes[0].groups.length, 4);
eq('演示 144 天', demo.classes[0].groups[0].dates.length, 144);
const dg = demo.classes[0].groups[0];
const demoStats = C.computeStats(dg, dg.dates.map((d) => d.id), P3);
ok('演示数据有异常记录', demoStats.filled > 0, demoStats.filled + ' / ' + demoStats.slots);
ok('演示出勤率合理', demoStats.rate > 0.5 && demoStats.rate < 1, (demoStats.rate * 100).toFixed(1) + '%');

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
