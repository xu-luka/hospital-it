# 医院信息科一体化管理系统

合同台账、问题工单、技术文档、资产与 IP、系统上线管理、**机房设备巡检与监控**的一体化管理系统。
B/S 架构，内网 / 单机部署，单进程、单端口（3131），双击 `start.bat` 即可使用。

原「机房设备巡检系统」已整体并入：共用一套账号、一套权限矩阵、一套操作日志、一份备份。
当前版本共 **17 个功能页面 / 8 个菜单组 / 4 个 SQLite 库**，功能与权限清单以
`src/perm.js` 的 `MODULES`、`static/js/main.js` 的 `MENU` 为唯一事实来源。

> 本文档按当前代码同步（2026-11-11）。部署与运维细节看 [DEPLOY.md](./DEPLOY.md)，
> 开发与协作约定看 [DEV.md](./DEV.md)。

## 一、功能总览

| 菜单组 | 页面 | 主要能力 | 权限码 |
| --- | --- | --- | --- |
| 概览 | 工作台 | 合同 / 问题双标签统计、到期横幅、趋势与分布图 | `dashboard.view` |
| 合同管理 | 合同台账 | 合同 + 设备明细 + 付款记录 + 附件，Excel 导入导出、筛选排序 | `contracts.*` |
| 合同管理 | 到期提醒 | 已逾期 / 30 天内到期清单 | `remind.view` |
| 合同管理 | 收付款 | 按合同登记付款，自动算已付 / 未付与进度 | `payments.*` |
| 系统问题管理 | 问题记录 / 新建问题 / 详情 | 建单、指派、状态流转、处理记录、附件灯箱、SLA 时限、批量操作、导入导出 | `issues.*` |
| 系统上线 | 上线管理 | 上线档案、6 个阶段任务、5 档状态流转与留痕 | `launches.*` |
| 技术文档库 | 技术文档 | Word/PDF 上传、正文检索、类型/标签管理、在线预览与独立预览页 | `docs.*` |
| 资源管理 | 网页书签 | 分组书签、口令加密存储、「看密码」独立授权 | `bookmarks.*` / `.secret` |
| 资源管理 | IP 管理 | 网段(CIDR)、IP 登记、三来源合并、空闲地址、分布图、批量登记 | `ipam.*` |
| 资源管理 | 终端资产 | 21 列信息设备台账、Excel 导入导出、关联工单与一键报修 | `terminals.*` |
| 机房巡检 | 监控大屏 | 实时状态、扩展指标、历史趋势、阈值告警、流量视图、投屏 | `screen.view` |
| 机房巡检 | 设备台账 | 巡检对象、凭据加密、通道自检/对比、巡检参数 | `devices.*` |
| 机房巡检 | 巡检报告 | 手工/周报生成、在线预览、打印 PDF、下载 | `inspection.*` |
| 机房巡检 | 流量监控 | 交换机端口级 TopN、快照、突发告警、趋势、阈值设置 | `netflow.*` |
| 系统管理 | 用户管理 | 用户增删改、启停、重置口令 | `users.manage` |
| 系统管理 | 角色权限 | 自定义角色 + 模块×动作权限矩阵 | `roles.manage` |
| 系统管理 | 操作日志 | 关键操作审计（含来源 IP）、筛选与导出 | `logs.view` |

## 二、业务模块要点

### 合同与工单

- **合同台账**：合同编号/名称/分类/甲乙方/金额/起止日期/状态；每份合同可挂多行设备明细、
  多笔付款、多个附件（≤ 50MB、中文文件名）；自动汇总台数与回款进度；支持按模板批量导入与按当前筛选导出。
- **到期提醒**：已过期与 30 天内到期自动汇总，工作台横幅同步提醒。
- **问题工单**：按「问题记录时间」生成单号（可补录历史问题）；一级分类 / 二级模块可现场新增；
  待处理 → 处理中 → 已解决 → 已关闭，可退回、重开、指派、批量改状态；处理记录追加、
  响应/处理 SLA 时限、附件上传与图片/PDF/视频/Word/Excel 灯箱预览、打印工单。
- **工作台**：合同与问题两套统计卡、近 12 个月新增、分类/紧急度/每日趋势分布、最近动态。

### 技术文档、书签与上线

- **技术文档库**：文档上传（Word/PDF，旧版 `.doc` 自动降级文本预览或借 LibreOffice 转 docx）、
  不依赖新组件自行提取 docx/PDF 正文做全文检索、类型与标签管理、重建索引、独立预览页。
- **网页书签**：按分组维护系统入口与账号口令；口令用本机主密钥加密，接口默认不下发，
  须持 `bookmarks.secret` 且点击「查看密码」时才单独取一次并记日志 —— 管理权不等于看口令权。
- **上线管理**：记录系统、厂商、上线/试运行日期与负责人；6 个阶段任务可勾选增删；
  筹备中 / 试运行 / 已上线 / 已验收 / 已回滚 五档状态流转，每次流转写事件留痕（谁、何时、从哪到哪、原因）。
  全员可看，编辑与流转需 `launches.manage`。

### 资源与 IP

- **终端资产**：按《信息设备台账》21 列建账（PC、打印机、自助机等连不上也管不了的设备），
  支持 Excel 导入导出、任意列检索、科室/统计类别/设备性质筛选、关联工单与「为这台设备报修」。
  与巡检的「设备台账」刻意分开：一个是资产台账（his.db），一个是可采集的服务器/网络设备（contract.db）。
- **IP 管理**：网段按 CIDR 计算容量、网关、VLAN 与剩余地址；地址有三个来源，
  优先级 **手工登记 > 终端资产 > 巡检设备台账**，全部读时合并、`ipam` 不回写任何业务表（避免双写漂移）；
  内网与外网地址都进分布图，支持按地址精确跳转查询、批量登记（先 dry_run 预览）、冲突提示。
  「已登记」按实际占用算，包含只来自终端/设备的地址。

## 三、机房巡检与监控

### 采集通道

| 设备类型 | 通道 | 说明 |
| --- | --- | --- |
| Linux | `password` / `key` | SSH 只读脚本，CPU 按差分、iowait/steal、fd/inode、TCP 状态、重传、每盘 IOPS、软 RAID、时间偏差、OOM 等扩展指标 |
| Windows | `password` / `key` / `wmi` / `exporter` / `local` | `exporter` 走 windows_exporter `/metrics` 只读 HTTP；`local` 采本机；旧系统（2008 R2 / 2012）推荐 exporter 0.23.1 |
| BMC / 交换机 / vSphere / 数据库 | Redfish / CLI / vSphere API / MSSQL / Oracle | 管理口、端口表、虚机与数据库连通性 |

windows_exporter 采集兼容 0.23.1 / 0.29 / 0.30 / 0.32 多轮指标名变化（含 `service` 标签、
`current_bandwidth_bytes` 单位、`cpu_time_seconds_total`、开机时间等），并解析 `textfile` 自定义业务指标
（`his_` 白名单、`# HELP` 中文名/单位、上限 50 条）。采集跑在独立子进程，不阻塞 Web。

### P1 / P2 / P3 扩展监控

- **P1 扩展采集**：`extra` 里给 CPU 多核、逻辑核数、开机时长、磁盘/网卡、服务状态、textfile 业务指标；
  大屏卡片给「扩展 N 项」摘要行，点开是分组明细表；设备台账可单台自检与双通道并排对比。
- **P2 历史趋势**：`it_inspect_history.metrics_json` 存整包指标，内存分桶提供 1h / 6h / 24h / 7d 四档
  `/trend`、`/series`、`/metrics/catalog`、`/availability`；大屏画 min-max 带、折线与阈值虚线。
- **P3 阈值告警**：独立事件层，规则在 `contract.db`（进每日备份）、事件在 `inspect.db`；
  9 条全局默认规则 + 按设备覆盖，支持连续 N 轮、冷却、确认、恢复、升级重确认。
  告警与「连接失败」严格分开，不会用红框遮住正常采集结果。

### 流量监控

通过 SSH 采集交换机端口级入/出向流量，默认 5 分钟一轮，时序与告警存 `inspect.db`；
提供 TopN 排行（按 IP / 按端口）、最新快照、突发告警（基线倍数 + 绝对下限 + 冷却）、
端口趋势 SVG 与阈值设置；可排除防火墙/网关口，告警支持单条与批量确认。大屏内也嵌了四套流量版式。

### 大屏、台账与报告

- **监控大屏**：统计卡 + 扩展监控与告警区 + 设备分区折叠（服务器 / 虚拟化 / 交换机 / 管理口 / 数据库）、
  严重项排前与呼吸提醒、TopN 榜与迷你趋势、全屏投屏；统计卡下方的扩展区含 textfile 业务卡、
  趋势面板、活跃告警、阈值规则编辑。
- **设备台账**：增改删设备、凭据加密入库、启停巡检、连通性自检（告警与错误分栏）、通道对比、巡检参数
  （并发/超时/间隔/SSH 端口/报告目录/各阈值）。
- **巡检报告**：手工一键生成或每周计划任务自动出周报；报告列表、iframe 在线预览、浏览器打印 PDF、下载；
  报告下载走路径白名单校验。

## 四、权限与安全

- 权限编码 = `模块.动作`（`contracts.view` / `issues.manage` …），17 个模块清单是唯一事实来源；
  前端菜单、权限矩阵、默认矩阵都从它派生。`manage` 隐含 `view` / `create`，
  **但 `secret` 只由自己满足**：能改书签的人未必该看口令。
- 角色可自定义增删改名，内置 `admin` 角色恒为 `*` 全权，任何配置都清不掉；
  权限读取失败时降级到内置默认值，而不是把所有人都变成 403。
- 认证：手写 JWT（HMAC-SHA256，12 小时）+ scrypt 口令哈希；连续 5 次登录失败锁定 10 分钟；
  操作日志含来源 IP，默认保留 180 天；响应带安全头与 CSP，`/api/` 一律 `no-store`。
- 设备口令 / 书签口令用 `secrets/master.key` 加密，走 Windows DPAPI LocalMachine 绑定本机；
  接口永不下发密文，主密钥不可用时拒绝保存口令。**换机器必须先 `KeyVault.exe export` 再 `import`**，
  直接拷 `master.key` 文件无效。静态资源由 Express 直出（弱 ETag），改完前端按 **Ctrl+F5** 强刷。

## 五、技术架构

| 层 | 技术 |
| --- | --- |
| 运行时 | Node.js ≥ 22.5（内置 `node:sqlite`，零原生编译依赖），发布包自带便携 `runtime/node.exe` |
| Web 框架 | Express 4，单进程单端口 3131，`0.0.0.0` 内网 HTTP |
| 前端 | Vue 3 运行时编译（`vue.global.prod.js` 自带编译器），**无构建步骤**；`tokens.css` 必须在 `style.css` 之前加载；基线 Chrome/Edge 100+ |
| 数据存储 | SQLite **四库**：`contract.db` / `his.db` / `docs.db` / `inspect.db` + `uploads/` 附件 |
| 认证与权限 | 手写 JWT + scrypt；`src/perm.js` 角色权限矩阵；`src/middleware/security.js` 安全头 |
| 设备采集 | SSH / WMI / windows_exporter / local / Redfish(BMC) / vSphere / 交换机 CLI / MSSQL / Oracle，跑在独立子进程 |
| 备份 | `scripts/backup.js`：四库 `VACUUM INTO` 一致快照 + 附件 + `.secret` + `secrets/`，打包 zip 并轮转保留 |

部署目标机器无需联网、无需安装数据库服务或 Node；`node_modules` 可整体拷贝。

## 六、目录结构

```
<部署根>/                      # 判据：这一层里有 server.js
├─ server.js                   # 服务入口：中间件 → 22 个路由模块 → 静态资源 → SPA 回退
├─ config.js                   # 端口 / 四库路径 / 巡检 / 文档 / 登录锁 / 日志保留配置
├─ start.bat  init.bat  backup.bat  diagnose.bat
├─ package.json
├─ runtime/node.exe            # 便携 Node（发布包自带，git 仓库不含）
├─ scripts/
│  ├─ backup.js  doctor.js  check-views.js       # 备份 / 部署自检 / 前端视图名校验
│  ├─ weekly-cli.js  register-weekly.js  inspect-cli.js  migrate-config-to-db.js
│  ├─ import-issues.js  issue-duplicates.js  issue-dedup-clean.js
│  └─ *-selftest.js / *-e2e.js                  # 26 个离线自测 + 6 个端到端
├─ src/
│  ├─ db.js  db-contract.js  db-docs.js          # his / contract / docs 三库建表与迁移
│  │                                            # （inspect.db 由巡检内核自建）
│  ├─ auth.js  perm.js  utils.js  loginlock.js  logclean.js  issue-sla.js
│  ├─ ipam.js  terminals.js  launches.js  bookmarks.js  doctext.js  docpreview.js
│  ├─ routes/                                   # 22 个路由文件（5 个共用 /api/inspection）
│  ├─ middleware/security.js
│  └─ inspection/                               # 采集内核：lib/、scheduler、history、alerts、
│                                              # netflow/netmon/netstore、device-repo、report…
├─ static/                     # 前端：index.html + css/(tokens,style) + js/ + vendor/vue
├─ secrets/                    # KeyVault.exe + master.key —— 必须离线备份
├─ wmitools/                   # Windows 本机采集辅助工具
├─ data/
│  ├─ contract.db              # 合同 / 账号 / 权限 / 日志 / 书签 / IP / 上线 / 巡检设备台账 / 告警规则
│  ├─ his.db                   # 问题工单 / 终端资产
│  ├─ docs.db                  # 技术文档索引与正文
│  ├─ inspect.db               # 巡检历史 / 流量时序 / 告警事件（默认保留 90 天）
│  ├─ reports/                 # 巡检报告 HTML（可再生产物，不随备份打包）
│  └─ .secret                  # JWT 密钥
└─ uploads/                    # contract/ + issue/ + docs/（含 .converted 预览缓存）
```

## 七、部署与更新

### 1. 首次部署

把整个部署包拷到目标机器（示例路径统一写 `<部署根>`；当前生产实例为 `E:\hospital-it`，
早期文档里的 `D:\` 不要照抄）。目录里必须有 `server.js`，`src/inspection/paths.js` 按相对层级推导根目录，
**别随意改变目录层级**。可选先跑 `init.bat` 生成本机主密钥，再双击 `start.bat`：

```
医院信息科日常管理系统 已启动
本机访问:   http://127.0.0.1:3131
局域网访问: http://<本机IP>:3131
```

首次启动自动建四库并创建唯一初始管理员 `admin`，口令随机生成并打印在启动窗口；
想固定初始口令，启动前设环境变量 `ADMIN_PASSWORD`。上机后第一条命令跑 `npm run check`。
供其他科室访问时放行 TCP 3131 入站。详见 [DEPLOY.md](./DEPLOY.md)。

> git 仓库是**干净模板**：`data/*.db`、`uploads/`、`secrets/master.key`、`node_modules/`、
> `runtime/node.exe` 都不进版本库；发布的免安装部署包自带运行时与依赖，业务数据只在服务器上。

### 2. 日常改动的交付方式

- **任何代码改动一律走「按文件替换」的更新包**（自动备份 + 替换 + 回滚），不整目录重装。
- 清单只有 `static/**` = 纯前端，替换后 **Ctrl+F5** 即可，不重启；
  清单含 `server.js` / `src/**` / `scripts/**` = 含后端，**必须重启服务**。
- 出包后必跑更新 → 回滚（含删除本次新增文件）→ 再更新逐字节一致的三遍实测，再打 zip 交付。
- 禁区：`data/`、`secrets/master.key`、`config.js`、`uploads/`、`node_modules/`、`runtime/` 不随包替换。

### 3. 本地验证（改代码后）

`npm run check:views` 校验视图名能否被 Vue 解析（防白屏），Vue 模板离线编译 + 前端四件套
（组件名 / 外壳模板 / CSS 配套 / class 普查）+ 对应模块的 `scripts/*-selftest.js`，
必要时起真服务打 HTTP 冒烟，再做预览页无头断言。详见 [DEV.md](./DEV.md)。

## 八、备份与恢复

- 手动：双击 `backup.bat`（备份到 `backups/`，默认保留最近 30 份）；
  指定目录：`backup.bat <盘符:\目录> 30`。
- 定时：把 `node <部署根>\scripts\backup.js <备份目录> 30` 挂进任务计划程序（建议每天 22:00）。
- 备份内容 = **四库一致快照** + `uploads/`（合同/工单/文档附件） + `data/.secret` + `secrets/`。
  巡检报告 HTML 与 `uploads/docs/.converted` 是可再生产物，不进备份。

> ⚠️ `secrets/master.key` 是全部加密口令的唯一解密钥，走 Windows DPAPI LocalMachine，
> **换机器即失效且无法找回**。建议额外离线单独拷一份。

恢复：先停服务 → 解压备份，`contract.db` / `his.db` / `docs.db` / `inspect.db` 覆盖 `data\` 下同名文件，
`uploads\` 覆盖 `uploads\`，`secrets\` 覆盖 `secrets\`，`.secret` 放回 `data\` → 重启 →
到「设备台账」确认设备仍在、自检在线。换机器必须先在原服务器 `KeyVault.exe export`、新机器 `import`。

## 九、常见问题

| 现象 | 处理 |
| --- | --- |
| `start.bat` 提示 Node.js not found | 确认 `runtime\node.exe` 存在；否则安装 Node.js 22.5+ |
| 提示 `node:sqlite` 不可用 | Node 版本过低，升级或使用自带 runtime |
| 其他电脑打不开 | 检查 TCP 3131 入站规则与服务器 IP 可达性 |
| 改了前端没生效 | 静态资源有弱 ETag，让浏览器 Ctrl+F5 强刷 |
| 大屏扩展区 / 阈值规则空白或接口 404 | 刚应用过含后端的包时，需**重启服务 + Ctrl+F5**；指标目录为空时前端有静态兜底，仍空白说明静态文件没换 |
| 原生下拉框缩成只剩箭头的小空框 | 多半是目录接口返回空 items；确认已应用最新静态文件并重启服务 |
| exporter 卡片只剩内存一条 | 检查 windows_exporter 服务是否 Running、`/metrics` 是否可达、收集器是否启用 `[defaults],textfile`；采集侧已兼容多版本指标名 |
| 忘记 admin 密码 | **不要删 `contract.db`**（合同、账号、权限、IP 台账全在里面，删了全没）。从备份恢复，或在 DBA 协助下离线重置 admin 的口令哈希，系统没有自助重置入口 |
| 大屏所有设备「巡检失败」 | 先 `npm run check` 看主密钥可用性；FAIL 需在原服务器 export / import |
| 大屏提示「采集子进程未在运行」 | 已自动降级为主进程采集；看服务窗口的子进程报错，必要时重启 |
| 停用设备后大屏还有它 | 写操作会立即重载配置并剔除残留结果；仍出现请刷新页面 |
| 报告生成一直转圈 | 报告要重采一遍全部设备，正常耗时数分钟；超预算会自动终止并重启子进程 |

## 十、技术说明与维护约定

- 数据全部保存在本地 `data/` 与 `uploads/`，不外传，适合内网环境；四库自动 WAL，中文附件名自动修复。
- 合同与巡检共用 `contract.db` 的 `users` 表；`his.db` 里的 `users` / 空 `logs` 是历史遗留，
  不参与业务查询，**不等于数据丢失** —— 账号与操作日志都在 `contract.db`。
- 巡检采集跑在独立子进程（`src/inspection/worker.js`）：一轮可能几十秒到几分钟，
  隔离后即使采集崩溃也不影响登录、合同、工单；子进程被杀会自动重建，
  10 分钟内连续崩溃超过 5 次则停止自愈并明确告警。设 `INSPECTION_NO_WORKER=1` 可退回主进程。
- 设备台账应急开关：把 `it_inspect_settings.config_version` 置 0，或设 `INSPECTION_SOURCE=json` 回到旧 JSON 模式。
- 巡检间隔默认 60 秒（`INSPECTION_INTERVAL_SEC`），历史快照默认保留 90 天（`INSPECTION_HISTORY_DAYS`），
  操作日志保留 180 天（`LOG_KEEP_DAYS`）。
- **新增标准模块要改满 13 处**：业务层 / 路由 / `db.js`（仅加列）/ `perm.js` / `server.js` / 视图 /
  `main.js` 5 处 / `authz.js` / `index.html` / `style.css` / `check_main_template.js` 的 `VIEW_NAMES` /
  预览页 4 处 / e2e。漏任何一处都可能表现为「白屏 / 一直转圈 / 点了没反应」而不是报错。
- 前端无构建：`static/js/*.js` 里的 template 字符串既是源码也是产物；
  不用 `color-mix()` / CSS 嵌套 / `:has()` / 容器查询；表格 `table-layout: fixed` 且列宽之和 = `min-width`。
- 更多踩坑记录与项目约定见工作区 `.workbuddy/memory/` 下的三本手册及每日日志。

## 十一、文档索引

| 文档 | 用途 |
| --- | --- |
| `README.md` | 系统功能、架构、目录、部署与备份总览（本文件） |
| `DEPLOY.md` | 全新机器部署、密钥迁移、试运行验收、回滚 |
| `DEV.md` | 本机开发环境、分支与自测约定、模块分工 |
| `医院信息科日常管理系统-部署与使用手册.docx` | 面向使用者的图文手册 |
| `windows_exporter-textfile-自定义指标部署说明.md`（工作区） | 目标机 exporter / textfile 业务指标部署 |
| `hospital-it-*-2026*/更新说明.txt` | 每次更新包的改动清单、是否需重启、生效确认方式 |
