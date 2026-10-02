# NoteMarker

[English](./README.md) | [简体中文](./README.zh-CN.md)

在任意网页上划线、批注、收藏——所有数据只存在你自己的电脑上。NoteMarker 是"本地优先"的 Chrome 扩展 + Node.js 后端组合：高亮、批注与收藏的页面落入本机知识库（`~/kb`），以 Markdown + SQLite 保存，绝不上别人的服务器。

## 功能

- 划线高亮与下划线，5 个可自定义颜色；点击工具栏图标按页激活
- 任意高亮可加批注；侧栏内管理标注列表、阅读预览与设置
- 网页剪藏为 Markdown（智能正文提取、图片本地化、多层去重）
- 阅读列表支持 未读/已读/已归档；跨页标注历史可搜索、可导出
- 本地优先：无账号、无遥测、无云端——唯一的网络请求发往你自己的 `127.0.0.1`
- 界面语言跟随浏览器：English / 简体中文

## 快速开始

要求：Node.js 18+ 与 Chrome。

```bash
git clone https://github.com/mechine/NoteMarker.git
cd NoteMarker
npm install
npm run build        # 构建 server 与 extension
npm run start:server # 启动本地后端 http://127.0.0.1:8765（数据落在 ~/kb）
```

加载扩展：打开 `chrome://extensions` → 开启开发者模式 → 「加载已解压的扩展程序」→ 选择 `extension/dist`。在任意网页点击工具栏图标即可打开侧栏并激活本页划线。

## 工作原理

- `extension/` — Chrome 扩展（Manifest V3，Vite + @crxjs）。点击激活模型：脚本经 `activeTab` 按需注入，无宽泛 host 权限
- `server/` — 本地后端（Express + TypeScript + `node:sqlite`），仅监听 `127.0.0.1:8765`（`PORT` 可覆盖）
- 数据落点：基础目录默认 `~/kb`（环境变量 `KB_HOME` 覆盖，多项目共享），本项目数据全部在其子目录 `~/kb/notemarker/` 下——`kb.db`（SQLite，WAL）、`config.json`、`content/`（`{pageId}.md|.anno.json|.html` 与 `images/{hash}.*`；`.anno.json` 为注解侧车协议文件）

## HTTP 接口（核心集）

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/ping` | 健康检查（version / uptime / dbPath / outputDir） |
| GET / PUT | `/config` | 读 / 改运行配置 |
| POST / GET | `/annotations` | 保存标注（按位置幂等去重）/ 按页查询 |
| PUT / DELETE | `/annotations/:id` | 改 / 删标注 |
| POST / GET | `/messages` | 存消息快照（同内容去重）/ 按页查询 |
| POST | `/export` | 导出页面（HTML→Markdown、多层去重、md/json/html 可选） |
| POST | `/export/preview` | 干跑预览，不写文件不改库 |
| POST / GET | `/images` | 上传图片（sha256 去重、本地缓存）/ 按 hash 查询 |

统一错误格式：`{ "ok": false, "error": "<机器码>", "message": "<说明>" }`。

## 安全

后端仅监听 `127.0.0.1`，并通过来源校验防止任意网页跨站读写你的知识库：

- 带 `Origin` 的请求必须来自已配对的扩展（`chrome-extension://<id>`）。首次见到的扩展 Origin 自动配对（TOFU），固化到 `config.json` 的 `trustedExtensionId`；扩展 ID 变化（如上架商店后）导致 403 `unregistered_extension` 时，编辑或清空该字段并重启服务即可重新配对。
- 无 `Origin` 的非浏览器客户端（curl / Node 脚本）与地址栏直达放行；`Sec-Fetch-Site: cross-site/same-site` 的浏览器请求拒绝。
- `Host` 头仅接受 `127.0.0.1:{PORT}` / `localhost:{PORT}`（防 DNS rebinding）。

## 国际化

扩展界面语言跟随浏览器：zh-CN 浏览器显示中文，其余回落英文（`default_locale: "en"`）。刻意不做应用内语言切换——manifest 字符串由浏览器按自身语言解析，切换器会造成割裂。

新增语言只需添加键集合一致的 `_locales/<locale>/messages.json`；`npm run check:i18n -w extension` 在构建期校验两份语言文件键一致。

## 开发

```bash
npm run dev:server     # tsx watch
npm run dev:extension  # vite（另开终端）
```

后端地址默认 `http://127.0.0.1:8765`，可在侧栏设置区或管理页修改。

## 许可与隐私

- 代码：[AGPL-3.0](./LICENSE)（作者自选协议）
- 隐私：[PRIVACY.md](./PRIVACY.md) —— 不收集任何数据，全部数据只在本机
