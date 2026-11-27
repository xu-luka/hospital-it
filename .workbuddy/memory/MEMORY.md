# hospital-it 项目长期约定

## 资产库 / 项目资料库上传
- 上传项目内容前，一律先按项目 .gitignore 过滤，取清单用 `git -c core.quotepath=false ls-files --cached --others --exclude-standard`。
- 绝不上传：secrets/master.key 及 *.key（DPAPI 绑定本机）、data/*.db*（含业务数据）、node_modules、runtime/node.exe、logs、uploads 附件、备份产物。
- 项目资产库根目录 dir_id: EanfgjxzXgXJ；已建项目目录「医院信息科日常管理系统」dir_id: EePkHCtactDb。
- 项目资料库属于写入操作，上传前必须向用户确认「范围」与「存放位置」。
- 大批量源码优先打包为保留目录结构的 ZIP + 单独上传关键交付文档，而不是逐文件平铺。

## 发布流程
修改代码 → 本地验证（Vue 模板编译 / 预览页）→ 推送 GitHub → 生成服务器更新包。
