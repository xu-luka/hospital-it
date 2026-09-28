# 部署手册

合并后的系统是**单进程单端口**（Express 3131），业务（合同 / 工单 / 账号）与巡检（大屏 / 台账 / 报告 / 历史）由同一进程提供。

---

## 0. 全新机器部署（初始版 · 任意电脑可装）⭐

本初始版是**干净模板**：空业务数据、只有一个 admin 账号、**不带主密钥**，因此整目录拷到任意一台 Windows 电脑都能跑。

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

1. 在「设备台账」里逐台录入设备与口令（口令会用**本机主密钥**加密保存）
2. 再录入合同 / 工单 / 技术文档等业务数据

### 为什么主密钥不随包分发

`secrets\master.key` 由 Windows **DPAPI(LocalMachine)** 封装，**只能被生成它的那台机器解开**。
把 A 机的 master.key 拷到 B 机，必然报：

```
ERR: 无法解密主密钥：DPAPI 上下文不匹配
```

所以本模板**故意不带** master.key：首次启动（`init.bat` 或 `start.bat`）时由 `secrets\KeyVault.exe generate` 在**本机现场生成**，日志会打印：

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

- **目录自包含**：`runtime\node.exe`（便携 Node 24）+ `node_modules` + `secrets\KeyVault.exe` + `wmitools\WmiQuery.exe` + `static\` + `data\*.db` 都在包里，原服务器**不需要联网、不需要装 Node、不需要 npm install**。
- **目录层级别乱改**：`src/inspection/paths.js` 用 `__dirname` 向上两级推导部署根，换到别的盘符可以，但**层级深度变了会算错路径**。上机后第一条命令就是 `npm run check`，它会当场报出根目录与缺失资产。
- **端口 3131**，内网 HTTP，不上 HTTPS。

## 1. 停机与备份（原服务器）

1. 停掉旧的机房巡检系统、日常管理系统的服务和计划任务（避免占端口 / 重复生成周报）。
2. 备份旧目录（尤其是 `config.json` 里的设备清单和 `secrets\`）。
3. 记录旧系统报告输出目录（如 `E:\report`），后面要对齐。

## 2. 拷贝

整目录拷到目标路径，建议沿用 **`D:\hospital-it`**。不要只拷部分文件：`static\vendor\vue.global.prod.js`、`wmitools\`、`secrets\` 缺一样就会有功能悄悄残废。

## 3. 密钥迁移（最关键一步，做错 26 条凭据全废）

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

> **务必离线备份一份 `secrets\master.key`**（U 盘 / 离线存储）。这个文件丢了，26 条设备凭据全部无法恢复，只能逐台重录。

## 4. 自检

```bat
cd /d D:\hospital-it
npm run check
```

`doctor.js` 会逐项输出 Node 运行时、依赖完整性、目录可写、业务库、巡检资产、设备台账、**前端视图注册**、主密钥可用性、报告目录、巡检历史库。
任一 `FAIL` 必须处理；`WARN` 是能力降级（如缺 WmiQuery → Windows 采集降级）。

## 5. 台账入库

配置已在开发机迁移进 `it_devices`，但**上机后建议再跑一次**，让数据与本机密钥对齐：

```bat
npm run migrate:config -- --dry-run    rem 核对 26 台，无误再执行下一步
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
| 登录 | admin 账号可登录，7 个账号齐全 |
| 监控大屏 | 深色大屏，26 台设备卡片带名称 / 地址 / 类型 / 连接方式，**状态为真实巡检结果**（不再是"口令解密失败"） |
| 设备台账 | 26 台，增删改查正常，停用后大屏立即移除 |
| 巡检报告 | 能生成报告并出现在列表里 |
| 业务模块 | 合同台账、问题工单正常 |

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

rem 备份（含 inspect.db 与 secrets\）
npm run backup
```

建议把 `npm run backup` 也挂进计划任务。

## 9. 两个必看的部署后校正

1. **报告目录**：配置里 `global.report_dir = E:\report`。**若原服务器没有 E 盘**，会自动回退到 `data\reports`。上机后到「设备台账 → 巡检设置」改成实际盘符。
2. **历史库 WAL**：`data\inspect.db` 可能留有未 checkpoint 的 `-wal` 文件。**拷贝前务必正常停掉服务**，别直接杀进程，否则历史快照会留在 WAL 里没落库。

## 10. 回滚

保留旧目录与旧启动方式不动。新系统出问题：停 3131 → 起旧服务。台账可用 `npm run migrate:config -- --rollback` 退回 JSON 配置模式。

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
- **改了前端没生效**：`static\` 有 etag 缓存，改完 JS 让浏览器硬刷新（Ctrl+F5）。
