// 标注侧栏（specs/extension-side-panel）：当前页标注总览/编辑/定位，剪藏与同步入口。
// 面板是扩展页，直接 import 共享本地库（design D2）；页面操作全部经 tabs.sendMessage 驱动划线脚本。
import {
  countPending,
  listByPage,
  normalizePageUrl,
  softDelete,
  update,
  type LocalAnnotation,
} from '../scripts/storage/annotations'
import {
  COLOR_SLOTS,
  getColorPalette,
  getClipRule,
  getMaster,
  getShowMarks,
  isSiteDisabled,
  originOf,
  paletteHex,
  setColorPalette,
  setClipRule,
  setMaster,
  setSiteDisabled,
  setShowMarks,
} from '../scripts/storage/settings'
import { getPageContent, listPages, ping, type PageListItem } from '../scripts/api'
import { renderMarkdown, READER_CSS } from '../scripts/markdown-view'
import { backendUrl } from '../scripts/api'
import { getStorageItem, setStorage } from '../scripts/utils'
import { t, hydrate } from '../scripts/i18n'

hydrate(document.body) // 静态文案注入（specs extension-i18n）：module 加载即执行，DOM 已就绪

const COLORS = COLOR_SLOTS
/** 当前调色板（refresh 时从设置读取） */
let palette: string[] = ['#ffd234', '#34c759', '#2f80ed', '#ff69b4', '#ff453a']

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const itemsEl = $<HTMLElement>('items')
const msgEl = $<HTMLElement>('msg')
const countEl = $<HTMLElement>('pending-count')
const clipBtn = $<HTMLButtonElement>('clip-btn')
const syncBtn = $<HTMLButtonElement>('sync-btn')
const unsupportedEl = $<HTMLElement>('unsupported')
const shotBtn = $<HTMLButtonElement>('shot-btn')
const siteToggle = $<HTMLInputElement>('site-toggle')
const marksToggle = $<HTMLInputElement>('marks-toggle')

function showMsg(text: string, ok: boolean) {
  msgEl.textContent = text
  msgEl.className = `msg ${ok ? 'ok' : 'err'}`
  setTimeout(() => {
    if (msgEl.textContent === text) msgEl.textContent = ''
  }, 4000)
}

// ---------- 三标签页（specs/extension-side-panel 三标签页结构） ----------

const VIEW_IDS = ['marks', 'preview', 'config'] as const
type ViewId = (typeof VIEW_IDS)[number]
/** 面板会话内保持当前标签；数据刷新不切标签 */
let activeView: ViewId = 'marks'

function switchView(view: ViewId): void {
  activeView = view
  for (const v of VIEW_IDS) {
    $(`view-${v}`).hidden = v !== view
    document.querySelector(`nav button[data-view="${v}"]`)?.classList.toggle('active', v === view)
  }
  closeReader() // 切标签收起阅读预览
}

document.querySelectorAll('nav button[data-view]').forEach((btn) => {
  btn.addEventListener('click', () => switchView(btn.getAttribute('data-view') as ViewId))
})

function fmtDate(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString()
}

// ---------- 活动标签页 ----------

interface ActiveTab {
  id: number
  url: string
}

/**
 * 活动标签状态（点击激活模型）：
 * - 'no-access'：此标签尚未点击过图标（无 activeTab 授权），连 URL 都读不到——提示激活并轮询等待
 * - null：URL 可见但非 http/https（chrome://、file:// 等），真·不支持划线
 */
async function activeTab(): Promise<ActiveTab | 'no-access' | null> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (!tab?.id) return null
  if (typeof tab.url !== 'string') return 'no-access'
  if (!/^https?:/i.test(tab.url)) return null // chrome:// 等不支持注入的页面
  return { id: tab.id, url: normalizePageUrl(tab.url) }
}

/** 激活轮询：当前标签未授权时等待用户点击图标（activeTab 落地后 URL 变可见），随即自动激活划线 */
let activationPoll: ReturnType<typeof setInterval> | undefined

function startActivationPoll(): void {
  if (activationPoll) return
  activationPoll = setInterval(() => {
    void (async () => {
      const tab = await activeTab()
      if (tab !== 'no-access') {
        stopActivationPoll()
        void activateHighlighter()
        void refresh()
      }
    })()
  }, 1200)
}

function stopActivationPoll(): void {
  if (activationPoll) {
    clearInterval(activationPoll)
    activationPoll = undefined
  }
}

// ---------- 列表渲染（编辑中条目保留草稿，design D5） ----------

/** 编辑态：id → { note 草稿, color, type }；refresh 重建后恢复 */
const editing = new Map<string, { note: string; color: string; type: 'highlight' | 'underline' }>()

let currentUrl = ''
/** 后端基址缓存（refresh 时刷新；截图缩略图 URL 拼接用，specs/screenshot-annotation） */
let backendBase = ''

async function refresh(): Promise<void> {
  const res = await activeTab()
  const noAccess = res === 'no-access'
  const tab = noAccess ? null : res
  currentUrl = tab?.url ?? ''
  const supported = tab !== null
  if (noAccess) {
    // 未激活：区别于真不支持（chrome:// 等）；提示点图标并轮询，授权落地后自动激活
    unsupportedEl.hidden = false
    unsupportedEl.textContent = t('sidepanel_not_activated')
    startActivationPoll()
  } else {
    stopActivationPoll()
    unsupportedEl.hidden = supported
    if (!supported) unsupportedEl.textContent = t('sidepanel_unsupported')
  }
  shotBtn.disabled = !supported // 未激活/不支持注入的页面禁用截图入口
  backendBase = await backendUrl()
  itemsEl.textContent = ''
  // 列表渲染先行；辅助刷新独立容错，任一失败不影响主体列表
  void refreshToggles(tab).catch(() => {})
  void refreshRuleInput(tab).catch(() => {})

  if (!supported) {
    if (!currentUrl) return
    // 非 http 页面也可能有历史标注（不太可能），仍尝试展示
  }

  const list = currentUrl ? await listByPage(currentUrl) : []
  for (const a of list) itemsEl.append(renderItem(a, tab?.id))
  if (!list.length && supported) {
    const li = document.createElement('li')
    li.className = 'item'
    li.textContent = t('sidepanel_marks_empty')
    itemsEl.append(li)
  }

  const n = await countPending()
  countEl.hidden = n === 0
  countEl.textContent = t('sidepanel_pending_count', [String(n)])
}

function renderItem(a: LocalAnnotation, tabId: number | undefined): HTMLLIElement {
  const li = document.createElement('li')
  li.className = 'item'
  li.dataset.id = a.id

  const quote = document.createElement('div')
  quote.className = 'quote'
  // 图片标注条目（specs image-annotation）：🖼 图 · alt/文件名；已自动存图者附标记
  // 截图条目（specs/screenshot-annotation）：📷 摘要 + 缩略图，无页内定位
  if (a.type === 'image') {
    quote.textContent = `🖼 ${t('sidepanel_img_quote', [a.quote])}${a.imgLocal ? t('sidepanel_img_saved') : ''}`
    quote.title = t('sidepanel_locate_hint')
  } else if (a.type === 'screenshot') {
    quote.textContent = `📷 ${a.quote}`
    quote.title = t('sidepanel_shot_title')
  } else {
    quote.textContent = a.quote
    quote.title = t('sidepanel_locate_hint')
  }

  /** 截图缩略图：imgLocal → 后端 /images/{hash}；无副本占位（specs/screenshot-annotation） */
  const thumb = document.createElement('div')
  if (a.type === 'screenshot') {
    thumb.className = 'shot-thumb'
    const m = /([0-9a-f]{64})\.\w+$/.exec(a.imgLocal ?? '')
    if (m) {
      const img = document.createElement('img')
      img.alt = a.quote
      img.src = `${backendBase}/images/${m[1]}`
      thumb.append(img)
    } else {
      thumb.textContent = t('sidepanel_no_image')
    }
  }

  const note = document.createElement('div')
  note.className = 'note'
  note.textContent = a.note || t('sidepanel_no_note')

  const meta = document.createElement('div')
  meta.className = 'meta'
  if (typeof a.seq === 'number') {
    const no = document.createElement('span')
    no.textContent = `№${a.seq}`
    no.style.fontWeight = '600'
    meta.append(no)
  }
  const dot = document.createElement('span')
  dot.className = 'dot'
  dot.style.backgroundColor = paletteHex(palette, a.color)
  const chip = document.createElement('span')
  chip.className = `chip ${a.syncState}`
  chip.textContent = a.syncState === 'pending' ? t('sidepanel_chip_pending') : t('sidepanel_chip_synced')
  const typeLabel = document.createElement('span')
  typeLabel.textContent =
    a.type === 'underline'
      ? t('options_type_underline')
      : a.type === 'image'
        ? t('options_type_image')
        : a.type === 'screenshot'
          ? t('sidepanel_type_screenshot')
          : t('options_type_highlight')
  meta.append(dot, typeLabel, chip)

  const ops = document.createElement('div')
  ops.className = 'ops'
  const editBtn = document.createElement('button')
  editBtn.textContent = t('sidepanel_edit')
  const delBtn = document.createElement('button')
  delBtn.className = 'danger'
  delBtn.textContent = t('sidepanel_delete')
  ops.append(editBtn, delBtn)

  const editbox = document.createElement('div')
  editbox.className = 'editbox'
  editbox.hidden = true

  li.append(quote, ...(a.type === 'screenshot' ? [thumb] : []), note, meta, ops, editbox)

  // 点击条目正文 → 跳转定位（specs/extension-side-panel 跳转定位）；截图条目无页内锚点不定位
  if (a.type !== 'screenshot') {
    quote.addEventListener('click', () => void focusAnnotation(a.id, tabId))
    note.addEventListener('click', () => void focusAnnotation(a.id, tabId))
  }

  editBtn.addEventListener('click', () => {
    if (!editbox.hidden) {
      editbox.hidden = true
      editing.delete(a.id)
      return
    }
    openEditor(editbox, a, tabId)
  })

  delBtn.addEventListener('click', () => void removeAnnotation(a, tabId))

  // refresh 重建后恢复编辑态与草稿
  if (editing.has(a.id)) openEditor(editbox, a, tabId)

  return li
}

function openEditor(editbox: HTMLElement, a: LocalAnnotation, tabId: number | undefined): void {
  const draft = editing.get(a.id) ?? { note: a.note, color: a.color, type: a.type }
  editing.set(a.id, draft)
  editbox.textContent = ''

  const textarea = document.createElement('textarea')
  textarea.value = draft.note
  textarea.placeholder = t('sidepanel_note_ph')
  textarea.addEventListener('input', () => {
    draft.note = textarea.value
  })
  textarea.addEventListener('keydown', (e) => {
    e.stopPropagation()
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void saveDraft(a, draft, tabId, editbox)
    if (e.key === 'Escape') {
      editing.delete(a.id)
      editbox.hidden = true
    }
  })

  const colors = document.createElement('div')
  colors.className = 'colors'
  const swatches: HTMLElement[] = []
  for (const c of COLORS) {
    const s = document.createElement('span')
    s.className = 'swatch'
    s.style.background = paletteHex(palette, c)
    if (c === draft.color) s.classList.add('active')
    s.addEventListener('click', () => {
      draft.color = c
      swatches.forEach((x) => x.classList.toggle('active', x === s))
    })
    swatches.push(s)
    colors.append(s)
  }

  const row = document.createElement('div')
  row.className = 'ops'
  const saveBtn = document.createElement('button')
  saveBtn.className = 'primary'
  saveBtn.textContent = t('sidepanel_save')
  saveBtn.addEventListener('click', () => void saveDraft(a, draft, tabId, editbox))
  const cancelBtn = document.createElement('button')
  cancelBtn.textContent = t('sidepanel_cancel')
  cancelBtn.addEventListener('click', () => {
    editing.delete(a.id)
    editbox.hidden = true
    void refresh()
  })
  row.append(saveBtn, cancelBtn)

  editbox.append(textarea, colors, row)
  editbox.hidden = false
  textarea.focus()
}

async function saveDraft(
  a: LocalAnnotation,
  draft: { note: string; color: string; type: 'highlight' | 'underline' },
  tabId: number | undefined,
  editbox: HTMLElement,
): Promise<void> {
  if (!currentUrl) return
  await update(currentUrl, a.id, { note: draft.note, color: draft.color, type: draft.type })
  if (tabId) {
    // 页面渲染联动（restyle 幂等：note 不影响渲染，color/type 重渲染）
    try {
      await chrome.tabs.sendMessage(tabId, { notemarker: 'restyle', id: a.id, type: draft.type, color: draft.color })
    } catch {
      /* 页面无划线脚本（不应发生）时忽略 */
    }
  }
  editing.delete(a.id)
  editbox.hidden = true
  showMsg(t('sidepanel_saved_pending'), true)
  await refresh()
}

async function removeAnnotation(a: LocalAnnotation, tabId: number | undefined): Promise<void> {
  if (!currentUrl) return
  await softDelete(currentUrl, a.id)
  if (tabId) {
    try {
      await chrome.tabs.sendMessage(tabId, { notemarker: 'remove', id: a.id })
    } catch {
      /* 忽略 */
    }
  }
  editing.delete(a.id)
  await refresh()
}

async function focusAnnotation(id: string, tabId: number | undefined): Promise<void> {
  if (!tabId) return
  try {
    const res = await chrome.tabs.sendMessage(tabId, { notemarker: 'focus', id })
    if (res && res.located === false) showMsg(t('sidepanel_locate_failed'), false)
  } catch {
    showMsg(t('sidepanel_locate_unsupported'), false)
  }
}

// ---------- 截图标记入口（specs/screenshot-annotation：标记页顶部按钮） ----------

shotBtn.addEventListener('click', async () => {
  const tab = await activeTab()
  if (tab === 'no-access') {
    showMsg(t('sidepanel_not_activated'), false)
    return
  }
  if (!tab) {
    showMsg(t('sidepanel_shot_unsupported'), false)
    return
  }
  // 经 background 转发到页面划线脚本进入截图模式；按回执 reason 给可定位的提示
  let r: { ok?: boolean; reason?: string } | undefined
  try {
    r = (await chrome.runtime.sendMessage({ action: 'startScreenshot' })) as
      | { ok?: boolean; reason?: string }
      | undefined
  } catch {
    /* background 未响应按 undefined 处理 */
  }
  if (r?.ok) {
    showMsg(t('sidepanel_shot_start_hint'), true)
  } else if (r?.reason === 'no-receiver') {
    showMsg(t('sidepanel_shot_no_receiver'), false)
  } else if (r?.reason === 'unsupported') {
    showMsg(t('sidepanel_shot_unsupported'), false)
  } else if (!r) {
    // 无应答：多为旧版 service worker 不认识该 action（扩展未重新加载）
    showMsg(t('sidepanel_shot_sw_stale'), false)
  } else {
    showMsg(t('sidepanel_shot_disabled'), false)
  }
})

// ---------- 开关（specs highlighter-toggles：站点启停 / 标记显隐） ----------

const pausedHint = $<HTMLElement>('paused-hint')

async function refreshToggles(tab: ActiveTab | null = null): Promise<void> {
  const queried = tab ?? (await activeTab())
  const t = queried === 'no-access' ? null : queried
  const master = await getMaster()
  let siteDisabled = false
  if (t) {
    siteToggle.disabled = false
    siteDisabled = await isSiteDisabled(originOf(t.url))
    siteToggle.checked = !siteDisabled
  } else {
    siteToggle.disabled = true // chrome:// 等不支持页面
    siteToggle.checked = true
  }
  marksToggle.checked = await getShowMarks()

  // 调色板同步到色点显示与颜色选择器
  palette = await getColorPalette()
  for (let i = 0; i < 5; i++) {
    const inp = document.getElementById(`color-${i}`) as HTMLInputElement | null
    if (inp) inp.value = palette[i]
  }

  // 停用状态可发现（specs 三标签页结构 design D4）：开关残留不再表现为"标记不见了"
  if (!master) {
    pausedHint.hidden = false
    pausedHint.textContent = t('sidepanel_paused_master')
  } else if (siteDisabled) {
    pausedHint.hidden = false
    pausedHint.textContent = t('sidepanel_paused_site')
  } else {
    pausedHint.hidden = true
  }
}

siteToggle.addEventListener('change', async () => {
  if (!currentUrl) return
  await setSiteDisabled(originOf(currentUrl), !siteToggle.checked)
})
marksToggle.addEventListener('change', () => void setShowMarks(marksToggle.checked))

// 另一入口（右键菜单）变更后保持面板同步
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.highlighterMaster || changes.disabledSites || changes.showMarks)) {
    void refreshToggles()
    void refreshSettingsArea(false)
  }
})

// ---------- 设置区（specs sidebar-settings-reader 侧栏设置区） ----------

const masterToggle = $<HTMLInputElement>('master-toggle')
const backendUrlInput = $<HTMLInputElement>('backend-url-input')
const backendUrlSave = $<HTMLButtonElement>('backend-url-save')
const backendStatus = $<HTMLElement>('backend-status')
const backendHelp = $<HTMLElement>('backend-help')
const backendRetry = $<HTMLButtonElement>('backend-retry')

function displayModeRadios(): NodeListOf<HTMLInputElement> {
  return document.querySelectorAll<HTMLInputElement>('input[name="display-mode"]')
}

async function refreshSettingsArea(withUrl = true): Promise<void> {
  masterToggle.checked = await getMaster()
  const show = await getShowMarks()
  displayModeRadios().forEach((r) => (r.checked = r.value === (show ? 'show' : 'sidebar')))
  if (withUrl) {
    backendUrlInput.value =
      ((await getStorageItem('backendUrl')) as string | undefined) ?? 'http://127.0.0.1:8765'
  }
}

async function refreshBackendStatus(): Promise<void> {
  backendStatus.className = ''
  backendStatus.textContent = t('sidepanel_checking')
  const { online, info } = await ping()
  if (online && info) {
    backendStatus.className = 'online'
    backendStatus.textContent = t('sidepanel_ping_online', [info.version])
    backendHelp.hidden = true
    backendRetry.hidden = true
  } else {
    backendStatus.className = 'offline'
    backendStatus.textContent = t('sidepanel_offline_short')
    backendHelp.hidden = false
    backendRetry.hidden = false
  }
}

masterToggle.addEventListener('change', () => void setMaster(masterToggle.checked))

displayModeRadios().forEach((r) => {
  r.addEventListener('change', () => {
    if (r.checked) void setShowMarks(r.value === 'show')
  })
})

backendUrlSave.addEventListener('click', async () => {
  const url = backendUrlInput.value.trim().replace(/\/+$/, '')
  await setStorage({ backendUrl: url })
  showMsg(t('sidepanel_backend_saved'), true)
  await refreshBackendStatus()
})

backendRetry.addEventListener('click', () => void refreshBackendStatus())

// 自定义高亮颜色（配置页 5 个色槽）
$<HTMLButtonElement>('color-save').addEventListener('click', async () => {
  const colors: string[] = []
  for (let i = 0; i < 5; i++) {
    const inp = document.getElementById(`color-${i}`) as HTMLInputElement | null
    colors.push(inp ? inp.value : ['#ffd234', '#34c759', '#2f80ed', '#ff69b4', '#ff453a'][i])
  }
  await setColorPalette(colors)
  palette = colors
  showMsg(t('sidepanel_colors_saved'), true)
  void refresh() // 刷新列表色点
})

// ---------- 最近剪藏与阅读预览（specs sidebar-settings-reader） ----------

const recentClipsEl = $<HTMLElement>('recent-clips')
const readerEl = $<HTMLElement>('reader')
const readerTitle = readerEl.querySelector<HTMLElement>('.rd-title')
const readerBody = $<HTMLElement>('reader-body')
const pvGroup = document.querySelector<HTMLElement>('#view-preview .pv-group')!

let readerPage: PageListItem | null = null

async function loadRecentClips(): Promise<void> {
  recentClipsEl.textContent = ''
  const r = await listPages({ limit: 8 })
  if (r.offline || !r.json?.ok) {
    const li = document.createElement('li')
    const s = document.createElement('span')
    s.className = 'rc-meta'
    s.textContent = t('sidepanel_recent_offline')
    li.append(s)
    recentClipsEl.append(li)
    return
  }
  if (!r.json.pages.length) {
    const li = document.createElement('li')
    const s = document.createElement('span')
    s.className = 'rc-meta'
    s.textContent = t('sidepanel_recent_empty')
    li.append(s)
    recentClipsEl.append(li)
    return
  }
  for (const p of r.json.pages) {
    const li = document.createElement('li')
    li.dataset.id = p.id
    const title = document.createElement('div')
    title.className = 'rc-title'
    title.textContent = p.title || p.url
    const meta = document.createElement('div')
    meta.className = 'rc-meta'
    const status =
      p.readStatus === 'read'
        ? t('options_filter_read')
        : p.readStatus === 'archived'
          ? t('options_filter_archived')
          : t('options_filter_unread')
    meta.textContent = `${fmtDate(p.updatedAt)} · ${status}`
    li.append(title, meta)
    li.addEventListener('click', () => void openReader(p))
    recentClipsEl.append(li)
  }
}

async function openReader(p: PageListItem): Promise<void> {
  readerPage = p
  readerTitle.textContent = p.title || p.url
  readerBody.textContent = t('sidepanel_loading')
  readerEl.hidden = false
  pvGroup.hidden = true // 预览标签内：列表组与阅读视图互斥切换（不再全覆盖遮挡）
  const r = await getPageContent(p.id)
  if (r.offline || !r.json?.ok) {
    readerBody.textContent = r.offline ? t('sidepanel_offline_short') : t('sidepanel_reader_no_content')
    return
  }
  renderMarkdown(readerBody, r.json.markdown, await backendUrl())
}

function closeReader(): void {
  readerEl.hidden = true
  pvGroup.hidden = false
  readerPage = null
}

$<HTMLButtonElement>('reader-back').addEventListener('click', closeReader)
$<HTMLButtonElement>('reader-open').addEventListener('click', () => {
  if (readerPage) void chrome.tabs.create({ url: readerPage.url })
})

// 阅读排版样式注入（共享模块）
{
  const st = document.createElement('style')
  st.textContent = READER_CSS
  document.head.appendChild(st)
}

// ---------- 剪藏 / 同步 ----------

// 预览流程（specs/clip-content 剪藏预览）：采集 → 面板确认 → 导出
const previewEl = $<HTMLElement>('clip-preview')
const pvTitle = previewEl.querySelector<HTMLElement>('.pv-title')
const pvMode = previewEl.querySelector<HTMLElement>('.pv-mode')
const pvSnippet = previewEl.querySelector<HTMLElement>('.pv-snippet')
const pvSave = $<HTMLButtonElement>('pv-save')
const pvFull = $<HTMLButtonElement>('pv-full')
const pvCancel = $<HTMLButtonElement>('pv-cancel')
const MODE_LABEL: Record<string, string> = {
  rule: t('sidepanel_mode_rule'),
  selection: t('sidepanel_mode_selection'),
  smart: t('sidepanel_mode_smart'),
  selector: t('sidepanel_mode_selector'),
  full: t('sidepanel_mode_full'),
}

const pvImgsRow = previewEl.querySelector<HTMLElement>('.pv-imgs')
const pvImgsToggle = $<HTMLInputElement>('pv-imgs-toggle')
const pvImgsCount = $<HTMLElement>('pv-imgs-count')

let previewData: { title: string; html: string; url: string; imageUrls: string[] } | null = null

function renderPreview(d: {
  title: string
  html: string
  mode: string
  textLen: number
  url: string
  images?: Array<{ src: string }>
}): void {
  previewData = { title: d.title, html: d.html, url: d.url, imageUrls: (d.images ?? []).map((i) => i.src) }
  pvTitle.textContent = d.title || t('sidepanel_pv_no_title')
  pvMode.textContent = t('sidepanel_pv_mode_len', [MODE_LABEL[d.mode] ?? d.mode, String(d.textLen)])
  const div = document.createElement('div')
  div.innerHTML = d.html
  pvSnippet.textContent = (div.textContent || '').trim().slice(0, 600) || t('sidepanel_pv_no_text')
  // 图片开关行（specs/clip-content 图片本地化）：无图隐藏，默认开
  pvImgsRow.hidden = previewData.imageUrls.length === 0
  pvImgsCount.textContent = t('sidepanel_pv_imgs_count', [String(previewData.imageUrls.length)])
  pvImgsToggle.checked = true
  previewEl.hidden = false
}

function clearPreview(): void {
  previewData = null
  previewEl.hidden = true
}

clipBtn.addEventListener('click', async () => {
  clipBtn.disabled = true
  showMsg(t('sidepanel_clipping'), true)
  try {
    await chrome.runtime.sendMessage({ action: 'clipPage' })
  } catch {
    showMsg(t('sidepanel_clip_failed'), false)
  }
  clipBtn.disabled = false
})

// background 转发的采集结果
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.clipPreview) {
    clipBtn.disabled = false
    renderPreview(msg.clipPreview)
  }
})

pvSave.addEventListener('click', async () => {
  if (!previewData) return
  pvSave.disabled = true
  const localize = pvImgsToggle.checked && previewData.imageUrls.length > 0
  if (localize) showMsg(t('sidepanel_saving_imgs'), true)
  try {
    const r = await chrome.runtime.sendMessage({
      action: 'exportCollected',
      url: previewData.url,
      title: previewData.title,
      html: previewData.html,
      localize,
      urls: localize ? previewData.imageUrls : [],
    })
    if (r?.ok) {
      const stats = r.imageStats as { total: number; localized: number } | undefined
      const imgPart =
        stats && stats.total > 0 && stats.localized > 0
          ? t('sidepanel_img_stats', [String(stats.localized), String(stats.total)])
          : ''
      showMsg(
        r.duplicate
          ? t('sidepanel_saved_dup', [r.filePath ?? '']) + imgPart
          : t('sidepanel_saved_path', [r.filePath ?? '']) + imgPart,
        true,
      )
      clearPreview()
      void loadRecentClips()
    } else if (r?.offline) {
      showMsg(t('sidepanel_export_offline'), false)
    } else {
      showMsg(t('sidepanel_export_failed', [r?.message ?? t('sidepanel_unknown_error')]), false)
    }
  } catch {
    showMsg(t('sidepanel_export_send_failed'), false)
  }
  pvSave.disabled = false
})

pvFull.addEventListener('click', async () => {
  clearPreview()
  clipBtn.disabled = true
  showMsg(t('sidepanel_refull'), true)
  try {
    await chrome.runtime.sendMessage({ action: 'clipPage', mode: 'full' })
  } catch {
    showMsg(t('sidepanel_refull_failed'), false)
    clipBtn.disabled = false
  }
})

pvCancel.addEventListener('click', () => {
  clearPreview() // toast 已移除：取消只需收起预览，无需再通知页面收场
})

// 本站剪藏区域（specs/clip-content 站点规则 + clip-region-picker 框选）
const ruleInput = $<HTMLInputElement>('clip-rule-input')
const ruleSave = $<HTMLButtonElement>('clip-rule-save')
const regionPick = $<HTMLButtonElement>('region-pick')
const regionClear = $<HTMLButtonElement>('region-clear')
const regionChip = $<HTMLElement>('region-chip')
const regionMsg = $<HTMLElement>('region-msg')
/** 拾取会话状态（面板侧镜像；页面 Escape/选中后的广播会纠正它） */
let pickingActive = false

async function refreshRuleInput(tab: ActiveTab | null = null): Promise<void> {
  const queried = tab ?? (await activeTab())
  const t = queried === 'no-access' ? null : queried
  const rule = t ? await getClipRule(originOf(t.url)) : ''
  ruleInput.disabled = !t
  ruleInput.value = rule
  regionPick.disabled = !t
  regionChip.hidden = !rule
  regionClear.hidden = !rule
  regionChip.textContent = rule
}

regionPick.addEventListener('click', async () => {
  if (pickingActive) {
    pickingActive = false
    regionPick.textContent = t('sidepanel_region_pick')
    regionMsg.textContent = t('sidepanel_region_cancelled')
    try {
      await chrome.runtime.sendMessage({ action: 'pickRegion', cancel: true })
    } catch {
      /* ignore */
    }
    return
  }
  pickingActive = true
  regionPick.textContent = t('sidepanel_region_cancel')
  regionMsg.textContent = t('sidepanel_region_picking_hint')
  try {
    await chrome.runtime.sendMessage({ action: 'pickRegion' })
  } catch {
    pickingActive = false
    regionPick.textContent = t('sidepanel_region_pick')
    regionMsg.textContent = t('sidepanel_region_start_failed')
  }
})

regionClear.addEventListener('click', async () => {
  if (!currentUrl) return
  await setClipRule(originOf(currentUrl), null)
  await refreshRuleInput()
  regionMsg.textContent = t('sidepanel_region_cleared')
})

// 页面侧推断结果（成功/失败/取消）经广播回来
chrome.runtime.onMessage.addListener((msg) => {
  if (!msg?.notemarkerRegionPicked) return
  const r = msg.notemarkerRegionPicked as { ok: boolean; selector?: string; textLen?: number; reason?: string }
  pickingActive = false
  regionPick.textContent = t('sidepanel_region_pick')
  if (r.ok) {
    regionMsg.textContent = t('sidepanel_region_set_len', [r.selector ?? '', String(r.textLen ?? 0)])
    void refreshRuleInput()
  } else {
    regionMsg.textContent = r.reason ?? t('sidepanel_region_none')
  }
})

ruleSave.addEventListener('click', async () => {
  if (!currentUrl) return
  await setClipRule(originOf(currentUrl), ruleInput.value)
  showMsg(ruleInput.value.trim() ? t('sidepanel_rule_saved') : t('sidepanel_region_cleared'), true)
  await refreshRuleInput()
  regionMsg.textContent = ruleInput.value.trim()
    ? t('sidepanel_region_set', [ruleInput.value.trim()])
    : t('sidepanel_region_hint')
})

syncBtn.addEventListener('click', async () => {
  syncBtn.disabled = true
  showMsg(t('sidepanel_syncing'), true)
  let summary: { offline?: boolean; pushed?: number; failed?: number; deleted?: number } | undefined
  try {
    summary = await chrome.runtime.sendMessage({ action: 'sync' })
  } catch {
    summary = { offline: true }
  }
  syncBtn.disabled = false
  if (summary?.offline) {
    showMsg(t('sidepanel_sync_failed_offline'), false)
  } else {
    const parts = [t('sidepanel_sync_pushed', [String(summary?.pushed ?? 0)])]
    if (summary?.failed) parts.push(t('sidepanel_sync_failed_n', [String(summary.failed)]))
    parts.push(t('sidepanel_sync_deleted', [String(summary?.deleted ?? 0)]))
    showMsg(`${t('sidepanel_sync_done_prefix')}${parts.join(t('sidepanel_sep'))}`, !(summary?.failed ?? 0))
  }
  await refresh()
})

// ---------- 联动刷新（design D5：三事件汇入 refresh） ----------

/** 点击激活（specs extension-highlighter 点击激活模型）：面板打开/换页/导航后请求 background 注入划线脚本 */
async function activateHighlighter(): Promise<void> {
  try {
    await chrome.runtime.sendMessage({ action: 'activateTab' })
  } catch {
    /* background 未响应忽略 */
  }
}

chrome.tabs.onActivated.addListener(() => {
  void activateHighlighter()
  void refresh()
})
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'complete') {
    void activateHighlighter()
    void refresh()
  }
})
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.notemarker === 'changed' && typeof msg.url === 'string' && msg.url === currentUrl) {
    void refresh()
  }
})

void activateHighlighter()
void refresh()
void refreshSettingsArea()
void refreshBackendStatus()
void loadRecentClips()
