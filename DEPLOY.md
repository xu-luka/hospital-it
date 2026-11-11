# 部署手册

合并后的系统是**单进程单端口**（Express 3131），业务（合同 / 工单 / 技术文档 / 资产与 IP / 上线管理 / 账号）
与巡检（大屏 / 设备台账 / 报告 / 历史 / 流量监控）由同一进程提供。系统功能与架构总览见 [README.md](./README.md)。

> **路径约定（先看这条）**：部署根 = **含 `server.js` 的那一层目录**，早期文档里的 `D:\hospital-it`
> 只是示例，当前生产实例是 `E:\hospital-it`。执行下面的命令前，把示例路径换成你自己的部署根。
> 另外 `src/inspection/paths.js` 用相对层级推导根目录，**换盘符可以，改变目录层级会算错路径**。
>
> 文档最近同步：2026-11-11（四库、17 个页面、按文件替换的日常更新方式）。

---

## 0. 全新机器部署（初始版 · 任意电脑可装）⭐

**git 仓库是干净模板**：空业务数据、只有一个 admin 账号、`data/*.db` / `uploads/` /
`secrets/master.key` / `node_modules/` / `runtime/` 都不入库，首次启动自动建四库并在本机生成主密钥，
因此整目录拷到任意一台 Windows 电脑都能跑。发布的免安装部署包与本机工作副本可能已经带着这些运行时文件，
它们只属于那一台机器，**不要跨机复用 `master.key`**。

三步走：

```bat
rem ① 整目录拷到目标机器（如 D:\hospital-it），不要只拷部分文件
rem ② 可选：先初始化主密钥（不跑也行，start.bat 启动时会自动生成）
init.bat

rem ③ 启动
start.bat
```

打开 `http://127.0.0.1:3131`，用 **admin** 登录，然后：

> **初始口令从哪来**：项目不再内置固定默认口令。首次启动时若未设置环境变量 `ADMIN_PASSWORD`，
> 程序会随机生成一个初始口令，并在启动窗口打印成：
>
> ```
> ============================================================
> [seed] 初始管理员 admin 已创建，随机初始口令：xxxxxxxxxxxx
> [seed] 请登录后立即修改密码；想指定初始口令请设置环境变量 ADMIN_PASSWORD。
> ============================================================
> ```
>
> 想固定初始口令，启动前执行 `set ADMIN_PASSWORD=你的口令`（或写进系统环境变量）即可。
> 口令只在首次建库时生效，之后由「修改密码」页管理。

> 初始版的巡检报告目录**留空**，即默认输出到 `data\reports`（跟随程序目录，换盘不失效）。
> 需要改到别的路径时，在页面「巡检设置」里填即可。

1. 在「设备台账」里逐台录入设备与口令（口令会用**本机主密钥**加密保存）；
   监控方式可选 SSH / WMI / windows_exporter / local，老系统优先 exporter
2. 再录入合同 / 工单 / 技术文档 / 网页书签 / IP 网段 / 终端资产 / 上线档案等业务数据

### 为什么主密钥不随包分发

`secrets\master.key` 由 Windows **DPAPI(LocalMachine)** 封装，**只能被生成它的那台机器解开**。
把 A 机的 master.key 拷到 B 机，必然报：

```
ERR: 无法解密主密钥：DPAPI 上下文不匹配
```

所以仓库里**故意不带** master.key：首次启动（`init.bat` 或 `start.bat`）时由 `secrets\KeyVault.exe generate` 在**本机现场生成**，日志会打印：

```
>>> 已为本机生成主密钥：...\secrets\master.key
>>> 主密钥就绪（指纹 xxxxxxxxxxxxxxxx）
```

### 换机器 / 重装系统怎么办

- **新机器重新部署**：照本文第 0 节再来一遍，设备口令需要在页面上重新录入。
- **想保住已有口令**：必须先在**原机器**导出迁移包，再在新机器导入（见第 3 节），
  直接拷 `master.key` 文件是无效的。
- **务必离线备份** `secrets\master.key`（U 盘）。丢了它，这台机器上已保存的设备口令无法恢复，
  只能逐台重录。

---

## 0.1 上线前须知

- **目录自包含**：`runtime\node.exe`（便携 Node 24）+ `node_modules` + `secrets\KeyVault.exe` + `wmitools\WmiQuery.exe` + `static\` 都在发布包里；四个 `data\*.db` 由首次启动自动建（已部署的实例则随包带着本机数据）。原服务器**不需要联网、不需要装 Node、不需要 npm install**。
- **目录层级别乱改**：`src/inspection/paths.js` 用 `__dirname` 向上两级推导部署根，换到别的盘符可以，但**层级深度变了会算错路径**。上机后第一条命令就是 `npm run check`，它会当场报出根目录与缺失资产。
- **端口 3131**，内网 HTTP，不上 HTTPS。

## 1. 停机与备份（原服务器）

1. 停掉旧的机房巡检系统、日常管理系统的服务和计划任务（避免占端口 / 重复生成周报）。
2. 备份旧目录（尤其是 `config.json` 里的设备清单和 `secrets\`）。
3. 记录旧系统报告输出目录（如 `E:\report`），后面要对齐。

## 2. 拷贝

整目录拷到目标路径，**沿用现有部署根**（当前生产实例 `E:\hospital-it`；下面命令示例里的 `D:\hospital-it` 请按实际替换）。不要只拷部分文件：`static\vendor\vue.global.prod.js`、`wmitools\`、`secrets\` 缺一样就会有功能悄悄残废。

## 3. 密钥迁移（最关键一步，做错全部设备凭据作废）

`secrets\master.key` 用 **DPAPI LocalMachine** 作用域加密，**不能跨机器使用**。直接把开发机的 master.key 拷过去，会报：

```
ERR: 无法解密主密钥：DPAPI 上下文不匹配。常见原因是该密钥文件来自另一台机器
```

正确做法：

```bat
rem ① 在原服务器（旧系统所在的那台机器）上导出迁移包
cd /d D:\hospital-it\secrets
KeyVault.exe export

rem ② 把生成的迁移包拷到新部署目录的 secrets\ 下
rem ③ 在新部署目录导入
cd /d D:\hospital-it\secrets
KeyVault.exe import
```

> **务必离线备份一份 `secrets\master.key`**（U 盘 / 离线存储）。这个文件丢了，已保存的设备凭据与书签口令
> 全部无法恢复，只能逐台重录。

## 4. 自检

```bat
cd /d D:\hospital-it
npm run check
```

`doctor.js` 会逐项输出 Node 运行时、依赖完整性、目录可写、**四个业务库**、巡检资产、设备台账、
**前端视图注册**、主密钥可用性、报告目录、巡检历史库。
任一 `FAIL` 必须处理；`WARN` 是能力降级（如缺 WmiQuery → Windows 采集降级）。

## 5. 台账入库

若沿用旧巡检系统的 `config.json`（配置已在开发机迁进 `it_devices`），**上机后建议再跑一次**，
让数据与本机密钥对齐；全新干净部署没有旧配置，直接在「设备台账」页录入即可：

```bat
npm run migrate:config -- --dry-run    rem 先核对设备条数，无误再执行下一步
npm run migrate:config -- --force      rem 幂等，可重复执行
npm run migrate:config -- --rollback   rem 出问题回退到 JSON 配置
```

## 6. 试运行

```bat
start.bat
```

用浏览器（内网）打开 `http://<服务器IP>:3131`，逐项验收：

| 验收项 | 预期 |
|---|---|
| 登录 | `admin` 可登录（全新部署**只有这一个账号**，其余账号在「用户管理」按需新建） |
| 监控大屏 | 设备卡片带名称 / 地址 / 类型 / 监控方式，**状态为真实巡检结果**（不再是"口令解密失败"）；扩展监控与告警区、流量视图能出数据 |
| 设备台账 | 条数与本院台账一致，增删改查 / 自检 / 通道对比正常，停用后大屏立即移除 |
| 巡检报告 | 能生成报告并出现在列表里，可预览 / 打印 PDF / 下载 |
| 业务模块 | 合同、工单、技术文档、网页书签、IP 管理、终端资产、上线管理、流量监控逐项可打开且有数据 |
| 权限 | 「角色权限」页能按模块×动作勾选；新建角色登录后菜单随权限变化 |

首次启动后约 60 秒出第一轮结果。

## 7. 周报计划任务（需管理员权限）

```bat
npm run register-weekly                 rem 默认每周一 07:30
npm run register-weekly -- --time 08:00 --day SAT
npm run register-weekly -- --dry-run    rem 只看将要执行的 schtasks 命令
npm run register-weekly -- --remove     rem 删除任务
```

任务名：`医院信息科-每周巡检报告`。手动验证一次：`runtime\node.exe scripts\weekly-cli.js`。

## 8. 防火墙与备份

```bat
rem 内网放行 3131（管理员）
netsh advfirewall firewall add rule name="HospitalIT-3131" dir=in action=allow protocol=TCP localport=3131

rem 备份（四库一致快照 + 附件 + .secret + secrets\）
npm run backup
```

建议把 `npm run backup` 也挂进计划任务。

## 9. 两个必看的部署后校正

1. **报告目录**：在「设备台账 → 巡检设置」里填；**留空即默认 `data\reports`**（跟随程序目录，换盘不失效）。
   若沿用旧配置指向了不存在的盘符，会自动回退到 `data\reports`，上机后改成实际盘符即可。
2. **历史库 WAL**：`data\inspect.db` 可能留有未 checkpoint 的 `-wal` 文件。**拷贝前务必正常停掉服务**，别直接杀进程，否则历史快照会留在 WAL 里没落库。

## 10. 回滚

保留旧目录与旧启动方式不动。新系统出问题：停 3131 → 起旧服务。台账可用 `npm run migrate:config -- --rollback` 退回 JSON 配置模式。

## 11. 日常更新（不要整目录重装）

正式环境的所有代码改动都走「按文件替换」的更新包，包里是 `files\` + `应用更新.bat` + `回滚.bat` + `更新说明.txt`：

1. **看 `更新说明.txt` 的清单**：只有 `static/**` = 纯前端；出现 `server.js` / `src/**` / `scripts/**` = **含后端，必须重启服务**。
2. 把包里 `files\` 下的文件按原路径拷到部署根，双击 `应用更新.bat`（自动备份被替换的文件后再替换）；
   出问题双击同目录的 `回滚.bat`（会删掉本次新增的文件，恢复原状）。
3. **怎么确认生效了**：含后端的包先停服务再启动，看启动窗口无 `装载失败` 字样；
   前端一律让浏览器 **Ctrl+F5**；然后打开本次改动涉及的页面，对照 `更新说明.txt` 里的验收点逐项点一遍
   （例如大屏扩展区有数据、新按钮能点、下拉不再空白）。只看「文件拷进去了」不算生效。
4. 替换禁区：`data/`、`secrets/master.key`、`config.js`、`uploads/`、`node_modules/`、`runtime/` 一律不动。
   更新包在交付前已跑过「更新 → 回滚 → 再更新」三遍实测与逐字节比对。

> 巡检模块是整段 `mountInspection()` try/catch 装载的，某个路由文件没同步替换全，
> 表现为「巡检 + 流量监控整组下线」而不是启动报错；看到整组菜单/接口没了，先查包里的文件是否都落到位。

## 附：常用命令

| 命令 | 作用 |
|---|---|
| `npm run check` | 部署自检 |
| `npm run check:views` | 校验前端视图名能否被 Vue 正确解析（防白屏） |
| `npm run migrate:config` | 配置迁入 / 迁出设备台账 |
| `npm run backup` | 备份数据 |
| `npm run inspect` | 命令行跑一次巡检 |
| `npm run weekly` | 命令行生成周报 |
| `npm run register-weekly` | 注册周报计划任务 |

## 附：已知坑（都是踩过的）

- **大屏白屏**：组件名必须能与注册名对应。`bigscreen-view` 永远解析不到 `BigScreenView`（`bigscreen` 中间没连字符，camelize 只能得到 `BigscreenView`）。正确写法是 `big-screen-view`。`npm run check:views` 会拦截这类问题。
- **主密钥跨机失效**：见第 3 节，必须 export / import，不能直接拷文件。
- **改了前端没生效**：`static\` 由 Express 直出，带弱 ETag，改完 JS 让浏览器硬刷新（Ctrl+F5）。
- **含后端的更新包没重启**：大屏扩展区空白、指标下拉空白、新接口 404 —— 先重启服务再 Ctrl+F5，别去查配色和权限。
- **原生下拉缩成只剩箭头的小空框**：目录类接口返回空 items 时，原生 `<select>` 没有内容撑宽度；
  当前版本已有静态兜底，仍出现说明静态文件没换或服务没重启。
- **exporter 卡片只剩一条内存**：先确认 windows_exporter 服务 Running、`/metrics` 可达、
  收集器用 `[defaults],textfile`；采集侧已兼容 0.23.1 / 0.29 / 0.30 / 0.32 的多轮指标改名。
- **备份少拷一个库**：共四个 `data\*.db`，漏 `docs.db` 会丢文档索引与正文，漏 `inspect.db` 会丢历史趋势、
  流量时序与告警事件；`scripts/backup.js` 已经四个都打进 zip，别手工只拷三个。
