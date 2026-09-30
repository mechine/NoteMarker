import fs from 'node:fs'
import path from 'node:path'
import { KB_HOME } from '../env'
import { ApiError } from '../errors'
import {
  findOrCreatePage,
  findPageByUrlHash,
  markExported,
  syncAnnotationCount,
  type PageRow,
} from '../db/repositories/pages'
import {
  findAtPosition,
  insertAnnotation,
  listAnnotationsByPage,
  upsertAnnotationWithId,
} from '../db/repositories/annotations'
import { appendAnnotationsSection, htmlToMarkdown } from './markdown'
import { storeImage, type StoreImageInput } from './images'
import { normalizeUrl, sha256, siteOf, urlHashOf } from './url'
import { loadConfig } from './config'
import { writeSidecar } from './sidecar'

const CONTENT_DIR = path.join(KB_HOME, 'content')

export interface ExportAnnotationInput {
  id?: string
  messageId?: string | null
  quote: string
  prefix?: string | null
  suffix?: string | null
  startOffset?: number | null
  endOffset?: number | null
  note?: string
  type?: string
  color?: string
}

export interface ExportRequest {
  trigger?: string
  pageUrl: string
  pageTitle?: string
  html?: string
  markdown?: string
  annotations?: ExportAnnotationInput[]
  images?: StoreImageInput[]
  options?: { saveHtml?: boolean; saveJson?: boolean; downloadImages?: boolean }
}

export function validateExportRequest(body: ExportRequest): void {
  if (typeof body?.pageUrl !== 'string' || !body.pageUrl.trim()) {
    throw new ApiError(400, 'invalid_request', 'pageUrl 不能为空')
  }
  try {
    normalizeUrl(body.pageUrl)
  } catch {
    throw new ApiError(400, 'invalid_request', `pageUrl 无法解析：${body.pageUrl}`)
  }
  const hasMarkdown = typeof body.markdown === 'string' && body.markdown.length > 0
  const hasHtml = typeof body.html === 'string' && body.html.length > 0
  if (!hasMarkdown && !hasHtml) {
    throw new ApiError(400, 'invalid_request', 'html 与 markdown 至少提供其一')
  }
}

/** SQLite CURRENT_TIMESTAMP（UTC，无时区后缀）→ epoch 毫秒 */
function sqliteTimeToMs(s: string): number {
  return Date.parse(`${s.replace(' ', 'T')}Z`)
}

function withinDedupeWindow(page: PageRow): boolean {
  const windowSec = loadConfig().dedupeWindow
  if (windowSec <= 0) return false
  const lastMs = sqliteTimeToMs(page.updated_at)
  if (Number.isNaN(lastMs)) return false
  return Date.now() - lastMs < windowSec * 1000
}

function markdownSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** POST /export/preview：与导出共用校验与去重判定，但不写文件不改库（specs/page-export 预览导出） */
export function previewExport(body: ExportRequest) {
  validateExportRequest(body)
  const markdown = body.markdown ?? htmlToMarkdown(body.html!)
  const contentHash = sha256(markdown)
  const page = findPageByUrlHash(urlHashOf(body.pageUrl))

  const contentChanged = !page || page.content_hash !== contentHash
  const willSkip = page?.content_hash
    ? page.content_hash === contentHash || withinDedupeWindow(page)
    : false

  return {
    ok: true as const,
    willSkip,
    estimatedSize: markdownSize(Buffer.byteLength(markdown, 'utf8')),
    annotationCount: page ? page.annotation_count : (body.annotations?.length ?? 0),
    imageCount: body.images?.length ?? 0,
    contentChanged,
  }
}

/** POST /export 主链路：URL 规范化 → hash/窗口去重 → 标注 upsert → 图片处理 → 写文件 → 更新索引（design D4） */
export async function exportPage(body: ExportRequest) {
  validateExportRequest(body)

  const url = normalizeUrl(body.pageUrl)
  const page = findOrCreatePage({
    url,
    urlHash: sha256(url),
    title: body.pageTitle ?? null,
    site: siteOf(url),
  })
  const mdPath = `content/${page.id}.md`

  // 1) 正文 Markdown（插件已转好则直接使用）与内容 hash
  const markdown = body.markdown ?? htmlToMarkdown(body.html!)
  const contentHash = sha256(markdown)

  // 2) 去重判定：内容 hash 命中 或 时间窗口命中 → skipped（见 specs/page-export 导出幂等去重）
  if (page.content_hash && (page.content_hash === contentHash || withinDedupeWindow(page))) {
    return {
      ok: true as const,
      skipped: true as const,
      reason: 'duplicate',
      existingFile: mdPath,
    }
  }

  // 3) 标注 upsert（按 id 覆盖写 / 按位置去重插入）
  let inserted = 0
  let failed = 0
  for (const a of body.annotations ?? []) {
    if (typeof a?.quote !== 'string' || !a.quote) {
      failed++
      continue
    }
    try {
      if (a.id) {
        upsertAnnotationWithId({
          id: a.id,
          pageId: page.id,
          messageId: a.messageId ?? null,
          quote: a.quote,
          prefix: a.prefix ?? null,
          suffix: a.suffix ?? null,
          startOffset: a.startOffset ?? null,
          endOffset: a.endOffset ?? null,
          note: a.note ?? '',
          type: a.type ?? 'highlight',
          color: a.color ?? 'yellow',
        })
        inserted++
      } else {
        const dup = findAtPosition(page.id, a.messageId ?? null, a.startOffset ?? null, a.endOffset ?? null)
        if (dup) continue
        insertAnnotation({
          pageId: page.id,
          messageId: a.messageId ?? null,
          quote: a.quote,
          prefix: a.prefix ?? null,
          suffix: a.suffix ?? null,
          startOffset: a.startOffset ?? null,
          endOffset: a.endOffset ?? null,
          note: a.note ?? '',
          type: a.type ?? 'highlight',
          color: a.color ?? 'yellow',
        })
        inserted++
      }
    } catch (err) {
      console.error('[export] 标注写入失败:', err)
      failed++
    }
  }
  const total = syncAnnotationCount(page.id)

  // 4) 图片处理
  const imagesStat = { saved: 0, deduped: 0 }
  const opts = body.options ?? {}
  if (opts.downloadImages !== false && body.images?.length) {
    for (const img of body.images) {
      try {
        const r = await storeImage(img)
        if (r.deduped) imagesStat.deduped++
        else imagesStat.saved++
      } catch (err) {
        if (err instanceof ApiError && err.status >= 500) throw err
        console.error('[export] 图片处理失败（跳过）:', err)
      }
    }
  }

  // 5) 标注区块 + 写文件
  const annotations = listAnnotationsByPage(page.id)
  const finalMarkdown = appendAnnotationsSection(markdown, annotations.map((a) => ({ quote: a.quote, note: a.note })))
  fs.mkdirSync(CONTENT_DIR, { recursive: true })
  fs.writeFileSync(path.join(CONTENT_DIR, `${page.id}.md`), finalMarkdown, 'utf8')

  let jsonPath: string | null = null
  if (opts.saveJson !== false) {
    jsonPath = `content/${page.id}.json`
    // 侧车快照改走共用写入（specs kb-rebuild）：与 5 分钟定时刷同一结构（含 messages），坏库重建用
    // 注：标题用导出请求值（侧车共用函数取库内值，导出路径库内标题可能刚由本请求补全，两者一致）
    writeSidecar(page.id, body.trigger ?? 'manual')
  }

  let htmlPath: string | null = null
  if (opts.saveHtml === true && typeof body.html === 'string' && body.html.length > 0) {
    htmlPath = `content/${page.id}.html`
    fs.writeFileSync(path.join(CONTENT_DIR, `${page.id}.html`), body.html, 'utf8')
  }

  // 6) 更新索引
  markExported(page.id, contentHash)

  return {
    ok: true as const,
    skipped: false as const,
    pageId: page.id,
    files: { markdown: mdPath, json: jsonPath, html: htmlPath },
    images: imagesStat,
    annotations: { total, inserted, failed },
  }
}
