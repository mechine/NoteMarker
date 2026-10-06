// notemarker 本地后端 REST 封装（design D4）：统一 request()（超时/离线判定）+ 各接口函数
import { getStorageItem } from './utils'

export type ApiResult = 'success' | 'failure' | 'offline'

const DEFAULT_BACKEND_URL = 'http://127.0.0.1:8765'

export const backendUrl = async (): Promise<string> => {
  return ((await getStorageItem('backendUrl')) as string | undefined) ?? DEFAULT_BACKEND_URL
}

interface RestResult<T> {
  offline: boolean
  status: number
  json: T | null
}
export type { RestResult }

async function request<T>(
  path: string,
  init: RequestInit = {},
  timeoutMs = 8000,
): Promise<RestResult<T>> {
  const base = await backendUrl()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(`${base}${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
      signal: controller.signal,
    })
    const json = (await res.json().catch(() => null)) as T | null
    return { offline: false, status: res.status, json }
  } catch {
    return { offline: true, status: 0, json: null }
  } finally {
    clearTimeout(timer)
  }
}

// ---------- /ping ----------

export interface PingInfo {
  ok: boolean
  version: string
  uptime: number
  dbPath: string
  outputDir: string
}

export async function ping(timeoutMs = 2000): Promise<{ online: boolean; info?: PingInfo }> {
  const r = await request<PingInfo>('/ping', { method: 'GET' }, timeoutMs)
  if (r.offline || !r.json?.ok) return { online: false }
  return { online: true, info: r.json }
}

// ---------- /config ----------

export interface KbConfig {
  outputDir: string
  dedupeWindow: number
  maxCacheSize: number
  autoExportEnabled: boolean
  autoExportDelay: number
}

export async function getConfig(): Promise<RestResult<KbConfig & { ok: boolean }>> {
  return request<KbConfig & { ok: boolean }>('/config')
}

export async function putConfig(
  patch: Partial<Pick<KbConfig, 'dedupeWindow' | 'maxCacheSize' | 'autoExportEnabled' | 'autoExportDelay'>>,
): Promise<RestResult<{ ok: boolean }>> {
  return request<{ ok: boolean }>('/config', { method: 'PUT', body: JSON.stringify(patch) })
}

// ---------- /export ----------

export interface ExportInput {
  pageUrl: string
  pageTitle: string
  html: string
}

export interface ExportOutcome {
  result: ApiResult
  pageId?: string
  /** 成功时的文件相对路径；skipped（内容未变化）时为既有文件 */
  filePath?: string
  duplicate?: boolean
  message?: string
}

export async function exportPage(input: ExportInput): Promise<ExportOutcome> {
  const r = await request<{
    ok: boolean
    skipped?: boolean
    pageId?: string
    existingFile?: string
    files?: { markdown?: string | null }
    message?: string
    error?: string
  }>('/export', {
    method: 'POST',
    body: JSON.stringify({
      trigger: 'extension-click',
      pageUrl: input.pageUrl,
      pageTitle: input.pageTitle,
      html: input.html,
      options: { saveHtml: false, saveJson: true, downloadImages: false },
    }),
  })
  if (r.offline) return { result: 'offline' }
  const j = r.json
  if (j?.ok) {
    return {
      result: 'success',
      pageId: j.pageId,
      duplicate: j.skipped === true,
      filePath: j.skipped ? j.existingFile : (j.files?.markdown ?? undefined),
    }
  }
  return { result: 'failure', message: j?.message ?? j?.error ?? `HTTP ${r.status}` }
}

// ---------- /annotations ----------

export interface Annotation {
  id: string
  messageId: string | null
  quote: string
  note: string
  type: string
  color: string
  createdAt: string
}

export async function listAnnotations(pageUrl: string): Promise<RestResult<{ ok: boolean; annotations: Annotation[] }>> {
  return request<{ ok: boolean; annotations: Annotation[] }>(
    `/annotations?pageUrl=${encodeURIComponent(pageUrl)}`,
  )
}

// ---------- /annotations 跨页查询（specs/annotations-api 跨页查询标注） ----------

/** 跨页列表项：按页查询字段 + 锚点上下文与来源页信息 */
export interface HistoryAnnotation extends Annotation {
  prefix: string | null
  suffix: string | null
  startOffset: number | null
  endOffset: number | null
  pageTitle: string | null
  site: string | null
  pageUrl: string
}

export interface HistoryAnnotationsResponse {
  ok: boolean
  annotations: HistoryAnnotation[]
  total: number
  limit: number
  offset: number
}

export interface HistoryQueryFilters {
  site?: string
  type?: string
  /** true 仅批注非空；false 仅批注为空 */
  hasNote?: boolean
  /** quote/note 子串搜索 */
  q?: string
  limit?: number
  offset?: number
}

export async function listHistoryAnnotations(
  filters: HistoryQueryFilters = {},
): Promise<RestResult<HistoryAnnotationsResponse>> {
  const params = new URLSearchParams()
  if (filters.site) params.set('site', filters.site)
  if (filters.type) params.set('type', filters.type)
  if (filters.hasNote !== undefined) params.set('hasNote', String(filters.hasNote))
  if (filters.q) params.set('q', filters.q)
  if (filters.limit !== undefined) params.set('limit', String(filters.limit))
  if (filters.offset !== undefined) params.set('offset', String(filters.offset))
  const qs = params.toString()
  return request<HistoryAnnotationsResponse>(`/annotations${qs ? `?${qs}` : ''}`)
}

// ---------- /annotations 同步（specs/annotations-api 批量同步） ----------

/** 批量 upsert 单条入参：与单条 POST /annotations 完全一致（含客户端 id） */
export interface SyncItemInput {
  id: string
  pageUrl: string
  pageTitle?: string
  quote: string
  prefix?: string | null
  suffix?: string | null
  startOffset?: number | null
  endOffset?: number | null
  note?: string
  type?: string
  color?: string
  /** 标注时间（ISO 8601）：服务端写入 created_at；缺省时服务端按当前时间写入（兼容旧客户端） */
  createdAt?: string
}

export interface SyncItemResult {
  index: number
  ok: boolean
  id?: string
  createdAt?: string
  updatedAt?: string
  deduped?: boolean
  error?: string
}

export async function syncAnnotationsBatch(
  items: SyncItemInput[],
): Promise<RestResult<{ ok: boolean; results: SyncItemResult[] }>> {
  return request<{ ok: boolean; results: SyncItemResult[] }>(
    '/annotations/batch',
    { method: 'POST', body: JSON.stringify({ annotations: items }) },
    30000,
  )
}

export async function deleteAnnotation(id: string): Promise<RestResult<{ ok: boolean }>> {
  return request<{ ok: boolean }>(`/annotations/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

/** 图片本地化上传（specs/clip-content 图片本地化）：base64 经 /images type:'blob' 落盘 */
export async function uploadImage(
  data: string,
  filename: string,
): Promise<RestResult<{ ok: boolean; hash: string; local: string; deduped: boolean }>> {
  return request<{ ok: boolean; hash: string; local: string; deduped: boolean }>(
    '/images',
    { method: 'POST', body: JSON.stringify({ type: 'blob', data, filename }) },
    30000,
  )
}

// ---------- /pages 阅读列表（specs/page-readlist） ----------

export interface PageListItem {
  id: string
  url: string
  title: string | null
  site: string | null
  annotationCount: number
  readStatus: string
  updatedAt: string
  markdownPath: string | null
}

export interface PageListResponse {
  ok: boolean
  pages: PageListItem[]
  total: number
  page: number
  limit: number
}

export async function listPages(opts: { status?: string; page?: number; limit?: number } = {}) {
  const params = new URLSearchParams()
  if (opts.status) params.set('status', opts.status)
  if (opts.page) params.set('page', String(opts.page))
  if (opts.limit) params.set('limit', String(opts.limit))
  return request<PageListResponse>(`/pages?${params.toString()}`)
}

export async function updatePageReadStatus(
  id: string,
  status: 'unread' | 'read' | 'archived',
): Promise<RestResult<{ ok: boolean }>> {
  return request<{ ok: boolean }>(`/pages/${encodeURIComponent(id)}/read-status`, {
    method: 'PUT',
    body: JSON.stringify({ status }),
  })
}

export async function deletePage(id: string): Promise<RestResult<{ ok: boolean }>> {
  return request<{ ok: boolean }>(`/pages/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

/** 用户改页面标题：页面在后端不存在时不代创建（applied:false），由首次标注同步携带 pageTitle 建页 */
export async function updatePageTitle(
  pageUrl: string,
  title: string,
): Promise<RestResult<{ ok: boolean; applied?: boolean }>> {
  return request<{ ok: boolean; applied?: boolean }>('/pages/title', {
    method: 'PUT',
    body: JSON.stringify({ pageUrl, title }),
  })
}

/** 阅读预览：读取页面导出的 Markdown 正文（specs/page-readlist 读取页面内容） */
export async function getPageContent(
  id: string,
): Promise<RestResult<{ ok: boolean; pageId: string; title: string | null; markdown: string }>> {
  return request<{ ok: boolean; pageId: string; title: string | null; markdown: string }>(
    `/pages/${encodeURIComponent(id)}/content`,
  )
}
