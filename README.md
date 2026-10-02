# NoteMarker

[English](./README.md) | [简体中文](./README.zh-CN.md)

Highlight, annotate, and clip any web page — with everything stored on your own machine. NoteMarker is a local-first Chrome extension paired with a Node.js backend: highlights, notes, and clipped pages land in a local knowledge base (`~/kb`) as Markdown + SQLite, never on someone else's server.

## Features

- Text highlighting & underlining with 5 customizable colors; per-page activation by clicking the toolbar icon
- Notes on any highlight; annotation list, reader, and settings in the side panel
- Clip pages to Markdown (smart main-content extraction, image localization, layered dedup)
- Reading list with unread / read / archived states; cross-page annotation history with search & export
- Local-first: no accounts, no telemetry, no cloud — the only network traffic goes to your own `127.0.0.1`
- English / 简体中文 UI following your browser language

## Quick start

Requirements: Node.js 18+ and Chrome.

```bash
git clone https://github.com/mechine/NoteMarker.git
cd NoteMarker
npm install
npm run build        # builds the server and the extension
npm run start:server # local backend at http://127.0.0.1:8765 (data in ~/kb)
```

Load the extension: open `chrome://extensions`, enable Developer mode, choose "Load unpacked", and pick `extension/dist`. Click the toolbar icon on any page to open the side panel and activate highlighting for that page.

## How it works

- `extension/` — Chrome extension (Manifest V3, Vite + @crxjs). Click-to-activate model: scripts are injected on demand via `activeTab`, with no broad host permissions
- `server/` — local backend (Express + TypeScript + `node:sqlite`), binds to `127.0.0.1:8765` (`PORT` to override)
- Data layout: base dir `~/kb` (`KB_HOME` to override; shared across projects), with all NoteMarker data under `~/kb/notemarker/` — `kb.db` (SQLite, WAL), `config.json`, and `content/` (`{pageId}.md|.anno.json|.html` plus `images/{hash}.*`; `.anno.json` is the annotation sidecar protocol file)

## HTTP API (core set)

| Method | Path | Purpose |
|---|---|---|
| GET | `/ping` | Health check (version / uptime / dbPath / outputDir) |
| GET / PUT | `/config` | Read / update runtime config |
| POST / GET | `/annotations` | Save annotations (idempotent by position) / query by page |
| PUT / DELETE | `/annotations/:id` | Update / delete an annotation |
| POST / GET | `/messages` | Store message snapshots (dedup by content) / query by page |
| POST | `/export` | Export a page (HTML → Markdown, layered dedup, md/json/html optional) |
| POST | `/export/preview` | Dry-run preview; writes nothing |
| POST / GET | `/images` | Upload images (sha256 dedup, local cache) / fetch by hash |

Errors use a uniform shape: `{ "ok": false, "error": "<code>", "message": "<details>" }`.

## Security

The backend binds to `127.0.0.1` only, and origin validation keeps arbitrary web pages from reading or writing your knowledge base cross-site:

- Requests carrying an `Origin` header must come from the paired extension (`chrome-extension://<id>`). The first extension origin seen is paired automatically (trust-on-first-use) and pinned to `trustedExtensionId` in `config.json`. If the extension ID changes (e.g. after publishing to the store), edit or clear that field and restart the server.
- Non-browser clients (curl / Node scripts) and address-bar visits are allowed; browser cross-site requests (`Sec-Fetch-Site: cross-site/same-site`) are rejected.
- The `Host` header must be `127.0.0.1:{PORT}` or `localhost:{PORT}` (DNS-rebinding protection).

## Internationalization

The extension UI follows the browser language: zh-CN browsers get Chinese, everything else falls back to English (`default_locale: "en"`). There is deliberately no in-app language switch, because manifest strings are resolved by the browser itself.

Adding a language means adding a `_locales/<locale>/messages.json` with the same key set; `npm run check:i18n -w extension` enforces consistency at build time.

## Development

```bash
npm run dev:server     # tsx watch
npm run dev:extension  # vite (run in a separate terminal)
```

The backend URL defaults to `http://127.0.0.1:8765` and can be changed in the side panel or the dashboard settings.

## License & Privacy

- Code: [AGPL-3.0](./LICENSE) (the author's own choice of license)
- Privacy: [PRIVACY.md](./PRIVACY.md) — nothing is collected; all data stays on your device
