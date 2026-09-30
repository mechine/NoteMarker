import { randomUUID } from 'node:crypto'
import { db } from '../client'

export interface AnnotationRow {
  id: string
  page_id: string
  message_id: string | null
  quote: string
  prefix: string | null
  suffix: string | null
  start_offset: number | null
  end_offset: number | null
  note: string
  type: string
  color: string
  created_at: string
  updated_at: string
}

export interface AnnotationInput {
  pageId: string
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

/** 位置去重：可空字段用 IS 匹配（比唯一索引更严——索引视 NULL 为互异，此处视为同位置） */
export function findAtPosition(
  pageId: string,
  messageId: string | null,
  startOffset: number | null,
  endOffset: number | null,
): AnnotationRow | undefined {
  return db
    .prepare(
      `SELECT * FROM annotations
       WHERE page_id = ? AND message_id IS ? AND start_offset IS ? AND end_offset IS ?`,
    )
    .get(pageId, messageId, startOffset, endOffset) as AnnotationRow | undefined
}

export function insertAnnotation(input: AnnotationInput): string {
  const id = randomUUID()
  db.prepare(
    `INSERT INTO annotations (id, page_id, message_id, quote, prefix, suffix, start_offset, end_offset, note, type, color)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.pageId,
    input.messageId ?? null,
    input.quote,
    input.prefix ?? null,
    input.suffix ?? null,
    input.startOffset ?? null,
    input.endOffset ?? null,
    input.note ?? '',
    input.type ?? 'highlight',
    input.color ?? 'yellow',
  )
  return id
}

export function getAnnotationById(id: string): AnnotationRow | undefined {
  return db.prepare('SELECT * FROM annotations WHERE id = ?').get(id) as AnnotationRow | undefined
}

/** 带确定 id 的覆盖写（导出请求中携带既有标注 id 时） */
export function upsertAnnotationWithId(input: AnnotationInput & { id: string }): void {
  const existing = getAnnotationById(input.id)
  if (existing) {
    db.prepare(
      `UPDATE annotations SET quote = ?, prefix = ?, suffix = ?, start_offset = ?, end_offset = ?,
       note = ?, type = ?, color = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    ).run(
      input.quote,
      input.prefix ?? null,
      input.suffix ?? null,
      input.startOffset ?? null,
      input.endOffset ?? null,
      input.note ?? '',
      input.type ?? 'highlight',
      input.color ?? 'yellow',
      input.id,
    )
  } else {
    db.prepare(
      `INSERT INTO annotations (id, page_id, message_id, quote, prefix, suffix, start_offset, end_offset, note, type, color)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.id,
      input.pageId,
      input.messageId ?? null,
      input.quote,
      input.prefix ?? null,
      input.suffix ?? null,
      input.startOffset ?? null,
      input.endOffset ?? null,
      input.note ?? '',
      input.type ?? 'highlight',
      input.color ?? 'yellow',
    )
  }
}

export function updateAnnotationFields(
  id: string,
  fields: { note?: string; color?: string; type?: string },
): boolean {
  const sets: string[] = []
  const values: (string | number)[] = []
  if (fields.note !== undefined) {
    sets.push('note = ?')
    values.push(fields.note)
  }
  if (fields.color !== undefined) {
    sets.push('color = ?')
    values.push(fields.color)
  }
  if (fields.type !== undefined) {
    sets.push('type = ?')
    values.push(fields.type)
  }
  if (!sets.length) return getAnnotationById(id) !== undefined
  sets.push("updated_at = CURRENT_TIMESTAMP")
  const r = db.prepare(`UPDATE annotations SET ${sets.join(', ')} WHERE id = ?`).run(...values, id)
  return r.changes > 0
}

export function deleteAnnotation(id: string): boolean {
  const r = db.prepare('DELETE FROM annotations WHERE id = ?').run(id)
  return r.changes > 0
}

export function listAnnotationsByPage(pageId: string): AnnotationRow[] {
  return db
    .prepare('SELECT * FROM annotations WHERE page_id = ? ORDER BY created_at, rowid')
    .all(pageId) as unknown as AnnotationRow[]
}

/** 跨页查询过滤条件（specs/annotations-api 跨页查询标注） */
export interface AnnotationListFilters {
  site?: string
  type?: string
  /** true 仅批注非空；false 仅批注为空 */
  hasNote?: boolean
  /** quote/note 子串匹配（大小写不敏感） */
  q?: string
}

/** 跨页列表项：标注字段 + 来源页信息 */
export interface AnnotationWithPage extends AnnotationRow {
  pageTitle: string | null
  site: string | null
  pageUrl: string
}

/**
 * 跨页分页查询：JOIN pages 取来源页信息，created_at 倒序（id 兜底稳定排序）。
 * q 用 LIKE 匹配：转义用户输入中的 % _ \（ESCAPE '\'），SQLite LIKE 对 ASCII 默认不区分大小写。
 */
export function listAnnotationsAcrossPages(
  filters: AnnotationListFilters,
  limit: number,
  offset: number,
): { rows: AnnotationWithPage[]; total: number } {
  const where: string[] = []
  const values: (string | number)[] = []
  if (filters.site) {
    where.push('p.site = ?')
    values.push(filters.site)
  }
  if (filters.type) {
    where.push('a.type = ?')
    values.push(filters.type)
  }
  if (filters.hasNote !== undefined) {
    where.push(
      filters.hasNote ? "(a.note IS NOT NULL AND a.note != '')" : "(a.note IS NULL OR a.note = '')",
    )
  }
  if (filters.q) {
    const like = `%${filters.q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`
    where.push("(a.quote LIKE ? ESCAPE '\\' OR a.note LIKE ? ESCAPE '\\')")
    values.push(like, like)
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''
  const base = `FROM annotations a JOIN pages p ON a.page_id = p.id ${whereSql}`
  const total = (db.prepare(`SELECT COUNT(*) AS n ${base}`).get(...values) as { n: number }).n
  const rows = db
    .prepare(
      `SELECT a.*, p.title AS pageTitle, p.site AS site, p.url AS pageUrl ${base}
       ORDER BY a.created_at DESC, a.id DESC LIMIT ? OFFSET ?`,
    )
    .all(...values, limit, offset) as unknown as AnnotationWithPage[]
  return { rows, total }
}
