// 管理页：阅读列表（specs/extension-readlist）+ 历史标注（specs/annotation-history）+ 标注同步（specs/extension-sync）+ 设置（原有）
import {
  deletePage,
  getConfig,
  getPageContent,
  listHistoryAnnotations,
  listPages,
  ping,
  putConfig,
  updatePageReadStatus,
  type HistoryAnnotation,
  type HistoryQueryFilters,
  type PageListItem,
} from '../scripts/api'
import { listAll } from '../scripts/storage/annotations'
import { getCacheLimit, setCacheLimit } from '../scripts/storage/settings'
import { renderMarkdown, READER_CSS } from '../scripts/markdown-view'
import { getStorageItem, setStorage } from '../scripts/utils'
import { t, hydrate } from '../scripts/i18n'

hydrate(document.body) // 静态文案注入（specs extension-i18n）：module 加载即执行，DOM 已就绪

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

const backendUrlInput = $<HTMLInputElement>('backend-url')
const saveBackendBtn = $<HTMLButtonElement>('save-backend-btn')
const backendMsg = $<HTMLElement>('backend-msg')
const pingStatus = $<HTMLElement>('ping-status')
const quickstartCard = $<HTMLElement>('quickstart-card')
const saveConfigBtn = $<HTMLButtonElement>('save-config-btn')
const configMsg = $<HTMLElement>('config-msg')

const fields = {
  dedupeWindow: $<HTMLInputElement>('dedupe-window'),
  autoExportDelay: $<HTMLInputElement>('auto-export-delay'),
  maxCacheSize: $<HTMLInputElement>('max-cache-size'),
  autoExportEnabled: $<HTMLInputElement>('auto-export-enabled'),
}

function showMsg(el: HTMLElement, text: string, ok: boolean) {
  el.textContent = text
  el.className = `msg ${ok ? 'ok' : 'err'}`
}

// ---------- 视图切换 ----------

const VIEW_IDS = ['readlist', 'annotations', 'sync', 'settings'] as const
type ViewId = (typeof VIEW_IDS)[number]

function switchView(view: ViewId): void {
  for (const v of VIEW_IDS) {
    $(`view-${v}`).hidden = v !== view
    document.querySelector(`nav button[data-view="${v}"]`)?.classList.toggle('active', v === view)
  }
  if (view === 'readlist') void loadReadlist()
  if (view === 'annotations') void loadHistory(true)
  if (view === 'sync') void loadSyncItems()
}

document.querySelectorAll('nav button[data-view]').forEach((btn) => {
  btn.addEventListener('click', () => switchView(btn.getAttribute('data-view') as ViewId))
})

// ---------- 阅读列表 ----------

const readlistItems = $<HTMLElement>('readlist-items')
const readlistOffline = $<HTMLElement>('readlist-offline')
const readlistMsg = $<HTMLElement>('readlist-msg')
const readlistPageInfo = $<HTMLElement>('readlist-pageinfo')
const readlistFilter = $<HTMLSelectElement>('readlist-filter')
const readlistPrev = $<HTMLButtonElement>('readlist-prev')
const readlistNext = $<HTMLButtonElement>('readlist-next')

const readlistState = { page: 1, total: 0 }
const PAGE_SIZE = 20

const STATUS_LABEL: Record<string, string> = {
  unread: t('options_filter_unread'),
  read: t('options_filter_read'),
  archived: t('options_filter_archived'),
}
const COLOR_HEX: Record<string, string> = {
  yellow: '#f5c518',
  green: '#2ecc71',
  blue: '#2f80ed',
  pink: '#ff69b4',
  red: '#ff453a',
}

/** 标注类型显示名（列表/详情/导出共用） */
function annTypeLabel(type: string): string {
  return type === 'underline'
    ? t('options_type_underline')
    : type === 'image'
      ? t('options_type_image')
      : t('options_type_highlight')
}

function fmtDate(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString()
}

async function loadReadlist(): Promise<void> {
  readlistOffline.hidden = true
  readlistItems.textContent = t('options_loading')
  readlistMsg.textContent = ''
  const status = readlistFilter.value || undefined
  const r = await listPages({ status, page: readlistState.page, limit: PAGE_SIZE })
  if (r.offline || !r.json?.ok) {
    readlistItems.textContent = ''
    readlistOffline.hidden = false
    return
  }
  readlistState.total = r.json.total
  renderReadlist(r.json.pages)
}

function renderReadlist(pages: PageListItem[]): void {
  readlistItems.textContent = ''
  if (!pages.length) {
    readlistItems.textContent = t('options_readlist_empty')
  }
  for (const p of pages) {
    const li = document.createElement('li')
    li.className = 'item'

    const line1 = document.createElement('div')
    line1.className = 'line1'
    const a = document.createElement('a')
    a.className = 'title'
    a.href = p.url
    a.target = '_blank'
    a.rel = 'noopener noreferrer'
    a.textContent = p.title || p.url
    const chip = document.createElement('span')
    chip.className = `chip ${p.readStatus}`
    chip.textContent = STATUS_LABEL[p.readStatus] ?? p.readStatus
    line1.append(a, chip)

    const meta = document.createElement('div')
    meta.className = 'meta'
    meta.textContent = `${p.site ?? ''} · ${fmtDate(p.updatedAt)} · ${t('options_ann_count', [String(p.annotationCount)])}`

    const ops = document.createElement('div')
    ops.className = 'ops'

    const readBtn = document.createElement('button')
    readBtn.textContent = p.readStatus === 'read' ? t('options_mark_unread') : t('options_mark_read')
    readBtn.addEventListener('click', () => void toggleRead(p, p.readStatus === 'read' ? 'unread' : 'read'))

    const archiveBtn = document.createElement('button')
    archiveBtn.textContent = p.readStatus === 'archived' ? t('options_unarchive') : t('options_archive')
    archiveBtn.addEventListener('click', () => void toggleRead(p, p.readStatus === 'archived' ? 'unread' : 'archived'))

    ops.append(readBtn, archiveBtn)

    // 预览入口（specs sidebar-settings-reader 管理页预览）：行下展开内嵌渲染
    const previewBtn = document.createElement('button')
    previewBtn.textContent = t('options_preview')
    previewBtn.addEventListener('click', () => void togglePreview(li, p))
    ops.append(previewBtn)

    if (p.markdownPath) {
      const pathBtn = document.createElement('button')
      pathBtn.textContent = t('options_copy_path')
      pathBtn.title = p.markdownPath
      pathBtn.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(p.markdownPath ?? '')
          showMsg(readlistMsg, t('options_copied'), true)
        } catch {
          showMsg(readlistMsg, t('options_copy_failed'), false)
        }
      })
      ops.append(pathBtn)
    }

    const delBtn = document.createElement('button')
    delBtn.className = 'danger'
    delBtn.textContent = t('options_delete')
    delBtn.addEventListener('click', () => void removePage(p))
    ops.append(delBtn)

    li.append(line1, meta, ops)
    readlistItems.append(li)
  }

  const totalPages = Math.max(1, Math.ceil(readlistState.total / PAGE_SIZE))
  readlistPageInfo.textContent = t('options_pager_info', [
    String(readlistState.page),
    String(totalPages),
    String(readlistState.total),
  ])
  readlistPrev.disabled = readlistState.page <= 1
  readlistNext.disabled = readlistState.page >= totalPages
}

/** 行下内嵌预览（specs sidebar-settings-reader 管理页预览入口） */
async function togglePreview(li: HTMLLIElement, p: PageListItem): Promise<void> {
  let box = li.querySelector<HTMLElement>('.preview-box')
  if (box) {
    box.remove() // 再次点击收起
    return
  }
  box = document.createElement('div')
  box.className = 'preview-box reader-body'
  box.style.cssText = 'border:1px solid #d9d9d9;border-radius:4px;padding:10px 12px;margin-top:8px;max-height:420px;overflow:auto;'
  box.textContent = t('options_loading')
  li.append(box)
  const r = await getPageContent(p.id)
  if (r.offline || !r.json?.ok) {
    box.textContent = r.offline ? t('options_offline_short') : t('options_preview_no_content')
    return
  }
  renderMarkdown(box, r.json.markdown)
}

/** 状态流转：失败保持原状态展示并提示（specs/extension-readlist 标记阅读状态） */
async function toggleRead(p: PageListItem, status: 'unread' | 'read' | 'archived'): Promise<void> {
  const r = await updatePageReadStatus(p.id, status)
  if (r.offline || !r.json?.ok) {
    showMsg(readlistMsg, r.offline ? t('options_offline_short') : t('options_status_update_failed'), false)
    return
  }
  p.readStatus = status
  await loadReadlist()
}

/** 删除需确认：明确提示将删除后端记录与导出文件，不可恢复 */
async function removePage(p: PageListItem): Promise<void> {
  const label = p.title || p.url
  if (!window.confirm(t('options_delete_confirm', [label]))) {
    return
  }
  const r = await deletePage(p.id)
  if (r.offline || !r.json?.ok) {
    showMsg(readlistMsg, r.offline ? t('options_offline_short') : t('options_delete_failed'), false)
    return
  }
  await loadReadlist()
}

readlistFilter.addEventListener('change', () => {
  readlistState.page = 1
  void loadReadlist()
})
$<HTMLButtonElement>('readlist-refresh').addEventListener('click', () => void loadReadlist())
$<HTMLButtonElement>('readlist-retry').addEventListener('click', () => void loadReadlist())
readlistPrev.addEventListener('click', () => {
  if (readlistState.page > 1) {
    readlistState.page -= 1
    void loadReadlist()
  }
})
readlistNext.addEventListener('click', () => {
  readlistState.page += 1
  void loadReadlist()
})

// ---------- 标注同步视图（specs/extension-sync 同步状态可见） ----------

const syncItemsEl = $<HTMLElement>('sync-items')
const syncSummary = $<HTMLElement>('sync-summary')
const syncNowBtn = $<HTMLButtonElement>('sync-now')

async function loadSyncItems(): Promise<void> {
  syncItemsEl.textContent = t('options_loading')
  const all = await listAll()
  syncItemsEl.textContent = ''
  if (!all.length) {
    syncItemsEl.textContent = t('options_sync_empty')
  }
  const pendingCount = all.filter((a) => a.syncState === 'pending').length
  showMsg(
    syncSummary,
    pendingCount > 0 ? t('options_sync_pending_count', [String(pendingCount)]) : t('options_sync_all_synced'),
    pendingCount === 0,
  )

  for (const a of all.slice(0, 200)) {
    const li = document.createElement('li')
    li.className = 'item'

    const quote = document.createElement('div')
    quote.className = 'quote'
    const dot = document.createElement('span')
    dot.className = 'dot'
    dot.style.backgroundColor = COLOR_HEX[a.color] ?? '#999'
    quote.append(dot, ` ${a.quote.length > 80 ? `${a.quote.slice(0, 80)}…` : a.quote}`)

    const note = document.createElement('div')
    note.className = 'note'
    const stateChip = document.createElement('span')
    stateChip.className = `chip ${a.syncState}`
    stateChip.textContent = a.syncState === 'pending' ? t('options_chip_pending') : t('options_chip_synced')
    note.append(stateChip, ` ${annTypeLabel(a.type)} · ${fmtDate(new Date(a.updatedAt).toISOString())}${a.note ? ` · ${a.note.slice(0, 50)}` : ''}`)

    li.append(quote, note)
    syncItemsEl.append(li)
  }
}

async function runSyncFromPage(): Promise<void> {
  syncNowBtn.disabled = true
  showMsg(syncSummary, t('options_syncing'), true)
  let summary: { offline?: boolean; pushed?: number; failed?: number; deleted?: number; deleteFailed?: number }
  try {
    summary = await chrome.runtime.sendMessage({ action: 'sync' })
  } catch {
    summary = { offline: true }
  }
  syncNowBtn.disabled = false
  if (summary.offline) {
    showMsg(syncSummary, t('options_sync_failed_offline'), false)
  } else {
    const ok = (summary.failed ?? 0) + (summary.deleteFailed ?? 0) === 0
    const parts = [t('options_sync_pushed', [String(summary.pushed ?? 0)])]
    if (summary.failed) parts.push(t('options_sync_failed_n', [String(summary.failed)]))
    parts.push(t('options_sync_deleted', [String(summary.deleted ?? 0)]))
    if (summary.deleteFailed) parts.push(t('options_sync_delete_failed_n', [String(summary.deleteFailed)]))
    showMsg(syncSummary, `${t('options_sync_done_prefix')}${parts.join(t('options_sep'))}`, ok)
  }
  await loadSyncItems()
}

syncNowBtn.addEventListener('click', () => void runSyncFromPage())
$<HTMLButtonElement>('readlist-sync').addEventListener('click', () => void runSyncFromPage())

// ---------- 历史标注视图（specs/annotation-history）：跨页浏览 server 全部标注 ----------

const HIST_PAGE_SIZE = 50
/** 导出全量拉取的单页上限（server clamp 200） */
const HIST_EXPORT_PAGE = 200

const histItemsEl = $<HTMLElement>('annotations-items')
const histOfflineEl = $<HTMLElement>('annotations-offline')
const histMsgEl = $<HTMLElement>('annotations-msg')
const histSiteSel = $<HTMLSelectElement>('annotations-site-filter')
const histTypeSel = $<HTMLSelectElement>('annotations-type-filter')
const histNoteSel = $<HTMLSelectElement>('annotations-note-filter')
const histSearchInput = $<HTMLInputElement>('annotations-search')
const histMoreBtn = $<HTMLButtonElement>('annotations-more')
const histInfoEl = $<HTMLElement>('annotations-pageinfo')
const exportJsonBtn = $<HTMLButtonElement>('annotations-export-json')
const exportMdBtn = $<HTMLButtonElement>('annotations-export-md')
const detailDialog = $<HTMLDialogElement>('annotation-detail')

/** 列表会话状态：已加载条目 + 服务端总数 + 下一页偏移 */
const hist = { loaded: [] as HistoryAnnotation[], total: 0, offset: 0 }
/** 当前筛选是否命中数据（离线时导出不可用） */
let histOnline = false

/** 筛选条件（列表查询与导出共用同一参数源，specs 筛选与导出范围一致） */
function histFilters(): HistoryQueryFilters {
  return {
    site: histSiteSel.value || undefined,
    type: histTypeSel.value || undefined,
    hasNote: histNoteSel.value === '' ? undefined : histNoteSel.value === 'true',
    q: histSearchInput.value.trim() || undefined,
  }
}

/** 从响应收集站点下拉选项（保持当前选择） */
function collectSites(items: HistoryAnnotation[]): void {
  const known = new Set(Array.from(histSiteSel.options).map((o) => o.value))
  for (const a of items) {
    if (a.site && !known.has(a.site)) {
      known.add(a.site)
      histSiteSel.append(new Option(a.site, a.site))
    }
  }
}

function renderHistoryRow(a: HistoryAnnotation): HTMLLIElement {
  const li = document.createElement('li')
  li.className = 'item clickable'

  const line1 = document.createElement('div')
  line1.className = 'line1'
  const dot = document.createElement('span')
  dot.className = 'dot'
  dot.style.backgroundColor = COLOR_HEX[a.color] ?? '#999'
  const typeLabel = document.createElement('span')
  typeLabel.className = 'type-label'
  typeLabel.textContent = annTypeLabel(a.type)
  const quote = document.createElement('div')
  quote.className = 'hist-quote'
  quote.textContent = a.quote || t('options_empty_quote')
  quote.style.flex = '1'
  line1.append(dot, typeLabel, quote)

  const meta = document.createElement('div')
  meta.className = 'meta'
  meta.textContent = `${a.pageTitle || a.pageUrl} · ${a.site ?? ''} · ${fmtDate(a.createdAt)}`

  li.append(line1)
  if (a.note) {
    const note = document.createElement('div')
    note.className = 'note hist-note'
    note.textContent = a.note
    li.append(note)
  }
  li.addEventListener('click', () => openDetail(a))
  return li
}

function renderHistoryPager(): void {
  histInfoEl.textContent = t('options_hist_loaded', [String(hist.loaded.length), String(hist.total)])
  histMoreBtn.hidden = hist.loaded.length >= hist.total
}

/** reset=true 重新查询并清空列表；false 续拉下一页（specs 历史标注列表视图） */
async function loadHistory(reset: boolean): Promise<void> {
  if (reset) {
    hist.loaded = []
    hist.total = 0
    hist.offset = 0
    histItemsEl.textContent = t('options_loading')
  }
  const r = await listHistoryAnnotations({ ...histFilters(), limit: HIST_PAGE_SIZE, offset: hist.offset })
  if (r.offline || !r.json?.ok) {
    histOnline = false
    exportJsonBtn.disabled = true
    exportMdBtn.disabled = true
    histItemsEl.textContent = ''
    histOfflineEl.hidden = false
    return
  }
  histOnline = true
  exportJsonBtn.disabled = false
  exportMdBtn.disabled = false
  histOfflineEl.hidden = true
  if (reset) histItemsEl.textContent = ''
  collectSites(r.json.annotations)
  for (const a of r.json.annotations) {
    hist.loaded.push(a)
    histItemsEl.append(renderHistoryRow(a))
  }
  hist.total = r.json.total
  hist.offset += r.json.annotations.length
  if (!hist.loaded.length && reset) histItemsEl.textContent = t('options_hist_empty')
  renderHistoryPager()
}

histMoreBtn.addEventListener('click', () => void loadHistory(false))
$<HTMLButtonElement>('annotations-retry').addEventListener('click', () => void loadHistory(true))

// 筛选变更即重查（specs 筛选与搜索）；关键词输入 300ms 防抖
for (const sel of [histSiteSel, histTypeSel, histNoteSel]) {
  sel.addEventListener('change', () => void loadHistory(true))
}
let searchTimer: ReturnType<typeof setTimeout> | undefined
histSearchInput.addEventListener('input', () => {
  clearTimeout(searchTimer)
  searchTimer = setTimeout(() => void loadHistory(true), 300)
})

// ---------- 详情弹窗（specs/annotation-history 标注详情弹窗） ----------

let detailUrl = ''

function openDetail(a: HistoryAnnotation): void {
  detailUrl = a.pageUrl
  $<HTMLElement>('detail-meta').textContent = `${annTypeLabel(a.type)} · ${fmtDate(a.createdAt)}`
  $<HTMLElement>('detail-quote').textContent = a.quote || t('options_empty_quote')
  $<HTMLElement>('detail-prefix').textContent = a.prefix || a.suffix
    ? t('options_anchor_ctx', [a.prefix ?? '', a.suffix ?? ''])
    : ''
  $<HTMLElement>('detail-note').textContent = a.note ? t('options_note_prefix', [a.note]) : ''
  $<HTMLElement>('detail-page').textContent = t('options_source_prefix', [a.pageTitle || a.pageUrl])
  detailDialog.showModal()
}

$<HTMLButtonElement>('detail-close').addEventListener('click', () => detailDialog.close())
$<HTMLButtonElement>('detail-open-page').addEventListener('click', () => {
  if (detailUrl) void chrome.tabs.create({ url: detailUrl })
})

// ---------- 导出（specs/annotation-history 导出筛选结果）：拉全量后 Blob 下载 ----------

/** 循环分页拉取当前筛选命中的全部记录（specs：导出覆盖全部命中，不受已加载分页限制） */
async function fetchAllForExport(): Promise<HistoryAnnotation[] | null> {
  const all: HistoryAnnotation[] = []
  let offset = 0
  // 上限保护：total 极端异常（如 0 但有数据）时以空页终止
  for (let guard = 0; guard < 500; guard++) {
    const r = await listHistoryAnnotations({ ...histFilters(), limit: HIST_EXPORT_PAGE, offset })
    if (r.offline || !r.json?.ok) return null
    all.push(...r.json.annotations)
    offset += r.json.annotations.length
    if (r.json.annotations.length === 0 || all.length >= r.json.total) break
  }
  return all
}

function downloadFile(filename: string, text: string, mime: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: mime }))
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function exportStamp(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

/** Markdown：按来源页分组，组头标题+链接，每条引用/批注/类型/时间（字面嵌入，不做 MD 解析） */
function toMarkdown(items: HistoryAnnotation[]): string {
  const lines: string[] = [
    t('options_md_title'),
    '',
    t('options_md_count', [String(items.length), new Date().toISOString()]),
    '',
  ]
  const byPage = new Map<string, HistoryAnnotation[]>()
  for (const a of items) {
    const list = byPage.get(a.pageUrl) ?? []
    list.push(a)
    byPage.set(a.pageUrl, list)
  }
  for (const [pageUrl, list] of byPage) {
    const title = list[0].pageTitle || pageUrl
    lines.push(`## ${title}`, '', `<${pageUrl}>`, '')
    for (const a of list) {
      lines.push(`- ${annTypeLabel(a.type)} · ${fmtDate(a.createdAt)}`)
      lines.push(`  > ${a.quote}`)
      if (a.note) lines.push(`  ${t('options_note_prefix', [a.note])}`)
    }
    lines.push('')
  }
  return lines.join('\n')
}

async function runExport(format: 'json' | 'md'): Promise<void> {
  if (!histOnline) {
    showMsg(histMsgEl, t('options_export_offline'), false)
    return
  }
  exportJsonBtn.disabled = true
  exportMdBtn.disabled = true
  const items = await fetchAllForExport()
  exportJsonBtn.disabled = false
  exportMdBtn.disabled = false
  if (items === null) {
    showMsg(histMsgEl, t('options_export_failed_offline'), false)
    return
  }
  if (!items.length) {
    showMsg(histMsgEl, t('options_export_empty'), false)
    return
  }
  if (format === 'json') {
    downloadFile(`notemarker-annotations-${exportStamp()}.json`, JSON.stringify(items, null, 2), 'application/json')
  } else {
    downloadFile(`notemarker-annotations-${exportStamp()}.md`, toMarkdown(items), 'text/markdown')
  }
  showMsg(histMsgEl, t('options_export_done', [String(items.length)]), true)
}

exportJsonBtn.addEventListener('click', () => void runExport('json'))
exportMdBtn.addEventListener('click', () => void runExport('md'))

// ---------- 设置（原有逻辑） ----------

async function refreshPing() {
  pingStatus.className = ''
  pingStatus.textContent = t('options_checking')
  const { online, info } = await ping()
  quickstartCard.hidden = online
  if (online && info) {
    pingStatus.className = 'online'
    pingStatus.textContent =
      `${t('options_ping_online', [info.version])}\nuptime: ${info.uptime}s\ndb: ${info.dbPath}\noutput: ${info.outputDir}`
  } else {
    pingStatus.className = 'offline'
    pingStatus.textContent = t('options_ping_offline')
  }
}

async function loadConfigForm() {
  const r = await getConfig()
  if (r.offline || !r.json?.ok) return
  fields.dedupeWindow.value = String(r.json.dedupeWindow)
  fields.autoExportDelay.value = String(r.json.autoExportDelay)
  fields.maxCacheSize.value = String(r.json.maxCacheSize)
  fields.autoExportEnabled.checked = r.json.autoExportEnabled === true
}

async function init() {
  // 阅读排版样式（预览渲染共用）
  {
    const st = document.createElement('style')
    st.textContent = READER_CSS
    document.head.appendChild(st)
  }
  backendUrlInput.value = ((await getStorageItem('backendUrl')) as string) ?? 'http://127.0.0.1:8765'

  saveBackendBtn.addEventListener('click', async () => {
    const url = backendUrlInput.value.trim().replace(/\/+$/, '')
    await setStorage({ backendUrl: url })
    showMsg(backendMsg, t('options_saved'), true)
    await refreshPing()
    await loadConfigForm()
  })

  saveConfigBtn.addEventListener('click', async () => {
    const patch = {
      dedupeWindow: Number(fields.dedupeWindow.value),
      autoExportDelay: Number(fields.autoExportDelay.value),
      maxCacheSize: Number(fields.maxCacheSize.value),
      autoExportEnabled: fields.autoExportEnabled.checked,
    }
    const r = await putConfig(patch)
    if (r.offline) {
      showMsg(configMsg, t('options_offline_short'), false)
      return
    }
    if (r.json?.ok) {
      showMsg(configMsg, t('options_saved'), true)
    } else {
      const j = r.json as { message?: string; error?: string } | null
      showMsg(configMsg, j?.message ?? j?.error ?? `HTTP ${r.status}`, false)
    }
  })

  await refreshPing()
  await loadConfigForm()
  $<HTMLButtonElement>('ping-retry').addEventListener('click', () => void refreshPing())

  // 本地缓存上限（specs/extension-sync 本地缓存上限）：空/非法回落 10000
  const cacheLimitInput = $<HTMLInputElement>('cache-limit')
  const cacheLimitMsg = $<HTMLElement>('cache-limit-msg')
  cacheLimitInput.value = String(await getCacheLimit())
  $<HTMLButtonElement>('save-cache-limit-btn').addEventListener('click', async () => {
    const n = Number(cacheLimitInput.value)
    if (!cacheLimitInput.value.trim() || !Number.isFinite(n) || n < 0) {
      showMsg(cacheLimitMsg, t('options_cache_invalid'), false)
      return
    }
    await setCacheLimit(n)
    cacheLimitInput.value = String(await getCacheLimit())
    showMsg(cacheLimitMsg, t('options_saved'), true)
  })

  // 默认视图：阅读列表；?view=settings 支持安装引导直达设置视图
  const paramView = new URLSearchParams(location.search).get('view') as ViewId | null
  switchView(paramView && VIEW_IDS.includes(paramView) ? paramView : 'readlist')
}

document.addEventListener('DOMContentLoaded', () => {
  void init()
})
