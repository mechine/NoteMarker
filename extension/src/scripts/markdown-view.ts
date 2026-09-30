// Markdown 阅读渲染（specs sidebar-settings-reader 阅读预览）：
// 侧栏与管理页共用的渲染助手与最小排版样式。仅被扩展页（sidepanel/options）引用，
// 不进入 content script 与 background，避免增大常驻注入体积（design D6）。
import { marked } from 'marked'
import { t } from './i18n'

/** 超长正文截断阈值（1MB），避免巨型剪藏把面板渲染卡死 */
const MAX_MARKDOWN = 1024 * 1024

export const READER_CSS = `
.reader-body { line-height: 1.7; font-size: 13px; word-break: break-word; }
.reader-body h1, .reader-body h2, .reader-body h3 { margin: 1.1em 0 .5em; line-height: 1.3; }
.reader-body h1 { font-size: 17px; } .reader-body h2 { font-size: 15px; } .reader-body h3 { font-size: 14px; }
.reader-body p { margin: .6em 0; }
.reader-body a { color: #2f81f7; }
.reader-body blockquote { margin: .6em 0; padding: 2px 10px; border-left: 3px solid #f5c518; color: #898989; background: rgba(245,197,24,.08); }
.reader-body pre { background: rgba(127,127,127,.12); padding: 8px 10px; border-radius: 4px; overflow: auto; font-size: 12px; }
.reader-body code { font-family: Consolas, monospace; font-size: 12px; background: rgba(127,127,127,.15); padding: 1px 4px; border-radius: 3px; }
.reader-body pre code { background: transparent; padding: 0; }
.reader-body img { max-width: 100%; }
.reader-body table { border-collapse: collapse; }
.reader-body td, .reader-body th { border: 1px solid #bbb; padding: 3px 8px; }
.reader-body hr { border: none; border-top: 1px solid #ccc; margin: 1em 0; }
`

/** 把 Markdown 渲染进容器（超 1MB 截断并标注）。内容来自用户本地库，信任模型见 design D5。
 * imgBase：把剪藏里的本地相对图片（images/{hash}.{ext}）改写为后端读取路由的绝对 URL，预览才能显示。 */
export function renderMarkdown(container: HTMLElement, markdown: string, imgBase?: string): void {
  const md =
    markdown.length > MAX_MARKDOWN
      ? `${markdown.slice(0, MAX_MARKDOWN)}\n\n> ${t('common_truncated')}`
      : markdown
  container.innerHTML = marked.parse(md, { async: false }) as string
  if (imgBase) {
    container.querySelectorAll('img').forEach((img) => {
      const src = img.getAttribute('src') ?? ''
      if (src.startsWith('images/')) {
        img.setAttribute('src', `${imgBase.replace(/\/+$/, '')}/images/${src.slice('images/'.length)}`)
      }
    })
  }
}
