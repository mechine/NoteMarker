# notemarker

Chrome 扩展 + 本地 Node.js 后端的知识库组合：在网页上做标注、缓存聊天页消息快照、导出为 Markdown 存档。数据库存"不可再生"的锚点/笔记/快照/映射，文件系统存"可再生"的正文与图片缓存。

## 结构

- `server/` — 本地后端（Express + TypeScript + `node:sqlite`），监听 `127.0.0.1:8765`（`PORT` 可覆盖）
- `extension/` — Chrome 扩展前端（Manifest V3，Vite + @crxjs/vite-plugin）
- 数据落点：知识库根目录默认 `~/kb`（环境变量 `KB_HOME` 覆盖），内含 `kb.db`（SQLite，WAL）、`config.json`、`content/`（`{pageId}.md|.json|.html` 与 `images/{hash}.*`）

## 接口一览（核心集）

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/ping` | 健康检查（version/uptime/dbPath/outputDir） |
| GET / PUT | `/config` | 读/改配置（dedupeWindow、maxCacheSize、autoExport*） |
| POST / GET | `/annotations` | 保存标注（位置去重幂等、needSnapshot）/ 按页查询 |
| PUT / DELETE | `/annotations/:id` | 改/删标注 |
| POST / GET | `/messages` | 存消息快照（同内容去重、变内容更新）/ 按页查询 |
| POST | `/export` | 导出页面（URL 规范化 → 内容 hash → 时间窗口 → 标注位置四层去重；HTML→Markdown；标注区块；md/json/html 可选） |
| POST | `/export/preview` | 干跑预览，不写文件不改库 |
| POST / GET | `/images` | 上传图片（sha256 去重、本地缓存）/ 按 hash 查询 |

统一错误格式：`{ "ok": false, "error": "<机器码>", "message": "<说明>" }`。管理类接口（`/pages`、`/search`、`/maintenance/*`、`/stats`）与鉴权留待后续变更。

## 使用

```bash
npm install          # 安装依赖（首次）
npm run build        # 构建 server 与 extension
npm run start:server # 启动本地后端（数据落在 ~/kb，或设 KB_HOME）
```

加载扩展：`chrome://extensions` → 开发者模式 → 「加载已解压的扩展程序」→ 选择 `extension/dist`。弹窗输入文字点确认即保存为 `content/{pageId}.md`（重复内容返回"已存在"）。

## 访问控制

服务端仅监听 `127.0.0.1`，并通过中间件校验请求来源，防止任意网页跨站读写本机知识库：

- 带 `Origin` 的请求必须是 `chrome-extension://<id>`，且与已配对扩展一致。首次见到扩展 Origin 时自动配对（TOFU），固化到 `config.json` 的 `trustedExtensionId`；换插件 ID（如开发模式重载、上架后 ID 变化）导致 403 `unregistered_extension` 时，编辑该字段（或删掉置 null）后重启服务即可重新配对。
- 无 `Origin` 的非浏览器客户端（curl/Node 脚本）与地址栏直达放行；`Sec-Fetch-Site: cross-site/same-site` 的浏览器请求拒绝。
- `Host` 头仅接受 `127.0.0.1:{PORT}` / `localhost:{PORT}`（防 DNS rebinding）。

## 国际化（扩展）

扩展界面语言跟随浏览器界面语言自动匹配：简体中文浏览器用 zh_CN，其余回落英文（`default_locale: "en"`）。**不提供应用内语言切换**（manifest 名称等由浏览器语言决定，切换器会造成割裂）。

- 语言文件：`extension/public/_locales/{en,zh_CN}/messages.json`（flat key，前缀按界面分：`options_`/`sidepanel_`/`menu_`/`hl_`），经 vite publicDir 复制到 `dist/_locales/`
- 静态文案：HTML 元素标 `data-i18n="key"`（属性用 `data-i18n-attr="attr:key"`），页面模块入口 `hydrate(document.body)` 注入
- 动态文案：TS 里 `t(key, substitutions?)`（缺失回落 default_locale，再缺显示 key 并 console.warn）
- 一致性校验：`npm run check:i18n -w extension`（en/zh_CN 键集合必须一致，差异非零退出）
- 新增语言：加 `_locales/<locale>/messages.json` 目录（键集合与现有一致），无需改代码；商店后台 listing 描述另行按语言手填

开发模式：`npm run dev:server`（tsx watch）、`npm run dev:extension`（vite，需另开终端）。后端基址常量在 `extension/src/backend.ts`。

## 设计文档

详见 `openspec/changes/`（OpenSpec 变更：add-save-note-flow → build-kb-backend）与 `stash/`（原始接口/数据模型设计）。

## 许可证

[AGPL-3.0](./LICENSE)（GNU Affero General Public License v3.0），项目作者自选以 AGPL-3.0 发布。
