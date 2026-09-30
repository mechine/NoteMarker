# NoteMarker 隐私政策 / Privacy Policy

生效日期 / Effective date: 2026-10-01

## 中文

NoteMarker 是本地优先（local-first）的网页标注与收藏工具。本政策说明数据的去向。

### 数据存储在哪里

全部数据仅保存在你自己的电脑上：

- **扩展数据**（标注缓存、设置）：浏览器 `chrome.storage.local`
- **知识库**（标注、批注、收藏的页面正文与图片）：本机 notemarker 后端写入 `~/kb` 目录（SQLite + 文件），后端仅监听 `127.0.0.1`，并校验请求来源，网页无法跨站读写

### 我们收集什么

**不收集任何数据。** 没有账号系统、没有遥测、没有统计上报、没有广告、没有第三方 SDK。扩展唯一的网络请求是发往你自己机器上的本地后端（默认 `http://127.0.0.1:8765`）。数据不会离开你的设备。

### 权限用途

| 权限 | 用途 |
|---|---|
| `activeTab` / `scripting` | 你点击图标激活时，才向当前页面注入划线/剪藏脚本（无常驻注入、无全站权限） |
| `storage` | 在本机保存标注与设置 |
| `contextMenus` / `sidePanel` | 提供右键菜单与侧栏入口 |
| 访问 `127.0.0.1:8765` | 与你本机运行的 notemarker 后端通信 |

扩展会读取你激活页面的正文内容（用于划线定位与收藏导出），内容只发送到本机后端，不做任何其他处理。

### 如何删除数据

卸载扩展（同时清除 `chrome.storage.local`），并删除 `~/kb` 目录，即可彻底删除全部数据。

### 联系方式

问题反馈：[GitHub Issues](https://github.com/mechine/NoteMarker/issues)

---

## English

NoteMarker is a local-first web annotation and clipping tool. This policy explains where your data goes.

### Where data is stored

All data stays on your own computer:

- **Extension data** (annotation cache, settings): browser `chrome.storage.local`
- **Knowledge base** (annotations, notes, clipped page content and images): written by the local notemarker backend into the `~/kb` directory (SQLite + files). The backend binds to `127.0.0.1` only and validates request origins, so websites cannot read or write it cross-site

### What we collect

**Nothing.** There are no accounts, no telemetry, no analytics, no ads, and no third-party SDKs. The extension's only network requests go to the backend running on your own machine (default `http://127.0.0.1:8765`). Your data never leaves your device.

### What permissions are used for

| Permission | Purpose |
|---|---|
| `activeTab` / `scripting` | Inject the highlighting/clipping script into the current page only when you click the toolbar icon to activate (no always-on injection, no all-sites host permission) |
| `storage` | Store annotations and settings locally |
| `contextMenus` / `sidePanel` | Context menu and side panel entry points |
| Access to `127.0.0.1:8765` | Communicate with the notemarker backend running on your machine |

The extension reads the content of pages you activate (for highlight anchoring and clipping). That content is sent only to your local backend and used for nothing else.

### How to delete your data

Uninstall the extension (this clears `chrome.storage.local`) and delete the `~/kb` directory. That removes all data completely.

### Contact

Issues: [GitHub Issues](https://github.com/mechine/NoteMarker/issues)
