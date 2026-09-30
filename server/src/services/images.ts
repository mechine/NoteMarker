import fs from 'node:fs'
import path from 'node:path'
import { KB_HOME } from '../env'
import { ApiError } from '../errors'
import { findImageByHash, insertImage } from '../db/repositories/images'
import { sha256 } from './url'

const MAX_IMAGE_BYTES = 10 * 1024 * 1024

const EXT_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
}

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
}

export const IMAGES_DIR = path.join(KB_HOME, 'content', 'images')

export interface StoreImageInput {
  type: string
  original?: string
  data?: string
  filename?: string
  alt?: string
}

export interface StoreImageResult {
  hash: string
  local: string
  deduped: boolean
}

/** 接收图片（url 下载 / blob 解码）→ sha256 去重 → 落盘 content/images/{hash}.{ext}（specs/image-store） */
export async function storeImage(input: StoreImageInput): Promise<StoreImageResult> {
  let buffer: Buffer
  let mimeType: string

  if (input.type === 'url') {
    if (typeof input.original !== 'string' || !input.original) {
      throw new ApiError(400, 'invalid_request', 'type=url 时 original 不能为空')
    }
    let res: Response
    try {
      res = await fetch(input.original)
    } catch {
      throw new ApiError(502, 'upstream_failed', `图片下载失败：${input.original}`)
    }
    if (!res.ok) {
      throw new ApiError(502, 'upstream_failed', `图片下载返回 ${res.status}：${input.original}`)
    }
    buffer = Buffer.from(await res.arrayBuffer())
    mimeType = (res.headers.get('content-type') ?? '').split(';')[0].trim() || 'application/octet-stream'
  } else if (input.type === 'blob') {
    if (typeof input.data !== 'string' || !input.data) {
      throw new ApiError(400, 'invalid_request', 'type=blob 时 data（base64）不能为空')
    }
    buffer = Buffer.from(input.data, 'base64')
    if (!buffer.length) {
      throw new ApiError(400, 'invalid_request', 'base64 数据解码后为空')
    }
    const ext = input.filename?.includes('.') ? input.filename.split('.').pop()!.toLowerCase() : ''
    mimeType = MIME_BY_EXT[ext] ?? 'application/octet-stream'
  } else {
    throw new ApiError(400, 'invalid_request', `不支持的图片 type：${input.type}`)
  }

  if (buffer.length > MAX_IMAGE_BYTES) {
    throw new ApiError(413, 'payload_too_large', '单张图片超过 10 MB 上限')
  }

  const hash = sha256(buffer)
  const existing = findImageByHash(hash)
  if (existing) {
    const existingExt = extOf(existing.mime_type)
    const existingFile = path.join(IMAGES_DIR, `${hash}.${existingExt}`)
    // 自愈：库里有记录但文件丢了（KB_HOME/content 运行中被删）——重写文件而非空手 dedupe，
    // 否则该 hash 永远 404（GET /images/:hash 只认文件）
    if (!fs.existsSync(existingFile)) {
      fs.mkdirSync(IMAGES_DIR, { recursive: true })
      fs.writeFileSync(existingFile, buffer)
    }
    return { hash, local: localPathOf(hash, existingExt), deduped: true }
  }

  const ext = extOf(mimeType)
  fs.mkdirSync(IMAGES_DIR, { recursive: true })
  fs.writeFileSync(path.join(IMAGES_DIR, `${hash}.${ext}`), buffer)
  insertImage({
    hash,
    originalUrl: input.type === 'url' ? input.original : null,
    filename: input.filename ?? null,
    mimeType,
    sizeBytes: buffer.length,
  })
  return { hash, local: localPathOf(hash, ext), deduped: false }
}

function extOf(mimeType: string | null): string {
  if (!mimeType) return 'bin'
  return EXT_BY_MIME[mimeType] ?? 'bin'
}

function localPathOf(hash: string, ext: string): string {
  return `content/images/${hash}.${ext}`
}
