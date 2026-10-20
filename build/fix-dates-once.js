// 一次性维护脚本：为云端每个小组的日期列补齐到「本周 + 未来 8 周」
// 只追加不删改，旧记录按日期 ID 天然保留；标签(考试倒计时等)只影响新增日期(为空)
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
  const updatedBefore = rows[0].updated_at;

  const today = C.todayISO();
  const thisMonday = C.mondayOf(today);
  // 目标终点：本周周六 + 8 周
  const endISO = C.addDays(thisMonday, 7 * 9 - 2); // 周一+61天 = 第9周周六
  let changed = [];

  for (const cls of db.classes) {
    for (const g of cls.groups) {
      if (!g.dates || !g.dates.length) continue;
      const have = new Set(g.dates.map(d => d.id));
      const last = g.dates[g.dates.length - 1].id;
      if (last >= endISO) continue;
      // 从 last 之后一天起，逐日生成周一~周六直到 endISO
      let cur = C.addDays(last, 1);
      let guard = 0;
      while (cur <= endISO && guard++ < 400) {
        const wd = C.weekdayIdx(cur); // 0=周一 .. 6=周日
        if (wd <= 5 && !have.has(cur)) {
          g.dates.push({ id: cur, iso: cur, label: C.fmtLabel(cur), tag: '' });
          have.add(cur);
        }
        cur = C.addDays(cur, 1);
      }
      changed.push(cls.name + '/' + g.name + ': ' + last + ' → ' + g.dates[g.dates.length - 1].id + ' (+' + (g.dates.length) + '天总量)');
    }
  }

  if (!changed.length) { console.log('NO CHANGE needed'); return; }
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
  console.log('prev updated_at', updatedBefore);
  changed.forEach(c => console.log('  ' + c));
  // 备份旧数据到本地文件
  fs.writeFileSync(__dirname + '/cloud-backup-' + Date.now() + '.json', JSON.stringify(rows[0], null, 1));
  console.log('backup saved');
}
main().catch(e => { console.error('ERR', e.message); process.exit(1); });
