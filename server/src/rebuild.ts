// kb.db 损坏/丢失后的重建脚本（specs kb-rebuild）：从 content/ 侧车文件与图片缓存重建全新库。
// 用法：先停止后端（库文件被占用时脚本会拒绝执行），然后在 server/ 下执行 `npm run rebuild`。
//
// 可重建：
// - pages + annotations + messages —— content/{pageId}.json 侧车快照：剪藏导出立即写，
//   其余变更由后端 5 分钟脏页定时刷落盘（specs kb-rebuild），丢失窗口 ≤5 分钟（正常停机冲刷归零）
// - images 映射 —— content/images/{hash}.{ext} 文件名即主键、扩展名定 MIME、体积可 stat
// 不可重建（库坏即丢，需知晓）：
// - 最后一次侧车刷盘之后的变更（进程被强杀时最多 5 分钟窗口）
// - pages.read_status（侧车未记录，重建后回到 unread）
import fs from 'node:fs'
import path from 'node:path'
import { KB_HOME } from './env'
import { normalizeUrl, urlHashOf } from './services/url'

const DB_PATH = path.join(KB_HOME, 'kb.db')
const CONTENT_DIR = path.join(KB_HOME, 'content')
const IMAGES_DIR = path.join(CONTENT_DIR, 'images')

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
}

interface SidecarAnnotation {
  id?: string
  message_id?: string | null
  quote?: string
  prefix?: string | null
  suffix?: string | null
  start_offset?: number | null
  end_offset?: number | null
  note?: string | null
  type?: string | null
  color?: string | null
}

interface SidecarMessage {
  id?: string
  message_id?: string
  role?: string | null
  text?: string
  content_hash?: string
  sequence?: number | null
}

interface Sidecar {
  page?: {
    id?: string
    url?: string
    title?: string | null
    site?: string | null
    contentHash?: string | null
  }
  annotations?: SidecarAnnotation[]
  messages?: SidecarMessage[]
}

async function main(): Promise<void> {
  // 1) 坏库隔离——必须在动态 import db/client 之前：它在模块加载时就会开库建表
  if (fs.existsSync(DB_PATH)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    try {
      fs.renameSync(DB_PATH, `${DB_PATH}.corrupt-${stamp}`)
    } catch {
      console.error('[rebuild] kb.db 无法改名（多半被运行中的后端占用）。请先停止后端服务再执行重建。')
      process.exit(1)
    }
    // WAL/SHM 是旧库伴随文件，随主文件一起隔离；不存在时忽略
    for (const suffix of ['-wal', '-shm']) {
      try {
        fs.renameSync(DB_PATH + suffix, `${DB_PATH}${suffix}.corrupt-${stamp}`)
      } catch {
        /* 不存在即可 */
      }
    }
    console.log(`[rebuild] 旧库已隔离：kb.db.corrupt-${stamp}（确认无误后可手动删除）`)
  }

  // 2) 全新库（db/client 加载即建目录、建库、建表）
  const { db } = await import('./db/client')
  const { syncAnnotationCount } = await import('./db/repositories/pages')
  const { upsertAnnotationWithId } = await import('./db/repositories/annotations')
  const { findImageByHash, insertImage } = await import('./db/repositories/images')
  const { findMessage, insertMessage, updateMessageContent } = await import('./db/repositories/messages')

  // 3) content/*.json → pages + annotations（带原 id，保持与 .md/.json 文件名一致）
  let pageCount = 0
  let annCount = 0
  let msgCount = 0
  let badJson = 0
  const jsonFiles = fs.existsSync(CONTENT_DIR)
    ? fs.readdirSync(CONTENT_DIR).filter((f) => f.endsWith('.json'))
    : []
  for (const f of jsonFiles) {
    let sidecar: Sidecar
    try {
      sidecar = JSON.parse(fs.readFileSync(path.join(CONTENT_DIR, f), 'utf8'))
    } catch {
      badJson++
      continue
    }
    const p = sidecar.page
    if (!p || typeof p.id !== 'string' || typeof p.url !== 'string') {
      badJson++
      continue
    }
    const url = normalizeUrl(p.url)
    db.prepare(
      'INSERT OR IGNORE INTO pages (id, url, url_hash, title, site, content_hash) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(p.id, url, urlHashOf(p.url), p.title ?? null, p.site ?? null, p.contentHash ?? null)
    pageCount++
    for (const a of sidecar.annotations ?? []) {
      if (!a || typeof a.id !== 'string' || typeof a.quote !== 'string' || !a.quote) continue
      try {
        upsertAnnotationWithId({
          id: a.id,
          pageId: p.id,
          messageId: a.message_id ?? null,
          quote: a.quote,
          prefix: a.prefix ?? null,
          suffix: a.suffix ?? null,
          startOffset: a.start_offset ?? null,
          endOffset: a.end_offset ?? null,
          note: a.note ?? '',
          type: a.type ?? 'highlight',
          color: a.color ?? 'yellow',
        })
        annCount++
      } catch (err) {
        console.error(`[rebuild] 标注写入失败（跳过）page=${p.id}:`, err instanceof Error ? err.message : err)
      }
    }
    for (const m of sidecar.messages ?? []) {
      if (!m || typeof m.message_id !== 'string' || typeof m.text !== 'string') continue
      try {
        // (page, messageId) 唯一：已存在且内容相同跳过；内容不同按"变内容更新"语义刷新
        const existing = findMessage(p.id, m.message_id)
        if (existing) {
          if (existing.content_hash !== (m.content_hash ?? '')) {
            updateMessageContent(existing.id, m.text, m.content_hash ?? '')
            msgCount++
          }
          continue
        }
        insertMessage({
          pageId: p.id,
          messageId: m.message_id,
          role: m.role ?? null,
          text: m.text,
          contentHash: m.content_hash ?? '',
          sequence: m.sequence ?? null,
        })
        msgCount++
      } catch (err) {
        console.error(`[rebuild] 消息写入失败（跳过）page=${p.id}:`, err instanceof Error ? err.message : err)
      }
    }
    syncAnnotationCount(p.id)
  }

  // 4) content/images/{hash}.{ext} → images 映射
  let imgCount = 0
  let imgSkip = 0
  const imgFiles = fs.existsSync(IMAGES_DIR) ? fs.readdirSync(IMAGES_DIR) : []
  for (const f of imgFiles) {
    const m = /^([0-9a-f]{64})\.(\w+)$/.exec(f)
    if (!m) continue
    const [, hash, ext] = m
    if (findImageByHash(hash)) {
      imgSkip++
      continue
    }
    try {
      const size = fs.statSync(path.join(IMAGES_DIR, f)).size
      insertImage({
        hash,
        filename: f,
        mimeType: MIME_BY_EXT[ext] ?? null,
        sizeBytes: size,
      })
      imgCount++
    } catch (err) {
      console.error(`[rebuild] 图片映射写入失败（跳过）${f}:`, err instanceof Error ? err.message : err)
    }
  }

  db.close()
  console.log(
    `[rebuild] 完成：页面 ${pageCount}（损坏侧车 ${badJson}）· 标注 ${annCount} · 消息 ${msgCount} · 图片映射 ${imgCount}（已存在 ${imgSkip}）`,
  )
  if (badJson > 0) console.log('[rebuild] 注意：有侧车文件解析失败，详见上方计数，可人工检查 content/ 下对应 .json')
  console.log('[rebuild] 提醒：最后一次侧车刷盘之后的变更无法恢复（窗口 ≤5 分钟，见脚本头注释）')
}

void main()
