import { Router } from 'express'
import { ApiError } from '../errors'
import { findOrCreatePage } from '../db/repositories/pages'
import {
  findMessage,
  insertMessage,
  listMessagesByPage,
  updateMessageContent,
} from '../db/repositories/messages'
import { findPageByUrlHash } from '../db/repositories/pages'
import { normalizeUrl, sha256, siteOf } from '../services/url'
import { markSidecarDirty } from '../services/sidecar'

export const messagesRouter = Router()

messagesRouter.post('/', (req, res) => {
  const body = req.body ?? {}
  const { pageUrl, messageId, text } = body
  if (typeof pageUrl !== 'string' || !pageUrl.trim()) {
    throw new ApiError(400, 'invalid_request', 'pageUrl 不能为空')
  }
  if (typeof messageId !== 'string' || !messageId) {
    throw new ApiError(400, 'invalid_request', 'messageId 不能为空')
  }
  if (typeof text !== 'string' || !text) {
    throw new ApiError(400, 'invalid_request', 'text 不能为空')
  }
  let url: string
  try {
    url = normalizeUrl(pageUrl)
  } catch {
    throw new ApiError(400, 'invalid_request', `pageUrl 无法解析：${pageUrl}`)
  }
  const page = findOrCreatePage({ url, urlHash: sha256(url), site: siteOf(url) })
  const contentHash =
    typeof body.contentHash === 'string' && body.contentHash ? body.contentHash : sha256(text)

  const existing = findMessage(page.id, messageId)
  if (existing) {
    if (existing.content_hash === contentHash) {
      res.status(200).json({ ok: true, id: existing.id, deduped: true })
      return
    }
    updateMessageContent(existing.id, text, contentHash)
    markSidecarDirty(page.id)
    res.status(200).json({ ok: true, id: existing.id, deduped: false })
    return
  }

  const id = insertMessage({
    pageId: page.id,
    messageId,
    role: typeof body.role === 'string' ? body.role : null,
    text,
    contentHash,
    sequence: typeof body.sequence === 'number' ? body.sequence : null,
  })
  markSidecarDirty(page.id)
  res.status(200).json({ ok: true, id, deduped: false })
})

messagesRouter.get('/', (req, res) => {
  const pageUrl = req.query.pageUrl
  if (typeof pageUrl !== 'string' || !pageUrl) {
    res.status(400).json({ ok: false, error: 'invalid_request', message: '缺少 pageUrl 查询参数' })
    return
  }
  let url: string
  try {
    url = normalizeUrl(pageUrl)
  } catch {
    res.status(400).json({ ok: false, error: 'invalid_request', message: `pageUrl 无法解析：${pageUrl}` })
    return
  }
  const page = findPageByUrlHash(sha256(url))
  const rows = page ? listMessagesByPage(page.id) : []
  res.status(200).json({
    ok: true,
    messages: rows.map((m) => ({
      messageId: m.message_id,
      role: m.role,
      text: m.text,
      contentHash: m.content_hash,
      capturedAt: `${m.captured_at.replace(' ', 'T')}Z`,
    })),
  })
})
