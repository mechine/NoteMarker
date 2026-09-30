import { createHash } from 'node:crypto'

export function sha256(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex')
}

/**
 * URL 规范化（去重链第一层，见 design D3）：
 * - 解析失败抛 SyntaxError（由调用方转 400）
 * - 去 fragment（hash）
 * - host 小写（WHATWG URL 已保证）
 * - pathname 去末尾多余的 '/'（根路径 '/' 保留）
 * - query 原样保留（聊天页 query 常含会话 ID，丢弃会造成不同会话误合并）
 */
export function normalizeUrl(input: string): string {
  const u = new URL(input)
  u.hash = ''
  if (u.pathname !== '/') {
    u.pathname = u.pathname.replace(/\/+$/, '') || '/'
  }
  return u.toString()
}

export function urlHashOf(input: string): string {
  return sha256(normalizeUrl(input))
}

export function siteOf(input: string): string {
  try {
    return new URL(input).hostname
  } catch {
    return ''
  }
}
