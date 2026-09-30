import fs from 'node:fs'
import path from 'node:path'
import { Router } from 'express'
import { KB_HOME } from '../env'
import { ApiError } from '../errors'
import {
  countPages,
  deletePage,
  getPageById,
  listPages,
  updateReadStatus,
} from '../db/repositories/pages'

export const pagesRouter = Router()

const READ_STATUSES = ['unread', 'read', 'archived'] as const

/** SQLite DATETIME（UTC 无后缀）→ ISO 8601 */
function toIso(s: string): string {
  return `${s.replace(' ', 'T')}Z`
}

// 阅读列表：分页 + 状态过滤（specs/page-readlist）
pagesRouter.get('/', (req, res) => {
  const q = req.query
  let status: string | undefined
  if (typeof q.status === 'string' && q.status) {
    if (!(READ_STATUSES as readonly string[]).includes(q.status)) {
      throw new ApiError(400, 'invalid_request', `status 取值必须是 ${READ_STATUSES.join(' / ')}`)
    }
    status = q.status
  }
  const page = Math.max(1, Number.parseInt(String(q.page ?? '1'), 10) || 1)
  let limit = Number.parseInt(String(q.limit ?? '50'), 10) || 50
  if (limit < 1) limit = 50
  if (limit > 200) limit = 200

  const rows = listPages({ status, limit, offset: (page - 1) * limit })
  res.status(200).json({
    ok: true,
    pages: rows.map((r) => ({
      id: r.id,
      url: r.url,
      title: r.title,
      site: r.site,
      annotationCount: r.annotation_count,
      readStatus: r.read_status,
      updatedAt: toIso(r.updated_at),
      // 已导出（content_hash 非空）才有 markdown 文件，供扩展端展示/复制
      markdownPath: r.content_hash ? `content/${r.id}.md` : null,
    })),
    total: countPages(status),
    page,
    limit,
  })
})

// 读取页面导出的 Markdown 正文（specs/page-readlist 读取页面内容）
pagesRouter.get('/:id/content', (req, res) => {
  const page = getPageById(req.params.id)
  if (!page) {
    throw new ApiError(404, 'not_found', `页面不存在：${req.params.id}`)
  }
  const file = path.join(KB_HOME, 'content', `${req.params.id}.md`)
  let markdown: string
  try {
    markdown = fs.readFileSync(file, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      // 仅有标注、从未剪藏正文的页面
      throw new ApiError(404, 'not_found', `该页面未剪藏正文：${req.params.id}`)
    }
    throw err
  }
  res.status(200).json({ ok: true, pageId: req.params.id, title: page.title, markdown })
})

pagesRouter.put('/:id/read-status', (req, res) => {
  const status = (req.body ?? {}).status
  if (typeof status !== 'string' || !(READ_STATUSES as readonly string[]).includes(status)) {
    throw new ApiError(400, 'invalid_request', `status 必须是 ${READ_STATUSES.join(' / ')} 之一`)
  }
  const page = getPageById(req.params.id)
  if (!page) {
    throw new ApiError(404, 'not_found', `页面不存在：${req.params.id}`)
  }
  updateReadStatus(req.params.id, status)
  res.status(200).json({ ok: true, id: req.params.id, readStatus: status })
})

// 删除页面：先删库（FK 级联清 annotations/messages）后删文件；文件删除失败仅记日志，不反序产生坏引用（design 风险项）
pagesRouter.delete('/:id', (req, res) => {
  const page = getPageById(req.params.id)
  if (!page) {
    throw new ApiError(404, 'not_found', `页面不存在：${req.params.id}`)
  }
  deletePage(req.params.id)
  for (const ext of ['.md', '.json', '.html']) {
    const file = path.join(KB_HOME, 'content', `${req.params.id}${ext}`)
    try {
      fs.unlinkSync(file)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error('[server] delete content file failed:', file, err)
      }
    }
  }
  res.status(200).json({ ok: true })
})
