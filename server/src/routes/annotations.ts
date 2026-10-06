import { Router } from 'express'
import { ApiError } from '../errors'
import { findOrCreatePage, findPageByUrlHash, syncAnnotationCount } from '../db/repositories/pages'
import { findMessage } from '../db/repositories/messages'
import {
  deleteAnnotation,
  findAtPosition,
  getAnnotationById,
  insertAnnotation,
  listAnnotationsAcrossPages,
  listAnnotationsByPage,
  updateAnnotationFields,
  upsertAnnotationWithId,
  type AnnotationRow,
} from '../db/repositories/annotations'
import { normalizeUrl, sha256, siteOf } from '../services/url'
import { markSidecarDirty } from '../services/sidecar'

export const annotationsRouter = Router()

/** SQLite DATETIME（UTC 无后缀）→ ISO 8601 */
function toIso(s: string): string {
  return `${s.replace(' ', 'T')}Z`
}

function toApi(row: AnnotationRow) {
  return {
    id: row.id,
    messageId: row.message_id,
    quote: row.quote,
    prefix: row.prefix,
    suffix: row.suffix,
    startOffset: row.start_offset,
    endOffset: row.end_offset,
    note: row.note,
    type: row.type,
    color: row.color,
    createdAt: toIso(row.created_at),
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** 客户端标注时间（ISO 8601）→ SQLite DATETIME 文本（UTC 秒级，与 CURRENT_TIMESTAMP 同构） */
function toSqliteDatetime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) {
    throw new ApiError(400, 'invalid_request', `createdAt 无法解析：${iso}`)
  }
  return d.toISOString().slice(0, 19).replace('T', ' ')
}

function parsePageAndBody(body: Record<string, unknown>) {
  const pageUrl = body.pageUrl
  const quote = body.quote
  if (typeof pageUrl !== 'string' || !pageUrl.trim()) {
    throw new ApiError(400, 'invalid_request', 'pageUrl 不能为空')
  }
  if (typeof quote !== 'string' || !quote) {
    throw new ApiError(400, 'invalid_request', 'quote 不能为空')
  }
  let url: string
  try {
    url = normalizeUrl(pageUrl)
  } catch {
    throw new ApiError(400, 'invalid_request', `pageUrl 无法解析：${pageUrl}`)
  }
  const messageId = typeof body.messageId === 'string' && body.messageId ? body.messageId : null
  const offsets = [body.startOffset, body.endOffset].map((v) =>
    typeof v === 'number' && Number.isFinite(v) ? v : null,
  )
  const id = typeof body.id === 'string' && body.id ? body.id : null
  if (id && !UUID_RE.test(id)) {
    throw new ApiError(400, 'invalid_request', `id 不是合法 UUID：${id}`)
  }
  return {
    id,
    url,
    messageId,
    quote,
    offsets: { start: offsets[0], end: offsets[1] },
    optional: {
      prefix: typeof body.prefix === 'string' ? body.prefix : null,
      suffix: typeof body.suffix === 'string' ? body.suffix : null,
      note: typeof body.note === 'string' ? body.note : '',
      type: typeof body.type === 'string' ? body.type : 'highlight',
      color: typeof body.color === 'string' ? body.color : 'yellow',
      pageTitle: typeof body.pageTitle === 'string' ? body.pageTitle : null,
      createdAt:
        typeof body.createdAt === 'string' && body.createdAt ? toSqliteDatetime(body.createdAt) : null,
    },
  }
}

/**
 * 单条标注的创建/upsert（POST / 与 POST /batch 共用，design D1/D2）：
 * - 带 id：已存在 → 覆盖更新（返回 updatedAt）；不存在 → 同位置唯一冲突幂等返回既有 id，否则带 id 插入
 * - 不带 id：服务端生成 UUID，位置重复幂等返回
 * 位置去重仅在 startOffset/endOffset 均非空时生效：NULL 偏移没有可比"位置"，
 * 否则同页全部 NULL 偏移的标注会被互相误合并（SQLite 唯一索引对 NULL 互异，允许并存）。
 */
function createAnnotation(body: Record<string, unknown>): Record<string, unknown> {
  const parsed = parsePageAndBody(body)
  const page = findOrCreatePage({
    url: parsed.url,
    urlHash: sha256(parsed.url),
    title: parsed.optional.pageTitle,
    site: siteOf(parsed.url),
  })
  const hasPosition = parsed.offsets.start !== null && parsed.offsets.end !== null

  if (parsed.id) {
    const existing = getAnnotationById(parsed.id)
    if (existing) {
      upsertAnnotationWithId({
        id: parsed.id,
        pageId: page.id,
        messageId: parsed.messageId,
        quote: parsed.quote,
        prefix: parsed.optional.prefix,
        suffix: parsed.optional.suffix,
        startOffset: parsed.offsets.start,
        endOffset: parsed.offsets.end,
        note: parsed.optional.note,
        type: parsed.optional.type,
        color: parsed.optional.color,
        createdAt: parsed.optional.createdAt,
      })
      markSidecarDirty(page.id)
      const row = getAnnotationById(parsed.id)!
      return { ok: true, id: parsed.id, updatedAt: toIso(row.updated_at) }
    }

    // 位置被其他标注占用：幂等返回既有 id（客户端采用返回 id 对齐）
    const dup = hasPosition
      ? findAtPosition(page.id, parsed.messageId, parsed.offsets.start, parsed.offsets.end)
      : undefined
    if (dup) {
      return { ok: true, id: dup.id, createdAt: toIso(dup.created_at), deduped: true }
    }

    upsertAnnotationWithId({
      id: parsed.id,
      pageId: page.id,
      messageId: parsed.messageId,
      quote: parsed.quote,
      prefix: parsed.optional.prefix,
      suffix: parsed.optional.suffix,
      startOffset: parsed.offsets.start,
      endOffset: parsed.offsets.end,
      note: parsed.optional.note,
      type: parsed.optional.type,
      color: parsed.optional.color,
      createdAt: parsed.optional.createdAt,
    })
    syncAnnotationCount(page.id)
  markSidecarDirty(page.id)
    const row = getAnnotationById(parsed.id)!
    const needSnapshot = parsed.messageId !== null && !findMessage(page.id, parsed.messageId)
    return {
      ok: true,
      id: parsed.id,
      createdAt: toIso(row.created_at),
      ...(needSnapshot ? { needSnapshot: true } : {}),
    }
  }

  // 位置去重：幂等返回既有 id（specs/annotations-api 同一位置重复标注幂等返回；仅偏移完整时生效）
  const dup = hasPosition
    ? findAtPosition(page.id, parsed.messageId, parsed.offsets.start, parsed.offsets.end)
    : undefined
  if (dup) {
    return { ok: true, id: dup.id, createdAt: toIso(dup.created_at), deduped: true }
  }

  const id = insertAnnotation({
    pageId: page.id,
    messageId: parsed.messageId,
    quote: parsed.quote,
    prefix: parsed.optional.prefix,
    suffix: parsed.optional.suffix,
    startOffset: parsed.offsets.start,
    endOffset: parsed.offsets.end,
    note: parsed.optional.note,
    type: parsed.optional.type,
    color: parsed.optional.color,
    createdAt: parsed.optional.createdAt,
  })
  syncAnnotationCount(page.id)
  markSidecarDirty(page.id)

  // 消息快照缺失提示（specs/annotations-api needSnapshot 场景）
  const needSnapshot = parsed.messageId !== null && !findMessage(page.id, parsed.messageId)

  const row = getAnnotationById(id)!
  return { ok: true, id, createdAt: toIso(row.created_at), ...(needSnapshot ? { needSnapshot: true } : {}) }
}

annotationsRouter.post('/', (req, res) => {
  res.status(200).json(createAnnotation(req.body ?? {}))
})

// 批量同步：逐条复用单条逻辑，单条失败不断批（design D2）。须先于参数化路由注册
annotationsRouter.post('/batch', (req, res) => {
  const items = (req.body ?? {}).annotations
  if (!Array.isArray(items) || items.length === 0) {
    throw new ApiError(400, 'invalid_request', 'annotations 必须是非空数组')
  }
  const results = items.map((item, index) => {
    try {
      return { index, ok: true, ...createAnnotation(item ?? {}) }
    } catch (err) {
      // 校验类失败落到该条结果；意外异常也不中断整批
      return { index, ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
  res.status(200).json({ ok: true, results })
})

annotationsRouter.get('/', (req, res) => {
  const pageUrl = req.query.pageUrl
  if (typeof pageUrl === 'string' && pageUrl) {
    // 按页查询（specs/annotations-api 按页查询标注）：行为不变
    let url: string
    try {
      url = normalizeUrl(pageUrl)
    } catch {
      res.status(400).json({ ok: false, error: 'invalid_request', message: `pageUrl 无法解析：${pageUrl}` })
      return
    }
    const page = findPageByUrlHash(sha256(url))
    const rows = page ? listAnnotationsByPage(page.id) : []
    res.status(200).json({ ok: true, annotations: rows.map(toApi) })
    return
  }

  // 跨页分页查询（specs/annotations-api 跨页查询标注）：limit/offset clamp 对齐 pages.ts 约定
  const q = req.query
  let limit = Number.parseInt(String(q.limit ?? ''), 10) || 50
  if (limit < 1) limit = 50
  if (limit > 200) limit = 200
  const offset = Math.max(0, Number.parseInt(String(q.offset ?? ''), 10) || 0)

  const hasNote = q.hasNote === 'true' ? true : q.hasNote === 'false' ? false : undefined
  const { rows, total } = listAnnotationsAcrossPages(
    {
      site: typeof q.site === 'string' && q.site ? q.site : undefined,
      type: typeof q.type === 'string' && q.type ? q.type : undefined,
      hasNote,
      q: typeof q.q === 'string' && q.q ? q.q : undefined,
    },
    limit,
    offset,
  )
  res.status(200).json({
    ok: true,
    annotations: rows.map((r) => ({
      ...toApi(r),
      pageTitle: r.pageTitle,
      site: r.site,
      pageUrl: r.pageUrl,
    })),
    total,
    limit,
    offset,
  })
})

annotationsRouter.put('/:id', (req, res) => {
  const { note, color, type } = req.body ?? {}
  const fields: { note?: string; color?: string; type?: string } = {}
  if (note !== undefined) {
    if (typeof note !== 'string') throw new ApiError(400, 'invalid_request', 'note 必须是字符串')
    fields.note = note
  }
  if (color !== undefined) {
    if (typeof color !== 'string') throw new ApiError(400, 'invalid_request', 'color 必须是字符串')
    fields.color = color
  }
  if (type !== undefined) {
    if (typeof type !== 'string') throw new ApiError(400, 'invalid_request', 'type 必须是字符串')
    fields.type = type
  }
  const ok = updateAnnotationFields(req.params.id, fields)
  if (!ok) {
    throw new ApiError(404, 'not_found', `标注不存在：${req.params.id}`)
  }
  markSidecarDirty(getAnnotationById(req.params.id)!.page_id)
  res.status(200).json({ ok: true })
})

annotationsRouter.delete('/:id', (req, res) => {
  const row = getAnnotationById(req.params.id)
  if (!row) {
    throw new ApiError(404, 'not_found', `标注不存在：${req.params.id}`)
  }
  deleteAnnotation(req.params.id)
  syncAnnotationCount(row.page_id)
  markSidecarDirty(row.page_id)
  res.status(200).json({ ok: true })
})
