# 开发环境（写给新加入的开发者）

> 部署/运维看 [`DEPLOY.md`](./DEPLOY.md) 和 `医院信息科日常管理系统-部署与使用手册.docx`；
> 本文件只讲**怎么在本机把项目跑起来、怎么协作贡献代码**。

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
> 合同、工单、文档、书签、IP 管理这些模块跨平台都能开发。

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
4. **自测很全**。6 个 selftest + 前端四件套，是现成的回归网，提 PR 前跑一遍能挡掉大部分问题
   （见下面「提 PR 前必做」）。

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

全在仓库里，跨平台、不依赖 Windows 工具（除 `bookmark-ipam-api-e2e` 起真服务 + KeyVault.exe）：

```bash
# 前端四件套（在 _ui_redesign/ 里，改了 static/js/** 或 static/css/** 就跑）
node _ui_redesign/check_components.js     # 组件名解析
node _ui_redesign/check_main_template.js  # 外壳模板
python _ui_redesign/check_css.py           # CSS 配套
python _ui_redesign/survey_classes.py      # 模板用到的 class 都有定义

# Vue 模板编译（改了任何 view 的 template 字符串就跑）
node ~/.workbuddy/skills/vue-template-offline-check/scripts/check-vue-templates.js \
     static/vendor/vue.global.prod.js static/js/*.js

# 后端自测（改了 src/** 或 scripts/** 就跑对应的）
node scripts/ipam-selftest.js
node scripts/bookmarks-selftest.js
node scripts/docs-preview-selftest.js
node scripts/perm-selftest.js
node scripts/perm-frontend-selftest.js
# 起真服务打 HTTP（仅 Windows，依赖 KeyVault.exe）：
node scripts/bookmark-ipam-api-e2e.js
```

四件套全绿才算改完。

## 五、常用命令

```bash
node server.js              # 启动（等同 npm start）
node scripts/doctor.js      # 环境自检（npm run check）
node scripts/backup.js      # 手动备份（生产用；开发库别乱跑）
```

## 六、改哪个模块？分工建议

| 模块 | 前端 | 后端 | 备注 |
| --- | --- | --- | --- |
| 合同台账 | `static/js/contract-views.js` | `src/routes/contracts.js` `src/db-contract.js` | 大文件，建议专人 |
| 问题工单 | `static/js/app.js`（IssuesView/IssueDetailView） | `src/routes/issues.js` `src/db.js` | app.js 很大 |
| 机房巡检 | `static/js/inspect-views.js` `inspect-screen.js` | `src/inspection/**` | 依赖 Windows 工具 |
| 技术文档 | `static/js/docs-views.js` | `src/routes/docs.js` | |
| 网页书签 | `static/js/bookmark-view.js` | `src/bookmarks.js` `src/routes/bookmarks.js` | 密码加密 |
| IP 管理 | `static/js/ipam-view.js` | `src/ipam.js` `src/routes/ipam.js` | CIDR 纯函数 |
| 流量监控 | `static/js/netflow-view.js` | `src/netflow*` | |
| 角色权限 | `static/js/perm-view.js` | `src/perm.js` | `MODULES` 是唯一事实来源 |

每人领 1–2 个模块，改之前在 issue 里说一声，减少撞文件。

## 七、约定速查（踩过的坑都在这）

- 新增模块只改 `src/perm.js` 一行（`MODULES`）；前端 `static/js/authz.js` 是第二份实现，**两处都要改**。
- `static/css/tokens.css` 必须在 `style.css` 之前加载，漏了整片失去配色。
- 旧机器兼容：不用 `color-mix()` / CSS 嵌套 / `:has()` / 容器查询（基线 Chrome/Edge 100+）。
- 表建在 `contract.db` 即自动纳入每日备份；新模块的表自己 `CREATE TABLE IF NOT EXISTS`。
- 弹窗按用途分两档：只读弹窗保留 `@click.self`，表单弹窗去掉、走 `tryCloseXxx()`（工具在 `api.js` 的 `HisUI`）。

更全的约定见 `.workbuddy/memory/` 下的项目记忆（如果你也在用 WorkBuddy）。
