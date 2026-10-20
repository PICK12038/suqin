// 一次性脚本：检查并修复云端各小组日期列的「周一对齐」问题
// 现象：1组日期从 2026-05-01（周五）开始，6 天一周的切块从周五起 → 显示顺序变成 周五、周六、周一…周四
// 修法：把每个小组日期数组排序；若首日不是周一，则从 mondayOf(首日) 起补齐周一~周六（缺哪天补哪天），
//      使数组重新与周一 Stony 对齐；已有记录按日期 ID 存储，不受列顺序影响。
const C = require('../src/core.js');
const fs = require('fs');

const SUPA = {
  url: 'https://qcvefxutsncfbhfnrczh.supabase.co',
  key: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFjdmVmeHV0c25jZmJoZm5yY3poIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA0MTc4MTcsImV4cCI6MjA5NTk5MzgxN30.pjdqBGfpxR4IVSjSRf8dnMicndErvrEMK-pRY7gUQkU'
};

async function main() {
  const r = await fetch(SUPA.url + '/rest/v1/attendance_state?id=eq.1&select=data,updated_at', {
    headers: { apikey: SUPA.key, Authorization: 'Bearer ' + SUPA.key }
  });
  if (!r.ok) throw new Error('GET ' + r.status);
  const rows = await r.json();
  if (!rows.length) throw new Error('cloud empty');
  const db = rows[0].data;
  const report = [];

  for (const cls of db.classes) {
    for (const g of cls.groups) {
      if (!g.dates || !g.dates.length) continue;
      g.dates.sort(function (a, b) { return a.id < b.id ? -1 : a.id > b.id ? 1 : 0; });
      const first = g.dates[0].id;
      const wd = C.weekdayIdx(first); // 0=周一
      if (wd === 0) { report.push(cls.name + '/' + g.name + ' 已对齐 (' + first + ')'); continue; }
      // 从 mondayOf(first) 起补齐到 first（只补周一~周六里缺的）
      const have = new Set(g.dates.map(d => d.id));
      let cur = C.mondayOf(first);
      const add = [];
      let guard = 0;
      while (cur <= first && guard++ < 100) {
        if (C.weekdayIdx(cur) <= 5 && !have.has(cur)) add.push(cur);
        cur = C.addDays(cur, 1);
      }
      add.forEach(function (iso) {
        g.dates.push({ id: iso, iso: iso, label: C.fmtLabel(iso), tag: '' });
      });
      g.dates.sort(function (a, b) { return a.id < b.id ? -1 : a.id > b.id ? 1 : 0; });
      report.push(cls.name + '/' + g.name + ' 原首日 ' + first + '(周' + '一二三四五六日'[wd] + ') → 补 ' + add.length + ' 天, 现首日 ' + g.dates[0].id);
    }
  }
  report.forEach(x => console.log('  ' + x));

  const needFix = report.some(x => x.indexOf('已对齐') < 0);
  if (!needFix) { console.log('ALL ALIGNED, no write'); return; }

  db.meta = db.meta || {};
  db.meta.updatedAt = new Date().toISOString();
  const up = await fetch(SUPA.url + '/rest/v1/attendance_state', {
    method: 'POST',
    headers: {
      apikey: SUPA.key, Authorization: 'Bearer ' + SUPA.key,
      'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates'
    },
    body: JSON.stringify([{ id: 1, data: db, updated_at: new Date().toISOString() }])
  });
  console.log('UPSERT', up.status);
  if (!up.ok) { console.log(await up.text()); process.exit(1); }
  fs.writeFileSync(__dirname + '/cloud-backup-align-' + Date.now() + '.json', JSON.stringify(rows[0], null, 1));
  console.log('backup saved');
}
main().catch(e => { console.error('ERR', e.message); process.exit(1); });
