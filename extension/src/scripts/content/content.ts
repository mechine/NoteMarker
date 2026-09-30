// 剪藏采集引擎（specs/clip-content）：background 经 executeScript 按需注入的自包含经典脚本。
// 分层采集（站点规则 → 选区 → Readability → 选择器 → 整页）+ 图片本地化 + 注入探测应答（ping）。
// @mozilla/readability 由 rollup 打平内联进本产物（无运行时 import）。
// toast 反馈已移除（specs remove-clip-toast）：收藏成败反馈由侧栏承担。
import { Readability } from '@mozilla/readability'

// ---------- 页面采集（specs/clip-content） ----------

const CLIP_RULES_KEY = 'clipRegionRules'
const MIN_BODY_TEXT = 200

const textWeight = (s: string): number => s.replace(/\s+/g, '').length

function getClipRuleFor(origin: string): Promise<string> {
  return new Promise((resolve) => {
    chrome.storage.local.get(CLIP_RULES_KEY, (r) => {
      const rules = r?.[CLIP_RULES_KEY]
      resolve(rules && typeof rules === 'object' ? String(rules[origin] ?? '') : '')
    })
  })
}

/** 可编辑判定（与 highlighter 同规则；本文件自包含故独立实现）：contenteditable="false" 为只读声明不算 */
function inEditableArea(el: Element | null): boolean {
  if (!el) return false
  if (el.closest('input, textarea, select')) return true
  const ce = el.closest('[contenteditable]')
  if (ce) return (ce.getAttribute('contenteditable') ?? '').trim().toLowerCase() !== 'false'
  return !!el.closest('[role="textbox"]')
}

interface CollectedContent {
  html: string
  title: string
  mode: 'rule' | 'selection' | 'smart' | 'selector' | 'full'
  textLen: number
  images: Array<{ src: string; w: number; h: number }>
}

/** 最近一次采集的 HTML（localizeImages 在其上做图片引用改写） */
let lastCollectedHTML = ''

const IMG_MIN_CLIP = 32

function attrInt(el: Element, name: string): number {
  const v = parseInt(el.getAttribute(name) ?? '', 10)
  return Number.isFinite(v) ? v : 0
}

/** 解析图片真实地址：src/currentSrc → data-src → data-original → srcset 首项，绝对化 */
function resolveImgSrc(img: Element | null): string {
  if (!img) return ''
  const el = img as HTMLImageElement
  const abs = (raw: string | null | undefined): string => {
    if (!raw) return ''
    try {
      return new URL(raw, document.baseURI).href
    } catch {
      return raw
    }
  }
  const raw = el.currentSrc || el.getAttribute('src')
  if (raw && raw.startsWith('data:')) return raw
  if (raw && !raw.trim().startsWith('#')) {
    const a = abs(raw)
    if (a) return a
  }
  const lazy = abs(el.getAttribute('data-src') || el.getAttribute('data-original'))
  if (lazy) return lazy
  const srcset = el.getAttribute('srcset')
  if (srcset) {
    const first = srcset.split(',')[0]?.trim().split(/\s+/)[0]
    const a = abs(first)
    if (a) return a
  }
  return raw ?? ''
}

/**
 * 规范化容器内图片（懒加载属性落位为真实 src）并产出可本地化清单（specs/clip-content 图片本地化）。
 * live 提供渲染尺寸（naturalWidth）；清单过滤 data: 与已知尺寸 <32px 的图。
 */
function normalizeImages(
  container: Element,
  live: Element | null,
): { clone: Element; images: Array<{ src: string; w: number; h: number }> } {
  const clone = container.cloneNode(true) as Element
  const cloneImgs = Array.from(clone.querySelectorAll('img'))
  const liveImgs = live ? Array.from(live.querySelectorAll('img')) : []
  const images: Array<{ src: string; w: number; h: number }> = []
  const seen = new Set<string>()
  cloneImgs.forEach((cImg, i) => {
    const orig = liveImgs[i] ?? cImg
    const realSrc = resolveImgSrc(orig)
    if (!realSrc) return
    cImg.setAttribute('src', realSrc)
    cImg.removeAttribute('data-src')
    cImg.removeAttribute('data-original')
    cImg.removeAttribute('srcset')
    if (realSrc.startsWith('data:')) return // 已内联，无需本地化
    if (seen.has(realSrc)) return
    seen.add(realSrc)
    const w = orig ? (orig as HTMLImageElement).naturalWidth || (orig as HTMLImageElement).width || attrInt(orig, 'width') : attrInt(cImg, 'width')
    const h = orig ? (orig as HTMLImageElement).naturalHeight || (orig as HTMLImageElement).height || attrInt(orig, 'height') : attrInt(cImg, 'height')
    if ((w && w < IMG_MIN_CLIP) || (h && h < IMG_MIN_CLIP)) return
    images.push({ src: realSrc, w, h })
  })
  return { clone, images }
}

function htmlTextWeight(html: string): number {
  const div = document.createElement('div')
  div.innerHTML = html
  return textWeight(div.textContent || '')
}

/**
 * 分层采集（specs/clip-content 正文分层提取）：站点规则 → 选区 → Readability → 选择器 → 整页。
 * mode='full' 跳过各层直接整页（预览"改用整页"）；每层有效文本 < 200 字符回退下一层。
 */
const collectPageContent = async (mode?: string): Promise<CollectedContent> => {
  const title0 = document.title

  // 各层产出"容器元素 + 参照原容器"，最后统一走图片规范化（懒加载落位 + 清单）
  let container: Element | null = null
  let live: Element | null = null
  let modeOut: CollectedContent['mode'] = 'full'
  let titleOut = title0
  let textLen = 0

  if (mode !== 'full') {
    // 1 站点规则
    const rule = await getClipRuleFor(document.location.origin)
    if (rule.trim()) {
      try {
        const best = Array.from(document.querySelectorAll(rule))
          .map((el) => ({ el, len: textWeight(el.textContent || '') }))
          .sort((a, b) => b.len - a.len)[0]
        if (best && best.len >= MIN_BODY_TEXT) {
          container = best.el
          live = best.el
          modeOut = 'rule'
          textLen = best.len
        }
      } catch {
        // 非法选择器：回退自动策略
      }
    }

    // 2 选区
    if (!container) {
      const sel = window.getSelection()
      if (sel && !sel.isCollapsed && sel.rangeCount > 0 && sel.toString().trim().length >= 20) {
        const anchorEl =
          sel.anchorNode && sel.anchorNode.nodeType === Node.TEXT_NODE
            ? sel.anchorNode.parentElement
            : (sel.anchorNode as Element | null)
        if (!inEditableArea(anchorEl)) {
          const wrap = document.createElement('div')
          wrap.appendChild(sel.getRangeAt(0).cloneContents())
          container = wrap
          live = null
          modeOut = 'selection'
          textLen = htmlTextWeight(wrap.innerHTML)
        }
      }
    }

    // 3 Readability（在文档克隆上执行，不污染原页面与已渲染高亮）
    if (!container) {
      try {
        const clone = document.cloneNode(true) as Document
        const article = new Readability(clone).parse()
        if (article?.content && textWeight(article.textContent ?? '') >= MIN_BODY_TEXT) {
          const div = document.createElement('div')
          div.innerHTML = article.content
          container = div
          live = null
          modeOut = 'smart'
          titleOut = article.title || title0
          textLen = textWeight(article.textContent ?? '')
        }
      } catch {
        // 回退下一层
      }
    }

    // 4 常见正文容器
    if (!container) {
      const CANDIDATES = [
        'main',
        'article',
        '[role="main"]',
        '#content',
        '[class*="content"]',
        '.tiptap',
        '.ProseMirror',
        '.markdown-body',
      ]
      let best: { el: Element; len: number } | null = null
      for (const s of CANDIDATES) {
        try {
          for (const el of Array.from(document.querySelectorAll(s))) {
            const len = textWeight(el.textContent || '')
            if (!best || len > best.len) best = { el, len }
          }
        } catch {
          // ignore
        }
      }
      if (best && best.len >= MIN_BODY_TEXT) {
        container = best.el
        live = best.el
        modeOut = 'selector'
        textLen = best.len
      }
    }
  }

  if (!container) {
    // 5 整页（兜底，永不失败）
    container = document.documentElement
    live = document.documentElement
    modeOut = 'full'
    textLen = htmlTextWeight(document.documentElement.outerHTML)
  }

  // 图片规范化：克隆上把懒加载真实地址落位为 src（导出 Markdown 不再出现占位图），并产出本地化清单
  const { clone, images } = normalizeImages(container, live)
  const html = clone.outerHTML
  lastCollectedHTML = html
  return { html, title: titleOut, mode: modeOut, textLen, images }
}

/** 旧直连路径（无 Side Panel 的老 Chrome 图标点击）：采集即送 background 导出；反馈面在侧栏，此路径静默 */
const saveAndExport = async () => {
  const collected = await collectPageContent()
  try {
    await chrome.runtime.sendMessage({
      action: 'saveCollected',
      title: collected.title,
      url: document.location.href,
      html: collected.html,
    })
  } catch (err) {
    console.warn('[notemarker] send collected content failed:', err)
  }
}

// 预览流程采集请求（specs/clip-content 剪藏预览）与直连保存触发（与 highlighter 的 notemarker 字段命名空间区分）
chrome.runtime.onMessage.addListener((request: any, _sender, sendResponse) => {
  if (request && request.notemarkerClip === 'collect') {
    ;(async () => {
      try {
        const collected = await collectPageContent(request.mode)
        sendResponse({
          ok: true,
          title: collected.title,
          html: collected.html,
          mode: collected.mode,
          textLen: collected.textLen,
          images: collected.images,
          url: document.location.href,
        })
      } catch (err) {
        sendResponse({ ok: false, error: String(err) })
      }
    })()
    return true
  }
  if (request && request.notemarkerClip === 'save') {
    // 直连保存触发（background clipTab）：fire-and-forget，结果不回传
    void saveAndExport()
    sendResponse({ ok: true })
  }
})

// 图片本地化（specs/clip-content 图片本地化两步流第一步）：
// 页面上下文抓取（带会话 cookie）→ base64 → 经 background 上传 /images → 改写上次采集 HTML 的引用
chrome.runtime.onMessage.addListener((request: any, _sender, sendResponse) => {
  if (request && request.notemarkerClip === 'localizeImages') {
    ;(async () => {
      try {
        const urls: string[] = [...new Set(request.urls ?? [])]
        const EXT_BY_TYPE: Record<string, string> = {
          'image/png': 'png',
          'image/jpeg': 'jpg',
          'image/gif': 'gif',
          'image/webp': 'webp',
          'image/svg+xml': 'svg',
        }
        const urlMap: Record<string, string> = {}
        let localized = 0
        let failed = 0
        let cursor = 0
        const worker = async (): Promise<void> => {
          while (cursor < urls.length) {
            const url = urls[cursor++]
            try {
              const ctrl = new AbortController()
              const timer = setTimeout(() => ctrl.abort(), 15000)
              const res = await fetch(url, { credentials: 'include', signal: ctrl.signal })
              clearTimeout(timer)
              if (!res.ok) throw new Error(`HTTP ${res.status}`)
              const blob = await res.blob()
              if (blob.size > 5 * 1024 * 1024) throw new Error('too large')
              const data = await new Promise<string>((resolve, reject) => {
                const fr = new FileReader()
                fr.onload = () => resolve(String(fr.result).split(',')[1] ?? '')
                fr.onerror = () => reject(fr.error)
                fr.readAsDataURL(blob)
              })
              let filename = ''
              try {
                filename = new URL(url).pathname.split('/').pop() || ''
              } catch {
                filename = ''
              }
              if (!/\.\w+$/.test(filename)) filename = `img.${EXT_BY_TYPE[blob.type] ?? 'png'}`
              const up = await chrome.runtime.sendMessage({ action: 'uploadImage', data, filename })
              if (up?.ok && up.local) {
                urlMap[url] = up.local
                localized++
              } else {
                throw new Error('upload failed')
              }
            } catch {
              failed++
            }
          }
        }
        await Promise.all(Array.from({ length: Math.min(4, Math.max(1, urls.length)) }, worker))
        // 第二步：在上次采集 HTML 上把成功者改写为本地相对路径（.md 位于 content/ 下，相对 images/…）
        let html = lastCollectedHTML
        for (const [url, local] of Object.entries(urlMap)) {
          html = html.split(url).join(local.replace(/^content\//, ''))
        }
        lastCollectedHTML = html
        sendResponse({ ok: true, html, stats: { total: urls.length, localized, failed } })
      } catch (err) {
        sendResponse({ ok: false, error: String(err) })
      }
    })()
    return true
  }
})

// background 的注入探测应答（clipScriptReady 发 {message:'ping'}；toast 移除后仅保留此职责）
chrome.runtime.onMessage.addListener((request: any, _sender, sendResponse) => {
  if (request.message === 'ping') {
    sendResponse({ ready: true })
  }
})
