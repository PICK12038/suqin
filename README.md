# 速勤 · 班级考勤工作台

给班主任 / 任课老师用的考勤表：**不用登录客户端，打开网页就能用**。三种使用形态，数据互通：

| 形态 | 适合 | 数据存哪 |
| --- | --- | --- |
| **云端共享版**（推荐） | 多设备 / 多位老师共用一份考勤 | Supabase 云端，15 秒自动同步 |
| 本机服务器版 | 个人使用、局域网给手机 | `data/db.json` |
| 单文件离线版 | 双击即用、微信转发、断网 | 浏览器 localStorage |

三种形态共用同一份前端代码，界面和数据格式完全一致。

---

## 一、最快上手：云端共享版

速勤是纯静态页面，所以可以免费托管在 GitHub Pages，数据放 Supabase——全程零服务器费用。

### 第 1 步：建 Supabase 数据表

1. 打开 <https://supabase.com/dashboard> 选（或新建）你的项目。
2. 左侧 **SQL Editor** → New query，粘贴下面语句并 Run：

```sql
create table if not exists attendance_state (
  id int primary key,
  data jsonb not null,
  updated_at timestamptz not null default now()
);
alter table attendance_state enable row level security;
create policy "attend all" on attendance_state
  for all to anon using (true) with check (true);
```

3. **Project Settings → API**，记下两样东西：
   - `Project URL`：形如 `https://xxxx.supabase.co`
   - `anon public` key：一长串 `eyJ…`

### 第 2 步：打开速勤，填入云端配置

打开速勤网页（本地 `node server.js` 或已部署的 Pages 地址均可）→ 设置 → **云端共享**：

1. 填 Project URL 和 anon key，点「**连接并启用云端**」。
2. 提示「连接成功」后页面自动刷新，左下角变成「已保存 · 云端」。
3. 如果本机已有数据，会自动上传云端；云端已有数据则自动拉取。

之后所有打开同一页面的人共享同一份数据；任何设备改动，其他设备 15 秒内自动同步（最后一次保存优先）。

> 安全说明：anon key 是公开密钥，配合 RLS 策略只对 `attendance_state` 这一张表开放读写，泄漏的最坏后果就是考勤数据被改动。**不要**把 service_role key 放进网页。

## 二、其它两种形态

```bash
node server.js             # 本机服务器版 → http://127.0.0.1:8123
LAN=1 node server.js       # 局域网可访问；PORT=8200 换端口
                           # SUPABASE_URL + SUPABASE_ANON_KEY 环境变量可让页面自动连云端
```

`dist/速勤-考勤工作台.html` 双击即用（设置里同样可连云端，配置存在各自浏览器里）。

## 三、日常操作 30 秒

1. 首次是示例数据，点黄条右侧「清空示例，开始建班」。
2. 左栏「＋ 新建班级」；表格最后一行输入姓名回车加人，支持一次粘贴一整列（换行 / 逗号 / 顿号，自动去行首序号、自动跳重名）。
3. 点名 `Ctrl + Enter`：默认全部出勤，只点异常的学生，`1–6` 标记后自动跳下一个。
4. 日常：点格子弹状态面板；按住拖动框选一片，再按 `1–6` 批量标记；`Ctrl + Z` 撤销（40 步）。

## 四、界面

```
┌─────────────────────────────────────────────────────────────┐
│ 速勤  搜索…                             点名 统计 导出 导入 │
├──────────┬──────────────────────────────────────────────────┤
│ 班级     │  ◀ 第 9 周 ▶  本周  │ 标记 迟到…缺勤  撤销 重做 ? │
│ 高一(1)班│ ─────────────────────────────────────────────── │
│ ＋新建   │  日期 × 时段 的考勤表（首列姓名、末列本周汇总）  │
│ 小组     │                                                  │
│ 1组 2组  │                                                  │
│ 3组 4组  │                                                  │
│ 本周概览 │                                                  │
│ 97.2%    │                                                  │
│ ● 已保存 │ 单击 标记面板 · 拖动 批量标记 · 数据保存在…      │
└──────────┴──────────────────────────────────────────────────┘
```

- 表格：6 天一周（周一至周六，周日不排课），每天上午 / 下午 / 晚上三个时段。
- 行尾「本周」：`★ 全勤` 或按最严重状态着色的汇总（如 `迟2 缺1`）；表尾是当天异常合计。
- 统计视图：出勤率、异常人次、全勤人数、状态分布、学生排名、每日趋势、小组对比。

## 五、快捷键

| 操作 | 键 |
| --- | --- |
| 移动 / 扩展选区 | 方向键 / `Shift + 方向键` |
| 矩形框选 | 鼠标拖动 / `Shift + 单击` |
| 标记 迟到/早退/病假/事假/旷课/缺勤 | `1` `2` `3` `4` `5` `6` |
| 清除标记（= 出勤） | `0` / `Delete` / `Backspace` |
| 打开当前格面板 | `Enter` |
| 撤销 / 重做 | `Ctrl + Z` / `Ctrl + Shift + Z` |
| 打开点名 | `Ctrl + Enter` |
| 搜索学生 | `Ctrl + F`（姓名或拼音首字母，如 `wzh`） |
| 上一周 / 下一周 | `Alt + ←` / `Alt + →` |
| 立即保存 | `Ctrl + S`（平时 300ms 自动保存） |

点名面板内：`↑ ↓` 换行、`Enter` 下一个、`1–6` 标记并自动下移、`0` 清除、`Esc` 退出。

## 六、导入与导出

**导入名单**：粘贴每行一个姓名，或带 `1组 / 2组` 表头的整段名单，勾「按小组自动分组」一次建好 4 组；可选「替换该组原有名单」或追加。

**导入考勤**：从 Excel / WPS 框选表格直接粘贴，或选 `.csv`；自动识别逗号 / 制表符。第一行需含「姓名」，日期列写 `9月7日` 或 `2026-09-07` 均可，同一日期的多列按顺序对应上午 / 下午 / 晚上。导入前有两步预览，只覆盖表里出现的格子。

**导出**：JSON 全量备份、真 xlsx（合并表头 + 冻结窗格 + 状态配色，按小组或整班）、CSV、本周 TSV。

## 七、部署到 GitHub Pages（发布云端共享版）

1. 在 GitHub 上新建仓库（Public），把本目录推上去（首次推送命令见仓库初始化提示，或：

   ```bash
   git init
   git add .
   git commit -m "速勤 v1.1：云端共享版"
   git remote add origin https://github.com/<你的用户名>/<仓库名>.git
   git push -u origin main
   ```

   也可以直接在 GitHub 网页端 Upload files 拖入这些文件：`src/` 全部、`dist/速勤-考勤工作台.html`、`README.md`）。
2. 仓库 **Settings → Pages** → Source 选 `main` 分支 / `(root)` 目录 → Save。
3. 一分钟后访问 `https://<你的用户名>.github.io/<仓库名>/`。
4. 打开页面 → 设置 → 云端共享，填 Supabase 配置——**每个使用者首次打开时各自填一次**（存在各自浏览器里）；
   或者仓库根放一个 `config.json`（内容见下），改 `src/app.js` 里 `ensureCloudConfig` 的兜底地址即可全站生效。

`config.json`（可选，注意这是公开文件，只放 anon key）：

```json
{ "supabase": { "url": "https://xxxx.supabase.co", "key": "eyJ…" } }
```

## 八、和原版「考勤管理系统」比

| | 原版（kaoqin-manager） | 速勤 |
| --- | --- | --- |
| 形态 | 208 KB 单页 + CDN JSZip | 云端共享 / 本机服务 / 单文件三形态 |
| 标记状态 | 同格最多点 7 次循环 | 点一下弹面板，或直接按 `1–6` |
| 批量 | 只能逐格 | 拖动框选 + 键盘批量，支持「本节 / 整天」 |
| 撤销 | 无 | 40 步撤销 / 重做 |
| 名单键 | 行号（换名单错位） | 学生 ID + 日期 + 时段，随便重排 |
| 汇总 | 本周异常 | 出勤率、排名、每日趋势、小组对比 |
| 多设备 | 无 | Supabase 云端同步（15 秒轮询） |

## 九、开发

```bash
node server.js             # 启动网站（PORT / LAN / DATA_DIR / SUPABASE_URL / SUPABASE_ANON_KEY）
node build/build.js        # 打包单文件版 dist/速勤-考勤工作台.html
node test/core.test.js     # 62 项纯逻辑（日期、记录、汇总、CSV 往返、xlsx 结构）
node test/smoke.js         # 37 项端到端（headless Edge + CDP）
node test/server.test.js   # 19 项：API 读写、落盘备份、页面在服务器模式下的行为
node test/dist.test.js     # 11 项：单文件产物的 file:// 渲染与存储
node test/visual.js        # 截图体检，输出到 test/shots/（URL=… 可对准运行中的服务）
```

- 无构建依赖、无框架；`core.js` 用 UMD 包装，Node 与浏览器共用同一份逻辑。
- xlsx 由 `core.js` 自己写 ZIP（store 模式）+ SpreadsheetML，不依赖 JSZip。
- 云端走 Supabase REST（PostgREST）直连，无需 SDK：单表 `attendance_state` upsert 单行 JSON。
- 打包脚本用函数式 `replace`，避免源码里的 `$$` / `$&` 被当成替换插值。

目录：

```
suqin-attendance/
├─ server.js       本机 Web 服务（静态托管 + /api/db + /api/config）
├─ src/            index.html · styles.css · core.js · app.js · pinyin.js
├─ data/           本机服务器版数据（自动生成，不入 git）
├─ dist/           单文件离线版
├─ test/           core / smoke / server / dist / visual + shots/
└─ build/          build.js
```

