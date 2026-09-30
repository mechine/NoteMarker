// background 消息载荷类型与守卫（直连剪藏路径：content.js 采集结果 → POST /export）
// toast 工具条相关类型已随 toast 一并移除（specs remove-clip-toast）
export interface PageSavePayload {
  url: string
  title: string
  html: string
}

export function isPageSavePayload(v: unknown): v is PageSavePayload {
  if (typeof v !== 'object' || v === null) return false
  const p = v as Record<string, unknown>
  return typeof p.url === 'string' && typeof p.title === 'string' && typeof p.html === 'string'
}
