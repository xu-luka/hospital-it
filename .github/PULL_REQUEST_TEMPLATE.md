<!--
  PR 模板 —— 提交前请把下面填掉。不必长，但每一条都帮 reviewer 快速判断。
  模板放在 .github/PULL_REQUEST_TEMPLATE.md，GitHub 提 PR 时会自动带出来。
-->

## 改了什么

<!-- 一两句话说清这个 PR 干了啥、对应哪个 issue（#123） -->

## 改了哪个模块

<!-- 勾选你动过的，方便按模块找人 review -->

- [ ] 合同台账（contract-views / src/routes/contracts）
- [ ] 问题工单（app.js IssuesView / src/routes/issues）
- [ ] 机房巡检（inspect-views / src/inspection）
- [ ] 技术文档（docs-views / src/routes/docs）
- [ ] 网页书签（bookmark-view / src/bookmarks）
- [ ] IP 管理（ipam-view / src/ipam）
- [ ] 流量监控（netflow-view / src/netflow）
- [ ] 角色权限（perm-view / src/perm）
- [ ] 外壳/通用（main.js / api.js / style.css / tokens.css）
- [ ] 其他：______

## 是否含后端

<!-- ★ 关键：含 server.js / src/** / scripts/** 的改动 = 部署时必须重启服务；
     只动 static/** = 纯前端，Ctrl+F5 即生效。-->

- [ ] 纯前端（只动 `static/**`）—— 部署时 Ctrl+F5 即可
- [ ] 含后端（动了 `server.js` / `src/**` / `scripts/**`）—— 部署时**必须重启服务**

## 怎么测的

<!-- 把跑过的校验勾上；前端四件套 + 对应 selftest 是硬性要求 -->

- [ ] `check-vue-templates.js`（改了任何 view 的 template 字符串就必跑）
- [ ] `check_css.py` / `survey_classes.py`（改了 CSS 或模板 class）
- [ ] `check_components.js` / `check_main_template.js`
- [ ] 对应模块的 selftest（`scripts/*-selftest.js`）
- [ ] 起真服务手动点过相关页面（控制台 0 报错）
- [ ] 不需要测试（文档/注释类改动）

## 部署影响

<!-- 如果改了部署相关的东西（config.js、端口、备份脚本、密钥），写一句 -->
<!-- 否则留空或写「无」 -->

---

★ 如果本 PR 会产出**更新包**（技能 `hospital-it-frontend-update-pkg`），
请在合并后跑 `test_update_pkg.py` 实测「更新 → 回滚 → 再更新」逐字节一致，再交给运维。
