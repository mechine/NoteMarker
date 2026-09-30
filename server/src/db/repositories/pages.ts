import { randomUUID } from 'node:crypto'
import { db } from '../client'

export interface PageRow {
  id: string
  url: string
  url_hash: string
  title: string | null
  site: string | null
  page_type: string
  content_hash: string | null
  annotation_count: number
  read_status: string
  created_at: string
  updated_at: string
}

export function findPageByUrlHash(urlHash: string): PageRow | undefined {
  return db.prepare('SELECT * FROM pages WHERE url_hash = ?').get(urlHash) as PageRow | undefined
}

export function getPageById(id: string): PageRow | undefined {
  return db.prepare('SELECT * FROM pages WHERE id = ?').get(id) as PageRow | undefined
}

export function findOrCreatePage(input: {
  url: string
  urlHash: string
  title?: string | null
  site?: string | null
}): PageRow {
  const existing = findPageByUrlHash(input.urlHash)
  if (existing) {
    // 标题可能在后续请求中补全
    if (!existing.title && input.title) {
      db.prepare('UPDATE pages SET title = ? WHERE id = ?').run(input.title, existing.id)
      return getPageById(existing.id)!
    }
    return existing
  }
  const id = randomUUID()
  db.prepare(
    'INSERT INTO pages (id, url, url_hash, title, site) VALUES (?, ?, ?, ?, ?)',
  ).run(id, input.url, input.urlHash, input.title ?? null, input.site ?? null)
  return getPageById(id)!
}

/** 导出完成：记录内容 hash 并刷新 updated_at（updated_at 同时充当"最近导出时间"，见 design D4） */
export function markExported(pageId: string, contentHash: string): void {
  db.prepare(
    "UPDATE pages SET content_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
  ).run(contentHash, pageId)
}

export function syncAnnotationCount(pageId: string): number {
  const { n } = db
    .prepare('SELECT COUNT(*) AS n FROM annotations WHERE page_id = ?')
    .get(pageId) as { n: number }
  db.prepare('UPDATE pages SET annotation_count = ? WHERE id = ?').run(n, pageId)
  return n
}

export function deletePage(pageId: string): boolean {
  const r = db.prepare('DELETE FROM pages WHERE id = ?').run(pageId)
  return r.changes > 0
}

/** 阅读列表：按 updated_at 降序分页（specs/page-readlist） */
export function listPages(filter: { status?: string; limit: number; offset: number }): PageRow[] {
  const orderBy = 'ORDER BY updated_at DESC, rowid DESC'
  if (filter.status) {
    return db
      .prepare(`SELECT * FROM pages WHERE read_status = ? ${orderBy} LIMIT ? OFFSET ?`)
      .all(filter.status, filter.limit, filter.offset) as unknown as PageRow[]
  }
  return db
    .prepare(`SELECT * FROM pages ${orderBy} LIMIT ? OFFSET ?`)
    .all(filter.limit, filter.offset) as unknown as PageRow[]
}

export function countPages(status?: string): number {
  const row = status
    ? (db.prepare('SELECT COUNT(*) AS n FROM pages WHERE read_status = ?').get(status) as { n: number })
    : (db.prepare('SELECT COUNT(*) AS n FROM pages').get() as { n: number })
  return row.n
}

/** 只改阅读状态，不动 updated_at（updated_at 兼作"最近导出时间"，避免标记已读把页面顶到列表最前） */
export function updateReadStatus(pageId: string, status: string): boolean {
  const r = db.prepare('UPDATE pages SET read_status = ? WHERE id = ?').run(status, pageId)
  return r.changes > 0
}
