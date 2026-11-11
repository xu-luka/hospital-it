# 开发环境（写给新加入的开发者）

> 系统功能与架构看 [`README.md`](./README.md)；部署/运维看 [`DEPLOY.md`](./DEPLOY.md)
> 和 `医院信息科日常管理系统-部署与使用手册.docx`；
> 本文件只讲**怎么在本机把项目跑起来、怎么协作贡献代码**。
> 文档最近同步：2026-11-11（按当前代码核对：17 个页面、四库、26 个 selftest + 6 个 e2e）。

## 一、5 分钟跑起来

前置：装好 [Node.js 22.5+ 或 24.x](https://nodejs.org/)（必须带 `node:sqlite`，22.5 起内置），
能连 npm registry（装依赖用），能连 GitHub（拉代码用）。

```bash
git clone git@github.com:xu-luka/hospital-it.git
cd hospital-it
node scripts/dev-setup.js     # 装 npm 依赖 + 生成本机主密钥
node server.js                # 或双击 start.bat（Windows）
```

看到 `Hospital IT System ... on http://127.0.0.1:3131` 就成了。
浏览器打开 `http://127.0.0.1:3131`，用 **admin** 登录 —— 首次启动会**随机生成**初始口令，
打印在控制台这一行：

```
[seed] 初始管理员 admin 已创建，随机初始口令：xxxxxxxx
```

记下它，登录后到【系统管理 → 修改密码】改掉。

> Mac / Linux 也能跑，但**机房巡检的设备采集依赖 Windows**（WMI 走 `wmitools/WmiQuery.exe`，
> 设备口令加解密走 `secrets/KeyVault.exe`），所以非 Windows 上巡检功能跑不全 ——
> 合同、工单、技术文档、书签、IP 管理、终端资产、上线管理这些模块跨平台都能开发。

## 二、这个项目的几个「和别人不一样」

1. **没有构建步骤**。前端用 Vue 3 的**运行时编译**（`vue.global.prod.js` 自带编译器），
   `static/js/*.js` 里的 `template: \`...\`` 就是源码也是产物。改完**按 Ctrl+F5 强刷**就生效，
   不用 webpack / vite / npm run build。代价是组件文件偏大，多人改同一文件易冲突 —— 见下面分工。
2. **主密钥机器绑定**。`secrets/master.key` 由 Windows DPAPI（LocalMachine）保护，
   **每台机器一份、不能跨机复用**，已在 `.gitignore`。含密文的数据
   （`data/inspection.json`、`data/*.db`）也都排除了 —— 所以不会出现
   「A 提交的密文 B 解不开」那种串味事故。你本机生成的 master.key 只在你机器上能用。
3. **开发与部署是两套**。开发用 git PR 合 main；**部署**是「出更新包拷到服务器」
   （技能 `hospital-it-frontend-update-pkg`，含后端时需重启服务）。你本机跑的是开发库，
   服务器是另一套自包含目录（带 `runtime/node.exe`）。**别在开发库上跑 `npm run backup`**
   把开发数据当生产备份。
4. **自测很全**。`scripts/` 下 26 个 `*-selftest.js` + 6 个 `*-e2e.js`，再加前端四件套与 Vue 模板编译，
   是现成的回归网，提 PR 前跑一遍能挡掉大部分问题（见下面「提 PR 前必做」）。
5. **四个库，别只备份两个**。`data/contract.db`（合同/账号/权限/日志/书签/IP/上线/巡检设备台账/告警规则）、
   `data/his.db`（工单/终端资产）、`data/docs.db`（文档索引与正文）、`data/inspect.db`（巡检历史/流量/告警事件）。
   表建在 `contract.db` 会被 `scripts/backup.js` 自动纳入备份；新增模块的表自己 `CREATE TABLE IF NOT EXISTS`。

## 三、开发循环

```
main ──→ feat/合同-导出 ──→ 改代码 ──→ 跑自测 ──→ push ──→ PR ──→ review ──→ 合 main
```

- **分支命名**：`feat/<模块>-<简述>`、`fix/<简述>`、`docs/<简述>`。例：`feat/ipam-导入校验`。
- **不要直接 push main**。开分支 → 提 PR → 至少一人 review。
- **commit 信息**：说清改了什么、为什么。不必拘泥 conventional-commits 格式，但别只写 `fix`。
- **`sync_hospital_it.py`** 是「单人整理」用的快捷推送（直接 push main），**协作阶段不要用它**
  —— 它绕过了 PR 与 review。

## 四、提 PR 前必做（前端四件套 + 后端自测）

工具分两处，别在仓库里找 `_ui_redesign/` —— **它不在 git 仓库内**，在 WorkBuddy 工作区根目录
（与仓库所在目录同级的工具目录）。仓库自带的是 `npm run check:views` 与 `npm run check`。

```bash
# 前端四件套（工作区 _ui_redesign/，改了 static/js/** 或 static/css/** 就跑）
node _ui_redesign/check_components.js     # 组件名解析
node _ui_redesign/check_main_template.js  # 外壳模板 + VIEW_NAMES
python _ui_redesign/check_css.py           # CSS 配套
python _ui_redesign/survey_classes.py      # 模板用到的 class 都有定义

# Vue 模板编译（改了任何 view 的 template 字符串就跑，无浏览器也能验）
node ~/.workbuddy/skills/vue-template-offline-check/scripts/check-vue-templates.js \
     static/vendor/vue.global.prod.js static/js/*.js

# 仓库内自带
npm run check:views                        # 视图名能被 Vue 解析（防白屏）
npm run check                              # 部署自检
```

后端自测按改动模块选跑（`scripts/` 共 26 个 selftest + 6 个 e2e）：

| 分组 | 脚本 |
| --- | --- |
| 业务模块 | `ipam-*` / `terminals-migrate-*` / `bookmarks-*` / `perm-*` / `doctext-*` / `docs-preview-*` / `sla-*` / `logclean-*` / `loginlock-*` |
| 巡检采集 | `exporter-*` / `linux-*` / `check-result-*` / `compare-*` / `startup-degrade-*` / `report-print-*` |
| 流量监控 | `netflow-*` / `netmon-exclude-*` / `netstore-*` |
| 历史与告警 | `history-trend-*` / `alert-*` |
| 端到端 | `bookmark-ipam-api-e2e` / `launches-e2e` / `loginlock-e2e` / `netflow-api-e2e` / `perm-api-e2e` / `terminals-e2e` |

```bash
node scripts/ipam-selftest.js
node scripts/exporter-selftest.js
node scripts/history-trend-selftest.js
# …其余同理，改了哪个模块就跑对应那组
```

> ★ 别只看退出码：`startup-degrade-selftest.js` 在 Windows 上有 libuv 退出码 127 的既有问题，
> 断言 8/8 全过、输出「全部通过」即算通过。e2e 里部分要起真服务并依赖 `secrets/KeyVault.exe`（仅 Windows）。

改完还要：起真服务打 HTTP 冒烟 → 预览页无头断言 → 出更新包并实测「更新 → 回滚 → 再更新」→ 推 GitHub。
清单含 `server.js` / `src/**` / `scripts/**` 的包**必须重启服务**，只有 `static/**` 的包 Ctrl+F5 即可。

## 五、常用命令

```bash
node server.js              # 启动（等同 npm start）
node scripts/doctor.js      # 环境自检（npm run check）
node scripts/backup.js      # 手动备份（生产用；开发库别乱跑）
```

## 六、改哪个模块？分工建议

| 模块 | 前端 | 后端 | 备注 |
| --- | --- | --- | --- |
| 外壳 / 菜单 / 工作台 | `static/js/main.js` `app.js` | `src/routes/dashboard-*.js` | 菜单与命令面板在 main.js |
| 合同 / 到期提醒 / 收付款 / 用户 / 日志 | `static/js/contract-views.js` | `src/routes/contracts.js` `payments.js` `users.js` `logs.js` `src/db-contract.js` | 大文件，建议专人；此文件覆盖注册了 UsersView/LogsView |
| 问题工单 | `static/js/app.js`（IssuesView/IssueDetailView） | `src/routes/issues.js` `src/db.js` `src/issue-sla.js` | app.js 很大 |
| 上线管理 | `static/js/launch-view.js` | `src/launches.js` `src/routes/launches.js` | 状态流转写 `launch_events` 留痕 |
| 技术文档 | `static/js/docs-views.js` | `src/routes/docs.js` `src/db-docs.js` `doctext.js` `docpreview.js` | 文档正文检索，不依赖新组件 |
| 网页书签 | `static/js/bookmark-view.js` | `src/bookmarks.js` `src/routes/bookmarks.js` | 密码加密 + `bookmarks.secret` 独立授权 |
| IP 管理 | `static/js/ipam-view.js` | `src/ipam.js` `src/routes/ipam.js` | CIDR 纯函数；三个来源读时合并，不双写 |
| 终端资产 | `static/js/terminal-view.js` | `src/terminals.js` `src/routes/terminals.js` | 21 列 Excel，`terminals` 在 his.db |
| 设备台账 / 报告 / 大屏 | `static/js/inspect-views.js` `inspect-screen.js` | `src/inspection/**` `src/routes/inspection*.js` | 依赖 Windows 采集工具 |
| 巡检扩展 P1/P2/P3 | `static/js/inspect-screen.js` | `src/inspection/lib/exporter.js` `history.js` `alerts.js` | 规则在 contract.db，事件在 inspect.db |
| 流量监控 | `static/js/netflow-view.js` | `src/inspection/netflow.js` `netmon.js` `netstore.js` `src/routes/inspection-netflow.js` | **不在 `src/netflow*`**，早期文档写错了 |
| 角色权限 | `static/js/perm-view.js` | `src/perm.js` `src/routes/roles.js` | `MODULES` 是唯一事实来源 |

每人领 1–2 个模块，改之前在 issue 里说一声，减少撞文件。

## 七、约定速查（踩过的坑都在这）

- **新增标准模块固定 13 处**：业务层 / 路由 / `src/db.js`（仅加列）/ `src/perm.js` 的 `MODULES` /
  `server.js` / 视图 / `main.js` 5 处 / `authz.js` / `index.html` / `style.css` /
  `check_main_template.js` 的 `VIEW_NAMES` / 预览页 4 处 / e2e。漏一处通常不是报错，
  而是「白屏 / 一直转圈 / 点了没反应」。`authz.js` 是权限判定的第二份实现，两处判定规则都要改。
- `getDb()` 在 `init()` 前会抛错 —— 路由模块在 `require` 阶段**不能建表**，必须懒建 `ensure()`；
  老库补列用 `PRAGMA table_info` + `ALTER TABLE`，新列上的索引要放在补列之后单独 try/catch 建。
- `static/css/tokens.css` 必须在 `style.css` 之前加载，漏了整片失去配色。
- 旧机器兼容：不用 `color-mix()` / CSS 嵌套 / `:has()` / 容器查询（基线 Chrome/Edge 100+）。
- 表格 `table-layout: fixed` 且列宽之和 = `min-width`；表单弹窗去掉 `@click.self`、走 `tryCloseXxx()`
  （工具在 `api.js` 的 `HisUI`），只读弹窗才保留点背景关闭。
- **Vue computed 是无参 getter**，带参函数一律放 `methods`，否则渲染期整块白屏。
- `reasons` / `errors` 是对象数组，拼接前必须先 map 出字段；「阈值告警」和「连接失败」不能共用 `error`。
- 任何代码改动一律出「按文件替换」的更新包并实测更新/回滚/再更新；`data/`、`secrets/master.key`、
  `config.js`、`uploads/`、`node_modules/`、`runtime/` 是替换禁区。

更全的约定见 `.workbuddy/memory/` 下的项目记忆（如果你也在用 WorkBuddy）。
