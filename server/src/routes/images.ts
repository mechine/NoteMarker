import fs from 'node:fs'
import path from 'node:path'
import { Router } from 'express'
import { KB_HOME } from '../env'
import { ApiError } from '../errors'
import { findImageByHash } from '../db/repositories/images'
import { storeImage } from '../services/images'

export const imagesRouter = Router()

imagesRouter.post('/', async (req, res, next) => {
  try {
    const { hash, local, deduped } = await storeImage(req.body ?? {})
    res.status(200).json({ ok: true, hash, local, uploaded: null, deduped })
  } catch (err) {
    next(err)
  }
})

// 读取图片内容（specs/image-store 读取图片内容）：按 hash 回传文件字节，纯读取代理
imagesRouter.get('/:hashAndExt', (req, res) => {
  const raw = String(req.params.hashAndExt ?? '')
  // 允许带扩展名（markdown 相对路径形态 images/{hash}.{ext}），按 . 分离
  const dot = raw.lastIndexOf('.')
  const hash = dot === -1 ? raw : raw.slice(0, dot)
  if (!/^[0-9a-f]{64}$/i.test(hash)) {
    throw new ApiError(400, 'invalid_request', `hash 格式不合法：${raw}`)
  }
  const row = findImageByHash(hash)
  if (!row) {
    throw new ApiError(404, 'not_found', `图片不存在：${hash}`)
  }
  const ext = extOfMime(row.mime_type)
  const file = path.join(KB_HOME, 'content', 'images', `${hash}.${ext}`)
  fs.readFile(file, (err, data) => {
    if (err) {
      // 回调内 throw 会变 uncaughtException 直接打挂进程（KB_HOME/content 被删即触发）——
      // 这里必须直接回响应，语义与 sync 路径的 404 统一错误格式一致
      res.status(404).json({ ok: false, error: 'not_found', message: `图片文件缺失：${hash}` })
      return
    }
    res.status(200).type(row.mime_type ?? 'application/octet-stream').send(data)
  })
})

imagesRouter.get('/', (req, res) => {
  const hash = req.query.hash
  if (typeof hash !== 'string' || !hash) {
    res.status(400).json({ ok: false, error: 'invalid_request', message: '缺少 hash 查询参数' })
    return
  }
  const row = findImageByHash(hash)
  if (!row) {
    res.status(200).json({ ok: true, exists: false })
    return
  }
  const ext = extOfMime(row.mime_type)
  res.status(200).json({
    ok: true,
    exists: true,
    local: `content/images/${row.hash}.${ext}`,
    uploaded: row.uploaded_url,
  })
})

function extOfMime(mimeType: string | null): string {
  if (!mimeType) return 'bin'
  const map: Record<string, string> = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/svg+xml': 'svg',
  }
  return map[mimeType] ?? 'bin'
}
