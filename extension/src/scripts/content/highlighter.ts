// 划线高亮 content script（specs/extension-highlighter，design D6/D7，点击激活模型）：
// 图标点击打开侧栏时经 executeScript 注入；选中即标工具条、多色高亮/下划线、批注编辑、
// 按文本锚点的恢复，变更即时落本地库。activeTab 在刷新/跳转后失效——每次页面加载需重新点击激活。
// 注意：不得注册 chrome.runtime.onMessage 对 {message:'ping'} 的应答（剪藏脚本注入探测保留，
// 本脚本只应答 {notemarker:'ping'}，供 background 的 ensureHighlighterInjected 幂等探测）。

// 重复注入守卫：同帧重复 executeScript 共享隔离世界，模块会整体重跑
{
  const w = globalThis as { __notemarkerHighlighterLoaded?: boolean }
  if (w.__notemarkerHighlighterLoaded) throw new Error('[notemarker] highlighter already loaded')
  w.__notemarkerHighlighterLoaded = true
}
import { t } from '../i18n'
import {
  buildTextIndex,
  findByQuote,
  offsetsToRange,
  rangeToOffsets,
  restyleWrappers,
  unwrapById,
  wrapRange,
  type TextIndex,
} from '../anchor'
import {
  assignSeqs,
  create,
  isEvicted,
  listByPage,
  nextSeq,
  normalizePageUrl,
  softDelete,
  update,
  uuid,
  type LocalAnnotation,
} from '../storage/annotations'
import {
  COLOR_SLOTS,
  getColorPalette,
  getMaster,
  getShowMarks,
  isSiteDisabled,
  originOf,
  setClipRule,
} from '../storage/settings'

const COLORS = COLOR_SLOTS
/** 当前调色板（init 时从设置读取，storage 变更时刷新） */
let palette: string[] = ['#ffd234', '#34c759', '#2f80ed', '#ff69b4', '#ff453a']

/** hex → rgba 半透明背景（高亮用） */
function hexToRgba(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

/** 按名称取当前调色板色值 */
function colorHex(name: string): string {
  const i = COLORS.indexOf(name as (typeof COLORS)[number])
  return i >= 0 ? palette[i] : '#999999'
}
const ANCHOR_CTX = 32
const HL_TAG = 'notemarker-hl'
/** 页内批注编号标签（specs/annotation-numbering） */
const NOTE_TAG = 'notemarker-note'
/** 短批注上屏阈值：≤7 字显示"编号+文本"，>7 或空仅显示编号 */
const NOTE_INLINE_MAX = 7

const pageUrl = normalizePageUrl(location.href)

// ---------- 全文索引（包裹/拆分后失效，需重建） ----------

let index: TextIndex | null = null

function ensureIndex(): TextIndex {
  if (!index) index = buildTextIndex(document.body)
  return index
}

function invalidateIndex(): void {
  index = null
}

// ---------- 页面级高亮样式（包裹元素在页面 DOM 中，不能进 Shadow） ----------

function injectStyles(): void {
  document.getElementById('notemarker-hl-style')?.remove()
  const style = document.createElement('style')
  style.id = 'notemarker-hl-style'
  style.textContent = `
${HL_TAG} { cursor: pointer; border-radius: 2px; box-sizing: border-box; }
${COLORS.map((c, i) => `${HL_TAG}[data-type='highlight'][data-color='${c}'] { background-color: ${hexToRgba(palette[i], 0.4)}; }`).join('\n')}
${COLORS.map((c, i) => `${HL_TAG}[data-type='underline'][data-color='${c}'] { border-bottom: 2px solid ${palette[i]}; }`).join('\n')}
@keyframes notemarker-flash-kf { 0%, 100% { outline: none; box-shadow: none; } 50% { outline: 2px solid #f5c518; box-shadow: 0 0 0 3px rgba(245, 197, 24, .5); } }
${HL_TAG}.notemarker-flash { animation: notemarker-flash-kf .55s ease-in-out 2; }
img[data-notemarker-id] { outline: 2px solid !important; outline-offset: 2px; cursor: pointer; }
${COLORS.map((c, i) => `img[data-notemarker-id][data-notemarker-color='${c}'] { outline-color: ${palette[i]} !important; }`).join('\n')}
img[data-notemarker-id].notemarker-flash { animation: notemarker-flash-kf .55s ease-in-out 2; }
${NOTE_TAG} {
  display: inline; font: 500 12px/1.4 system-ui, sans-serif; margin-left: 3px; padding: 0 5px;
  border-radius: 8px; background: rgba(245, 197, 24, .18); color: #8a6d00;
  cursor: pointer; white-space: nowrap; user-select: none;
}
`
  document.documentElement.appendChild(style)
}

// ---------- Shadow UI（工具条 + 批注编辑器） ----------

const SHADOW_CSS = `
:host { all: initial; }
* { box-sizing: border-box; font: 400 13px/1.4 system-ui, sans-serif; }
.toolbar {
  position: fixed; z-index: 2147483647; display: flex; align-items: center; gap: 6px;
  padding: 6px 8px; border: 1px solid #d8d8d8; border-radius: 8px;
  background: #fff; box-shadow: 0 4px 16px rgba(0,0,0,.16);
}
#img-badge {
  position: fixed; z-index: 2147483646;
  padding: 2px 10px; border: none; border-radius: 10px;
  background: #ffd234; color: #3d3d3d; font: 600 12px sans-serif;
  cursor: pointer; box-shadow: 0 2px 8px rgba(0,0,0,.25);
}
.dot {
  width: 18px; height: 18px; border-radius: 50%; cursor: pointer;
  border: 2px solid transparent;
}
.dot:hover { border-color: #888; }
.sep { width: 1px; height: 16px; background: #ddd; margin: 0 2px; }
.act {
  border: none; background: transparent; cursor: pointer; font-weight: 700;
  color: #3d3d3d; padding: 2px 6px; border-radius: 4px;
}
.act:hover { background: #f0f0f0; }
.editor {
  position: fixed; z-index: 2147483647; width: 300px;
  padding: 10px; border: 1px solid #d8d8d8; border-radius: 8px;
  background: #fff; box-shadow: 0 4px 16px rgba(0,0,0,.16);
}
.editor .quote {
  max-height: 52px; overflow: hidden; margin-bottom: 6px; padding: 4px 6px;
  border-left: 3px solid #f5c518; background: #fafafa;
  color: #666; font-size: 12px;
}
.editor textarea {
  width: 100%; min-height: 60px; resize: vertical; padding: 6px;
  border: 1px solid #bbb; border-radius: 4px; font: 400 13px/1.4 system-ui, sans-serif;
}
.editor .row { display: flex; align-items: center; gap: 6px; margin-top: 8px; }
.editor .row .dot { width: 16px; height: 16px; }
.editor .row .dot.active { border-color: #3d3d3d; }
.editor .spacer { flex: 1; }
.editor button {
  border: 1px solid #ccc; border-radius: 4px; background: #fff; color: #3d3d3d;
  cursor: pointer; padding: 3px 10px; font-size: 12px;
}
.editor button:hover { background: #f0f0f0; }
.editor button.danger { color: #c7372f; border-color: #e5b5b2; }
.editor button.primary { background: #ffd234; border-color: #e8b819; font-weight: 600; }
.editor button.toggled { background: #ffe9a0; border-color: #e8b819; }
[hidden] { display: none !important; }
`

interface Ui {
  host: HTMLDivElement
  imgBadge: HTMLButtonElement
  toolbar: HTMLDivElement
  editor: HTMLDivElement
  quoteEl: HTMLDivElement
  textarea: HTMLTextAreaElement
  dotBtns: HTMLElement[]
}

let ui: Ui | undefined

function ensureUi(): Ui {
  if (ui) return ui
  const host = document.createElement('div')
  host.id = 'notemarker-highlighter-root'
  // 宿主脱离文档流（固定 0 尺寸）：否则其内部 focus() 会触发"滚动到宿主位置"
  // 把页面强制滚到底部（宿主在文档流中位于 body 之后），表现为标注后滚轮失灵/页面乱跳
  host.style.cssText = 'position: fixed; top: 0; left: 0; width: 0; height: 0; z-index: 2147483647;'
  const root = host.attachShadow({ mode: 'open' })
  root.innerHTML = `<style>${SHADOW_CSS}</style>
<button id="img-badge" hidden>${t('hl_annotate')}</button>
<div class="toolbar" hidden>
  ${COLORS.map((c, i) => `<span class="dot" data-color="${c}" title="${t('hl_dot_title')}" style="background-color:${palette[i]}"></span>`).join('')}
  <span class="sep"></span>
  <button class="act" data-act="note" title="${t('hl_write_note')}">✎</button>
</div>
<div class="editor" hidden>
  <div class="quote"></div>
  <textarea placeholder="${t('sidepanel_note_ph')}"></textarea>
  <div class="row">
    ${COLORS.map((c, i) => `<span class="dot" data-color="${c}" style="background-color:${palette[i]}"></span>`).join('')}
    <span class="spacer"></span>
    <button data-act="delete" class="danger">${t('sidepanel_delete')}</button>
    <button data-act="save" class="primary">${t('sidepanel_save')}</button>
  </div>
</div>`
  // 挂在 documentElement（body 之外），全文索引以 body 为根时天然排除 UI 文本
  document.documentElement.appendChild(host)

  const imgBadge = root.querySelector('#img-badge') as HTMLButtonElement
  const toolbar = root.querySelector('.toolbar') as HTMLDivElement
  const editor = root.querySelector('.editor') as HTMLDivElement
  const quoteEl = editor.querySelector('.quote') as HTMLDivElement
  const textarea = editor.querySelector('textarea') as HTMLTextAreaElement
  const dotBtns = Array.from(editor.querySelectorAll('.row .dot')) as HTMLElement[]

  ui = { host, imgBadge, toolbar, editor, quoteEl, textarea, dotBtns }
  connectImgBadge(imgBadge)
  connectToolbar(toolbar)
  connectEditor()
  return ui
}

// ---------- 工具条（选区操作） ----------

let lastColor: string = 'yellow'

function connectToolbar(toolbar: HTMLDivElement): void {
  // 关键：阻止 mousedown 默认行为，防止浏览器在点击工具条按钮时清除文字选区
  // （真实鼠标点击会先触发 mousedown → 浏览器清除选区 → click 到达时选区已空 → 创建失败）
  toolbar.addEventListener('mousedown', (e) => e.preventDefault())
  toolbar.addEventListener('click', (e) => {
    const el = e.target as HTMLElement
    const color = el.getAttribute('data-color')
    if (color) {
      lastColor = color
      void createFromSelection('highlight', color)
      return
    }
    const act = el.getAttribute('data-act') ?? el.parentElement?.getAttribute('data-act')
    if (act === 'note') {
      void createFromSelection('highlight', lastColor).then((rec) => {
        if (rec) openEditor(rec)
      })
    }
  })
}

function hideToolbar(): void {
  if (ui) ui.toolbar.hidden = true
}

/** 是否处于真实可编辑区域。注意 contenteditable="false" 是只读声明（WPS/ProseMirror 只读正文常见），不算可编辑 */
function inEditableArea(el: Element): boolean {
  if (el.closest('input, textarea, select')) return true
  const ce = el.closest('[contenteditable]')
  if (ce) {
    // 最近声明生效：""/true/plaintext-only 可编辑；false 只读 → 放行划线
    const v = (ce.getAttribute('contenteditable') ?? '').trim().toLowerCase()
    return v !== 'false'
  }
  return !!el.closest('[role="textbox"]')
}

function selectionUsable(sel: Selection | null): sel is Selection {
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return false
  const text = sel.toString()
  if (!text || !text.trim()) return false
  const node = sel.anchorNode
  if (!node) return false
  const el = node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as Element)
  if (!el) return false
  // 扩展自身 UI 与页面可编辑区域内的选区不触发
  if (el.closest('#notemarker-highlighter-root, #notemarker-extension-root')) return false
  if (inEditableArea(el)) return false
  return true
}

function showToolbarForSelection(): void {
  if (!active || pickingRegion || screenshotting) {
    hideToolbar()
    return
  }
  const sel = window.getSelection()
  if (!selectionUsable(sel)) {
    hideToolbar()
    return
  }
  const { toolbar } = ensureUi()
  const rect = sel.getRangeAt(0).getBoundingClientRect()
  toolbar.hidden = false
  // 先展示再量尺寸定位
  const w = toolbar.offsetWidth
  const h = toolbar.offsetHeight
  let left = rect.left + rect.width / 2 - w / 2
  left = Math.max(8, Math.min(left, window.innerWidth - w - 8))
  let top = rect.top - h - 8
  if (top < 8) top = Math.min(rect.bottom + 8, window.innerHeight - h - 8)
  toolbar.style.left = `${left}px`
  toolbar.style.top = `${top}px`
}

// ---------- 批注编辑器 ----------

/** 当前页记录缓存（恢复时加载，增删改后维护） */
const records = new Map<string, LocalAnnotation>()
/** 正在编辑的记录（编辑器内暂存颜色/类型，保存时落库） */
let editing: LocalAnnotation | null = null
let editorColor = 'yellow'
let editorType: 'highlight' | 'underline' = 'highlight'

function connectEditor(): void {
  if (!ui) return
  const { editor, textarea, dotBtns } = ui

  editor.addEventListener('click', (e) => {
    const el = e.target as HTMLElement
    const color = el.getAttribute('data-color')
    if (color && editing) {
      editorColor = color
      reflectEditorState()
      return
    }
    switch (el.getAttribute('data-act')) {
      case 'delete':
        if (editing) void deleteHighlight(editing)
        break
      case 'save':
        void saveEditor()
        break
    }
  })

  textarea.addEventListener('keydown', (e) => {
    e.stopPropagation()
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void saveEditor()
    if (e.key === 'Escape') hideEditor()
  })
}

function reflectEditorState(): void {
  if (!ui) return
  ui.dotBtns.forEach((b) => b.classList.toggle('active', b.getAttribute('data-color') === editorColor))
}

function openEditor(rec: LocalAnnotation): void {
  const { editor, quoteEl, textarea } = ensureUi()
  editing = rec
  editorColor = rec.color
  editorType = rec.type
  quoteEl.textContent = rec.quote.length > 100 ? `${rec.quote.slice(0, 100)}…` : rec.quote
  textarea.value = rec.note
  reflectEditorState()

  editor.hidden = false
  const rect = firstWrapperRect(rec.id)
  const w = editor.offsetWidth
  const h = editor.offsetHeight
  const x = rect ? rect.left : window.innerWidth / 2 - w / 2
  const y = rect ? (rect.top - h - 8 >= 8 ? rect.top - h - 8 : Math.min(rect.bottom + 8, window.innerHeight - h - 8)) : 120
  editor.style.left = `${Math.max(8, Math.min(x, window.innerWidth - w - 8))}px`
  editor.style.top = `${Math.max(8, y)}px`
  // preventScroll：focus 默认会把焦点元素滚进可视区，宿主不在文档流后此保险仍保留
  textarea.focus({ preventScroll: true })
}

function hideEditor(): void {
  if (ui) ui.editor.hidden = true
  editing = null
}

async function saveEditor(): Promise<void> {
  if (!editing || !ui) return
  const rec = editing
  const note = ui.textarea.value
  await update(pageUrl, rec.id, { note, color: editorColor, type: editorType })
  records.set(rec.id, { ...rec, note, color: editorColor, type: editorType })
  restyleWrappers(rec.id, editorType, editorColor)
  updateNoteLabel(rec.id, note, rec.seq)
  hideEditor()
  broadcastChange()
}

async function deleteHighlight(rec: LocalAnnotation): Promise<void> {
  await softDelete(pageUrl, rec.id)
  if (rec.type === 'image') {
    clearImgMark(rec.id)
  } else if (rec.type === 'screenshot') {
    // 截图无页内渲染：无包裹/描边可清（specs/screenshot-annotation）
  } else {
    unwrapById(rec.id)
  }
  removeNoteLabel(rec.id)
  invalidateIndex()
  records.delete(rec.id)
  hideEditor()
  broadcastChange()
}

function firstWrapperRect(id: string): DOMRect | null {
  const el = document.querySelector(`${HL_TAG}[data-id="${CSS.escape(id)}"]`)
  return el ? el.getBoundingClientRect() : null
}

// ---------- 高亮创建 ----------

async function createFromSelection(
  type: 'highlight' | 'underline',
  color: string,
): Promise<LocalAnnotation | null> {
  const sel = window.getSelection()
  if (!selectionUsable(sel)) return null
  const range = sel.getRangeAt(0)

  const idx = ensureIndex()
  const pos = rangeToOffsets(idx, range)
  const quote = pos ? idx.text.slice(pos.start, pos.end) : sel.toString()
  if (!quote.trim()) return null
  const prefix = pos ? idx.text.slice(Math.max(0, pos.start - ANCHOR_CTX), pos.start) : ''
  const suffix = pos ? idx.text.slice(pos.end, Math.min(idx.text.length, pos.end + ANCHOR_CTX)) : ''

  const id = uuid()
  const wrapped = wrapRange(range, id, type, color)
  if (!wrapped.length) return null
  invalidateIndex()

  const record = await create({
    id,
    url: pageUrl,
    title: document.title,
    quote,
    prefix,
    suffix,
    startOffset: pos ? pos.start : null,
    endOffset: pos ? pos.end : null,
    note: '',
    type,
    color,
    seq: await nextSeq(pageUrl),
  })
  records.set(id, record)
  renderNoteLabel(record)
  sel.removeAllRanges()
  hideToolbar()
  broadcastChange()
  return record
}

// ---------- 重访恢复 ----------

/** 尝试渲染单条标注（锚点定位 + 包裹 + 标签）；锚点失配等失败返回 false */
function tryRestoreOne(a: LocalAnnotation): boolean {
  const idx = ensureIndex()
  // 文本锚点优先（prefix+quote+suffix，降级 quote-only），数字偏移仅辅助（design D7）
  const pos =
    findByQuote(idx, a.quote, a.prefix, a.suffix) ??
    (a.startOffset != null && a.endOffset != null && a.endOffset > a.startOffset
      ? { start: a.startOffset, end: a.endOffset }
      : null)
  if (!pos) return false // 锚点失配：本轮放弃，不丢存储记录
  const range = offsetsToRange(idx, pos.start, pos.end)
  if (!range) return false
  const wrapped = wrapRange(range, a.id, a.type, a.color)
  if (!wrapped.length) return false
  invalidateIndex()
  renderNoteLabel(a)
  return true
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function restore(): Promise<void> {
  // 存量迁移：无 seq 的记录（含 tombstone）一次性补分配（specs 标注编号）
  await assignSeqs(pageUrl)
  let list = await listByPage(pageUrl)
  // 被清页回源（specs/extension-sync 被清理页面重访回源，design D2/D4）：
  // 本地桶为空且该页曾被超限清理才回源——从未标注过的页面不产生请求；
  // 失败静默（本次不渲染、不报错），下次加载重试
  if (!list.length && (await isEvicted(pageUrl))) {
    const r = await chrome.runtime.sendMessage({ action: 'refetchPage', url: pageUrl }).catch(() => null)
    if (r?.ok) list = await listByPage(pageUrl)
  }
  for (const a of list) records.set(a.id, a)
  if (!list.length) return

  // SPA 正文常在 document_idle 之后才挂载（首查为空文本导致锚点全失配）：
  // 分轮重试，全部渲染成功即提前结束；每轮重建索引、跳过已渲染与已删除（有界，约 15s 封顶）
  const delays = [0, 500, 1500, 3000, 6000, 10000]
  for (const d of delays) {
    if (d > 0) await sleep(d)
    if (!active) return // 等待期间站点被停用：中止恢复
    invalidateIndex()
    let allRendered = true
    for (const a of list) {
      if (!records.has(a.id)) continue // 等待期间被用户删除
      if (a.type === 'screenshot' || a.type === 'note') continue // 截图/手动标注无页内锚点：常态跳过（不算失配，避免空转重试）
      if (document.querySelector(`${HL_TAG}[data-id="${CSS.escape(a.id)}"], img[data-notemarker-id="${CSS.escape(a.id)}"]`)) continue
      allRendered = false
      if (a.type === 'image') tryRestoreImage(a)
      else tryRestoreOne(a)
    }
    if (allRendered) return
  }
}

/** 恢复单条图片标注（三级匹配；失配静默跳过） */
function tryRestoreImage(a: LocalAnnotation): boolean {
  const img = findImgFor(a)
  if (!img) return false
  applyImgMark(img, a.id, a.color)
  renderNoteLabel(a)
  return true
}

// ---------- 批注编号标签（specs/annotation-numbering） ----------

function noteLabelText(a: { seq?: number; note: string }): string {
  const n = a.seq ?? 0
  if (a.note.length > 0 && a.note.length <= NOTE_INLINE_MAX) return `${n} ${a.note}`
  return String(n)
}

function noteLabelById(id: string): Element | null {
  return document.querySelector(`${NOTE_TAG}[data-id="${CSS.escape(id)}"]`)
}

function lastWrapper(id: string): HTMLElement | null {
  return anchorElOf(id)
}

/** 在该条最后一个包裹元素（文字）或图片后渲染标签；重复调用安全（先移除旧标签） */
function renderNoteLabel(a: LocalAnnotation): void {
  removeNoteLabel(a.id)
  const last = anchorElOf(a.id)
  if (!last?.parentNode) return
  const el = document.createElement(NOTE_TAG)
  el.setAttribute('data-id', a.id)
  el.textContent = noteLabelText(a)
  if (a.note.length > NOTE_INLINE_MAX) el.title = a.note // 悬停看全文（design Open Question）
  last.parentNode.insertBefore(el, last.nextSibling)
}

/** 批注内容变化后更新标签（文本形态在 编号 / 编号+短文本 间切换）；标签意外缺失时重渲染 */
function updateNoteLabel(id: string, note: string, seq?: number): void {
  const el = noteLabelById(id)
  if (el) {
    el.textContent = noteLabelText({ seq, note })
    if (note.length > NOTE_INLINE_MAX) el.setAttribute('title', note)
    else el.removeAttribute('title')
    return
  }
  const rec = records.get(id)
  if (rec && lastWrapper(id)) renderNoteLabel({ ...rec, note, seq })
}

function removeNoteLabel(id: string): void {
  noteLabelById(id)?.remove()
}

// ---------- 图片标注（specs image-annotation：徽标选中/复合锚点/描边渲染/三级恢复） ----------

/** 标注锚定元素：文字为最后一个包裹元素，图片为 img 本身（编号标签挂其后） */
function anchorElOf(id: string): HTMLElement | null {
  const els = document.querySelectorAll(
    `${HL_TAG}[data-id="${CSS.escape(id)}"], img[data-notemarker-id="${CSS.escape(id)}"]`,
  )
  return els.length ? (els[els.length - 1] as HTMLElement) : null
}

function fileNameOf(src: string): string {
  try {
    return new URL(src).pathname.split('/').pop() || src
  } catch {
    return src
  }
}

/** 图片前后文（对应文字标注的 prefix/suffix）：取全文索引中相邻文本节点的尾/头各 32 字符 */
function contextAroundElement(el: Element): { prefix: string; suffix: string } {
  const idx = ensureIndex()
  let prefix = ''
  let suffix = ''
  for (const node of idx.nodes) {
    const rel = node.compareDocumentPosition(el)
    if (rel & Node.DOCUMENT_POSITION_FOLLOWING) {
      prefix = node.data // 持续覆盖 → 取 el 之前最近的文本节点
    } else if (rel & Node.DOCUMENT_POSITION_PRECEDING && !suffix) {
      suffix = node.data // el 之后最近的文本节点
    }
  }
  return { prefix: prefix.slice(-ANCHOR_CTX), suffix: suffix.slice(0, ANCHOR_CTX) }
}

function applyImgMark(img: HTMLImageElement, id: string, color: string): void {
  img.setAttribute('data-notemarker-id', id)
  img.setAttribute('data-notemarker-color', color)
}

function clearImgMark(id: string): void {
  document.querySelectorAll(`img[data-notemarker-id="${CSS.escape(id)}"]`).forEach((img) => {
    img.removeAttribute('data-notemarker-id')
    img.removeAttribute('data-notemarker-color')
    img.classList.remove('notemarker-flash')
  })
}

async function createImageAnnotation(img: HTMLImageElement): Promise<void> {
  const src = img.currentSrc || img.src || ''
  if (!src) return
  const alt = img.getAttribute('alt') ?? ''
  const sameSrc = Array.from(document.querySelectorAll('img')).filter(
    (i) => (i.currentSrc || i.src) === src,
  )
  const imgIndex = Math.max(0, sameSrc.indexOf(img))
  const { prefix, suffix } = contextAroundElement(img)

  const id = uuid()
  applyImgMark(img, id, 'yellow')
  const record = await create({
    id,
    url: pageUrl,
    title: document.title,
    quote: alt || fileNameOf(src),
    prefix,
    suffix,
    startOffset: null,
    endOffset: null,
    note: '',
    type: 'image',
    color: 'yellow',
    seq: await nextSeq(pageUrl),
    imgSrc: src,
    imgAlt: alt,
    imgIndex,
  })
  records.set(id, record)
  renderNoteLabel(record)
  void saveImageCopy(record) // 自动存图异步进行，不阻塞编辑器
  broadcastChange()
  openEditor(record)
}

/**
 * 图片标注自动存图（specs image-annotation 自动存图）：创建即在页面上下文抓图
 * （带会话 cookie，与剪藏 localizeImages 同模式；剪藏脚本按需注入不可依赖，故独立实现）
 * → 经 background 上传 /images（sha256 去重）→ 本地路径存入 imgLocal（仅本地，不同步）。
 * 失败/离线静默降级——标注本身不受影响，仅保留原 src 引用。
 */
const IMG_MAX_BYTES = 5 * 1024 * 1024
const IMG_EXT_BY_TYPE: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
}

async function saveImageCopy(rec: LocalAnnotation): Promise<void> {
  const src = rec.imgSrc ?? ''
  if (!src) return
  try {
    let data = ''
    let filename = ''
    if (src.startsWith('data:')) {
      // 内联图页面一关即失，本地化更有价值：直接解 base64（非 base64 编码不支持，放弃）
      const comma = src.indexOf(',')
      const meta = src.slice(5, comma)
      if (!/;base64$/i.test(meta)) return
      data = src.slice(comma + 1)
      filename = `img.${IMG_EXT_BY_TYPE[meta.split(';')[0]] ?? 'png'}`
    } else {
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), 15000)
      let blob: Blob
      try {
        const res = await fetch(src, { credentials: 'include', signal: ctrl.signal })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        blob = await res.blob()
      } finally {
        clearTimeout(timer)
      }
      if (blob.size > IMG_MAX_BYTES) return
      data = await new Promise<string>((resolve, reject) => {
        const fr = new FileReader()
        fr.onload = () => resolve(String(fr.result).split(',')[1] ?? '')
        fr.onerror = () => reject(fr.error)
        fr.readAsDataURL(blob)
      })
      filename = fileNameOf(src)
      if (!/\.\w+$/.test(filename)) filename = `img.${IMG_EXT_BY_TYPE[blob.type] ?? 'png'}`
    }
    const up = await chrome.runtime.sendMessage({ action: 'uploadImage', data, filename })
    if (up?.ok && typeof up.local === 'string') {
      records.set(rec.id, { ...(records.get(rec.id) ?? rec), imgLocal: up.local })
      await update(pageUrl, rec.id, { imgLocal: up.local })
      broadcastChange() // 开着的侧栏刷新出"已存图"状态
    }
  } catch {
    // 抓取/上传失败（跨域 CORS、离线、超时等）：静默降级
  }
}

/** 三级恢复匹配：src 精确 → alt+文件名（带序号）→ 前后文邻近图 */
function findImgFor(a: LocalAnnotation): HTMLImageElement | null {
  const imgs = Array.from(document.querySelectorAll('img'))
  if (a.imgSrc) {
    const bySrc = imgs.filter((i) => (i.currentSrc || i.src) === a.imgSrc)
    if (bySrc[a.imgIndex ?? 0]) return bySrc[a.imgIndex ?? 0]
    const name = fileNameOf(a.imgSrc)
    const byAlt = imgs.filter(
      (i) => a.imgAlt && i.getAttribute('alt') === a.imgAlt && fileNameOf(i.currentSrc || i.src) === name,
    )
    if (byAlt.length) return byAlt[Math.min(a.imgIndex ?? 0, byAlt.length - 1)]
  }
  if (a.prefix) {
    const tail = a.prefix.slice(-16)
    for (const img of imgs) {
      if (contextAroundElement(img).prefix.slice(-16) === tail) return img
    }
  }
  return null
}

// ---------- 截图标注（specs/screenshot-annotation：遮罩框选 → 捕获裁剪 → 上传 → 记录） ----------

/** 截图模式激活中（与 pickingRegion 互斥；期间工具条/图片徽标静默） */
let screenshotting = false
/** 截图遮罩与选框（普通 DOM，捕获前整体移除防入镜，design D2） */
let shotMask: HTMLDivElement | null = null
let shotBox: HTMLDivElement | null = null

function teardownShotOverlay(): void {
  shotMask?.remove()
  shotMask = null
  shotBox = null
}

function exitScreenshotMode(): void {
  screenshotting = false
  teardownShotOverlay()
}

function enterScreenshotMode(): void {
  if (!active) return // 划线停用：回执 screenshotting=false，面板提示失败
  if (pickingRegion) {
    // 互斥：抢占地让拾取流收场（面板在等广播，不发会悬挂）
    pickingRegion = false
    hideToolbar()
    broadcastPick({ ok: false, cancelled: true, reason: t('hl_reason_switch_shot') })
  }
  screenshotting = true
  hideToolbar()
  hideEditor()
  hideImgBadge()
  buildShotOverlay()
}

/** 遮罩 + 十字光标 + 顶部提示条；拖拽画选框（box-shadow 大扩散把选区外压暗） */
function buildShotOverlay(): void {
  teardownShotOverlay()
  const mask = document.createElement('div')
  mask.id = 'notemarker-shot-mask'
  mask.style.cssText = 'position:fixed;inset:0;z-index:2147483646;cursor:crosshair;'
  const hint = document.createElement('div')
  hint.textContent = t('hl_shot_hint')
  hint.style.cssText =
    'position:absolute;top:16px;left:50%;transform:translateX(-50%);padding:6px 14px;border-radius:14px;background:#1f1f1f;color:#fff;font:500 13px/1.4 system-ui,sans-serif;pointer-events:none;'
  const box = document.createElement('div')
  box.style.cssText =
    'position:absolute;border:2px solid #f5c518;box-shadow:0 0 0 100000px rgba(0,0,0,.3);display:none;'
  mask.append(hint, box)
  document.documentElement.appendChild(mask)
  shotMask = mask
  shotBox = box

  let startX = 0
  let startY = 0
  let dragging = false
  mask.addEventListener('mousedown', (e) => {
    e.preventDefault()
    dragging = true
    startX = e.clientX
    startY = e.clientY
    box.style.display = 'block'
    box.style.left = `${startX}px`
    box.style.top = `${startY}px`
    box.style.width = '0px'
    box.style.height = '0px'
  })
  mask.addEventListener('mousemove', (e) => {
    if (!dragging) return
    box.style.left = `${Math.min(startX, e.clientX)}px`
    box.style.top = `${Math.min(startY, e.clientY)}px`
    box.style.width = `${Math.abs(e.clientX - startX)}px`
    box.style.height = `${Math.abs(e.clientY - startY)}px`
  })
  mask.addEventListener('mouseup', (e) => {
    if (!dragging) return
    dragging = false
    const rect = {
      x: Math.min(startX, e.clientX),
      y: Math.min(startY, e.clientY),
      w: Math.abs(e.clientX - startX),
      h: Math.abs(e.clientY - startY),
    }
    // 过小视作"点击遮罩空白"：取消退出（规格：Esc 或点空白取消）
    if (rect.w < 8 || rect.h < 8) {
      exitScreenshotMode()
      return
    }
    void finishScreenshotSelection(rect)
  })
}

/** 等合成器出新帧（拆遮罩后立即拍会残留遮罩/选框，design D2） */
function nextPaint(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 150)))
  })
}

/** 捕获图按选区裁剪：物理像素 = CSS 像素 × devicePixelRatio */
async function cropToDataUrl(
  fullDataUrl: string,
  rect: { x: number; y: number; w: number; h: number },
): Promise<string> {
  const dpr = window.devicePixelRatio || 1
  const img = new Image()
  img.src = fullDataUrl
  await img.decode()
  const sx = Math.round(rect.x * dpr)
  const sy = Math.round(rect.y * dpr)
  const sw = Math.round(rect.w * dpr)
  const sh = Math.round(rect.h * dpr)
  const canvas = document.createElement('canvas')
  canvas.width = sw
  canvas.height = sh
  canvas.getContext('2d')?.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh)
  return canvas.toDataURL('image/png')
}

/** 与存图链路同限额：单张 5MB 二进制 ≈ 6.7M base64 字符 */
const SHOT_MAX_B64 = Math.floor((5 * 1024 * 1024 * 4) / 3)

async function finishScreenshotSelection(rect: {
  x: number
  y: number
  w: number
  h: number
}): Promise<void> {
  const w = Math.round(rect.w)
  const h = Math.round(rect.h)
  // 先拆遮罩退模式，再等新帧捕获（design D2）
  screenshotting = false
  teardownShotOverlay()
  await nextPaint()
  let imgLocal: string | undefined
  try {
    const cap = (await chrome.runtime.sendMessage({ action: 'captureTab' })) as
      | { ok?: boolean; dataUrl?: string }
      | undefined
    if (cap?.ok && typeof cap.dataUrl === 'string') {
      const dataUrl = await cropToDataUrl(cap.dataUrl, rect)
      if (dataUrl.length <= SHOT_MAX_B64) {
        const up = await chrome.runtime.sendMessage({
          action: 'uploadImage',
          data: dataUrl.slice(dataUrl.indexOf(',') + 1),
          filename: 'screenshot.png',
        })
        if (up?.ok && typeof up.local === 'string') imgLocal = up.local
      }
    }
  } catch {
    // 捕获/上传失败：降级仍创建记录（批注优先，仅缺本地副本）
  }
  await createScreenshotAnnotation(w, h, imgLocal)
}

/** 截图标注记录：无锚点字段、页内不渲染；创建即开编辑器（与图片标注同构） */
async function createScreenshotAnnotation(
  w: number,
  h: number,
  imgLocal?: string,
): Promise<void> {
  const id = uuid()
  const record = await create({
    id,
    url: pageUrl,
    title: document.title,
    quote: t('hl_screenshot_quote', [String(w), String(h)]),
    prefix: '',
    suffix: '',
    startOffset: null,
    endOffset: null,
    note: '',
    type: 'screenshot',
    color: 'yellow',
    seq: await nextSeq(pageUrl),
    imgLocal,
  })
  records.set(id, record)
  broadcastChange()
  openEditor(record)
}

// ---------- 悬停徽标：图片标注的唯一选中入口（不劫持图片点击） ----------

const IMG_MIN_SIZE = 48
let hoveredImg: HTMLImageElement | null = null

function hideImgBadge(): void {
  hoveredImg = null
  if (ui) ui.imgBadge.hidden = true
}

function positionImgBadge(img: HTMLImageElement): void {
  if (!active) return
  const { imgBadge } = ensureUi()
  const rect = img.getBoundingClientRect()
  imgBadge.textContent = img.getAttribute('data-notemarker-id') ? t('hl_note_badge') : t('hl_annotate')
  imgBadge.hidden = false
  // 先展示再量宽定位（右上角内侧）
  const w = imgBadge.offsetWidth
  const left = Math.max(rect.left + 2, Math.min(rect.right - w - 4, window.innerWidth - w - 4))
  imgBadge.style.left = `${left}px`
  imgBadge.style.top = `${Math.max(rect.top + 3, 3)}px`
}

function connectImgBadge(badge: HTMLButtonElement): void {
  badge.addEventListener('click', (e) => {
    e.stopPropagation()
    const img = hoveredImg
    hideImgBadge()
    if (!img) return
    const id = img.getAttribute('data-notemarker-id')
    if (id) {
      const rec = records.get(id)
      if (rec) openEditor(rec)
      return
    }
    void createImageAnnotation(img)
  })
}

// ---------- 侧栏消息联动（specs/extension-highlighter 与标注侧栏消息联动） ----------

/** 滚动到该标注并闪烁约 1 秒；返回是否定位成功（文字包裹与图片标注通用） */
function focusAnnotation(id: string): boolean {
  const el = anchorElOf(id)
  if (!el) return false
  el.classList.add('notemarker-flash')
  setTimeout(() => el.classList.remove('notemarker-flash'), 1200)
  el.scrollIntoView({ behavior: 'smooth', block: 'center' })
  return true
}

/** 标注变更广播：供侧栏等扩展页联动刷新；无接收方时静默 */
function broadcastChange(): void {
  try {
    void chrome.runtime.sendMessage({ notemarker: 'changed', url: pageUrl }).catch(() => {})
  } catch {
    /* ignore */
  }
}

chrome.runtime.onMessage.addListener((msg: { notemarker?: string; id?: string; type?: string; color?: string; cancel?: boolean }, _sender, sendResponse) => {
  // 只认 notemarker 命名空间；MUST NOT 响应 {message:'ping'}（剪藏脚本注入探测保留）
  if (!msg || typeof msg.notemarker !== 'string') return
  // 注入探测（background ensureHighlighterInjected）：站点停用时也要应答，避免重复注入
  if (msg.notemarker === 'ping') {
    sendResponse({ ready: true, active })
    return
  }
  if (!active) return // 站点停用：编辑器/联动全部静默

  if (msg.notemarker === 'pickRegion') {
    // 互斥双向：进入拾取时若截图模式活跃则退出（进入截图对拾取的抢占见 enterScreenshotMode）
    if (msg.cancel !== true && screenshotting) exitScreenshotMode()
    pickingRegion = msg.cancel !== true
    if (!pickingRegion) hideToolbar()
    sendResponse({ ok: true, picking: pickingRegion })
    return
  }
  if (msg.notemarker === 'screenshot') {
    // 侧栏「截图标记」入口（specs/screenshot-annotation）；划线停用时保持 false 由面板提示
    if (msg.cancel === true) exitScreenshotMode()
    else enterScreenshotMode()
    sendResponse({ ok: true, screenshotting })
    return
  }
  if (msg.notemarker === 'focus' && typeof msg.id === 'string') {
    sendResponse({ located: focusAnnotation(msg.id) })
    return
  }
  if (msg.notemarker === 'restyle' && typeof msg.id === 'string') {
    void (async () => {
      const type = msg.type === 'underline' ? 'underline' : 'highlight'
      const color = typeof msg.color === 'string' ? msg.color : 'yellow'
      const rec = records.get(msg.id)
      if (!rec) return
      await update(pageUrl, msg.id, { type, color })
      // 侧栏编辑可能同时改了批注文本：重读该条记录，标签与 records 缓存都用最新值
      const fresh = (await listByPage(pageUrl)).find((a) => a.id === msg.id)
      records.set(msg.id, fresh ?? { ...rec, type, color })
      restyleWrappers(msg.id, type, color)
      updateNoteLabel(msg.id, fresh?.note ?? rec.note, fresh?.seq ?? rec.seq)
      broadcastChange()
    })()
    sendResponse({ ok: true })
    return
  }
  if (msg.notemarker === 'remove' && typeof msg.id === 'string') {
    void (async () => {
      const rec = records.get(msg.id)
      if (rec) await deleteHighlight(rec)
      broadcastChange()
    })()
    sendResponse({ ok: true })
    return
  }
})

// ---------- 开关（specs highlighter-toggles：站点启停 / 标记显隐） ----------

/** 站点是否启用划线（active=false：工具条不弹、编辑器不响应、不恢复） */
let active = true
/** 标记是否可见（false：仅视觉隐藏 + 不可交互，数据与包裹保留） */
let marksVisible = true
/** document 级监听只装一次（启停切换不重复装拆，用 active 守卫） */
let wired = false

const HIDE_STYLE_ID = 'notemarker-marks-hidden'

function applyMarksVisible(): void {
  document.getElementById(HIDE_STYLE_ID)?.remove()
  if (!marksVisible) {
    const st = document.createElement('style')
    st.id = HIDE_STYLE_ID
    st.textContent = `
${HL_TAG} { background: transparent !important; border-bottom: none !important; outline: none !important; box-shadow: none !important; cursor: default !important; pointer-events: none !important; }
${NOTE_TAG} { display: none !important; }
`
    document.documentElement.appendChild(st)
  }
}

/** 站点停用即时生效：拆除全部渲染并收起 UI（数据不动） */
function deactivateVisual(): void {
  hideToolbar()
  hideEditor()
  document.querySelectorAll(HL_TAG).forEach((el) => {
    const parent = el.parentNode
    if (!parent) return
    while (el.firstChild) parent.insertBefore(el.firstChild, el)
    el.remove()
    parent.normalize()
  })
  document.querySelectorAll(NOTE_TAG).forEach((el) => el.remove())
  invalidateIndex()
  records.clear()
}

async function refreshSettings(): Promise<void> {
  // 生效链收口：active = 总开关开启 && 本站未停用（specs 全局总开关）
  const [master, disabled, show, colors] = await Promise.all([
    getMaster(),
    isSiteDisabled(originOf(location.href)),
    getShowMarks(),
    getColorPalette(),
  ])
  if (show !== marksVisible) {
    marksVisible = show
    applyMarksVisible()
  }
  // 调色板变更 → 重建样式 + 重建 UI 色点
  const paletteChanged = colors.some((c, i) => c !== palette[i])
  if (paletteChanged) {
    palette = colors
    injectStyles()
    // 重建 UI 让色点用新色值（重建前保存编辑态不需要——调色板变更时编辑器应已关闭）
    const editorWasHidden = ui?.editor.hidden ?? true
    document.getElementById('notemarker-highlighter-root')?.remove()
    ui = undefined
    wired = false
    if (active) {
      ensureUi()
      connectDocument()
      if (!editorWasHidden) ui.editor.hidden = false
    }
  }
  const nowActive = master && !disabled
  if (nowActive !== active) {
    active = nowActive
    if (active) {
      // 重新启用：即时恢复（免刷新）
      injectStyles()
      ensureUi()
      connectDocument()
      applyMarksVisible()
      void restore()
    } else {
      deactivateVisual()
    }
  }
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (
    area === 'local' &&
    (changes.highlighterMaster || changes.disabledSites || changes.showMarks || changes.colorPalette)
  ) {
    void refreshSettings()
  }
})

// ---------- 剪藏区域拾取（specs/clip-content 选区推断规则） ----------

/** 拾取模式：等待用户下一次有效选区，推断容器并写入本站规则 */
let pickingRegion = false

/** 已知正文容器（与 content.js 采集第 4 层候选同源，见 clip-main-content design） */
const KNOWN_CONTENT = 'article, main, [role="main"], #content, [class*="content"], .ProseMirror, .tiptap, .markdown-body'

function broadcastPick(payload: Record<string, unknown>): void {
  try {
    void chrome.runtime.sendMessage({ notemarkerRegionPicked: payload }).catch(() => {})
  } catch {
    /* 无接收方（面板未开）时忽略 */
  }
}

/** 生成稳定选择器：#id → 1-2 个稳定 class → tag:nth-of-type；必须回查唯一命中 */
function selectorFor(el: Element): string | null {
  const unique = (s: string): boolean => {
    try {
      return document.querySelectorAll(s).length === 1
    } catch {
      return false
    }
  }
  if (el.id && /^[A-Za-z][\w-]*$/.test(el.id) && unique(`#${el.id}`)) return `#${el.id}`
  const classes = Array.from(el.classList)
    .filter((c) => /^[\w-]+$/.test(c) && c.length > 2 && !/^(is|has|js)-/.test(c))
    .slice(0, 2)
  if (classes.length) {
    const joined = classes.map((c) => `.${c}`).join('')
    if (unique(joined)) return joined
    for (const c of classes) {
      if (unique(`.${c}`)) return `.${c}`
    }
  }
  const parent = el.parentElement
  if (parent) {
    const same = Array.from(parent.children).filter((c) => c.tagName === el.tagName)
    const s = `${el.tagName.toLowerCase()}:nth-of-type(${same.indexOf(el) + 1})`
    try {
      if (document.querySelector(s) === el) return s
    } catch {
      /* 降级失败 */
    }
  }
  return null
}

/** 两级推断：已知正文容器优先；否则沿祖先链自最高层向下取第一个"不含导航类元素"的祖先为内容块 */
function inferRegion(sel: Selection): { el: Element; selector: string; textLen: number } | null {
  const node = sel.getRangeAt(0).commonAncestorContainer
  const start = node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as Element | null)
  if (!start) return null
  const weight = (e: Element) => (e.textContent || '').replace(/\s+/g, '').length

  // 选区本身在导航/页眉页脚类区域：不是正文，直接失败
  if (start.closest('nav, aside, header, footer')) return null

  const known = start.closest(KNOWN_CONTENT)
  let el: Element
  if (known && known !== document.body) {
    el = known
  } else {
    // 祖先链 start→body；从最高层向下跳过"包含导航类元素"的应用外壳，取第一个纯内容祖先
    const chain: Element[] = []
    let cur: Element | null = start
    while (cur && cur !== document.body) {
      chain.push(cur)
      cur = cur.parentElement
    }
    el = start
    for (let i = chain.length - 1; i >= 0; i--) {
      if (!['NAV', 'ASIDE', 'HEADER', 'FOOTER'].some((t) => chain[i].querySelector(t))) {
        el = chain[i]
        break
      }
    }
  }

  const textLen = weight(el)
  if (el === document.body || el === document.documentElement || textLen < 50) return null
  const selector = selectorFor(el)
  if (!selector) return null
  return { el, selector, textLen }
}

/** 描边闪烁约 2 秒（内联样式，完还原值，不污染样式系统） */
function flashOutline(el: Element): void {
  const htmlEl = el as HTMLElement
  const prevOutline = htmlEl.style.outline
  const prevOffset = htmlEl.style.outlineOffset
  htmlEl.style.outline = '2px solid #f5a623'
  htmlEl.style.outlineOffset = '2px'
  setTimeout(() => {
    htmlEl.style.outline = prevOutline
    htmlEl.style.outlineOffset = prevOffset
  }, 2000)
}

/** 拾取模式下的一次性处理：有效选区 → 推断 → 写规则 → 描边 → 广播 */
function tryPickRegion(): void {
  const sel = window.getSelection()
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return // 继续等待有效选区
  if (!selectionUsable(sel)) return
  pickingRegion = false
  const inferred = inferRegion(sel)
  if (!inferred) {
    broadcastPick({ ok: false, reason: t('hl_region_failed') })
    return
  }
  void setClipRule(originOf(location.href), inferred.selector).then(() => {
    flashOutline(inferred.el)
    broadcastPick({ ok: true, selector: inferred.selector, textLen: inferred.textLen })
  })
}

// ---------- 事件接线 ----------

function connectDocument(): void {
  if (wired) return
  wired = true
  // 捕获阶段监听：先于任何页面处理器执行，避免被中间节点的 stopPropagation 拦掉
  // （部分站点在真实鼠标交互时吃掉 mouseup，合成事件测不出）
  document.addEventListener(
    'mouseup',
    () => {
      setTimeout(showToolbarForSelection, 10)
    },
    true,
  )
  document.addEventListener(
    'keyup',
    (e) => {
      if (e.shiftKey || e.key === 'Shift') setTimeout(showToolbarForSelection, 10)
    },
    true,
  )

  // selectionchange 兜底：选区变化即驱动工具条显隐（防页面清空/自绘选区绕开鼠标事件路径）；
  // 拾取模式下改为驱动区域推断
  let selTimer: number | undefined
  document.addEventListener('selectionchange', () => {
    clearTimeout(selTimer)
    selTimer = window.setTimeout(() => {
      if (pickingRegion) tryPickRegion()
      else showToolbarForSelection()
    }, 200)
  })

  // 点击既有高亮/其编号标签/已标注图片 → 打开批注编辑器；点击空白 → 收起编辑器
  document.addEventListener('click', (e) => {
    if (!active) return
    const target = e.target as Element | null
    if (!target || typeof target.closest !== 'function') return
    if (target.closest('#notemarker-highlighter-root')) return // 自身 UI
    const noteEl = target.closest(NOTE_TAG)
    const marked = noteEl ?? target.closest(`${HL_TAG}[data-id], img[data-notemarker-id]`)
    if (marked) {
      const id = marked.getAttribute('data-id') ?? marked.getAttribute('data-notemarker-id')
      const rec = id ? records.get(id) : undefined
      if (rec) openEditor(rec)
    } else {
      hideEditor()
    }
  })

  // 图片悬停徽标（捕获，与 selectionchange 体系并行）
  document.addEventListener(
    'mouseover',
    (e) => {
      if (!active || screenshotting) {
        hideImgBadge()
        return
      }
      const target = e.target as Element | null
      if (target && target.closest && target.closest('#notemarker-highlighter-root')) return // 徽标自身/面板 UI：保持现状
      const img = target?.closest?.('img') as HTMLImageElement | null
      if (!img || img.closest('#notemarker-extension-root')) {
        hideImgBadge()
        return
      }
      if ((img.naturalWidth || img.width) < IMG_MIN_SIZE || (img.naturalHeight || img.height) < IMG_MIN_SIZE) {
        hideImgBadge()
        return
      }
      if (inEditableArea(img)) {
        hideImgBadge()
        return
      }
      hoveredImg = img
      positionImgBadge(img)
    },
    true,
  )
  document.addEventListener(
    'mouseout',
    (e) => {
      const host = document.getElementById('notemarker-highlighter-root')
      if (e.target === hoveredImg && !(e.relatedTarget && host?.contains(e.relatedTarget as Node))) {
        hideImgBadge()
      }
    },
    true,
  )
  document.addEventListener('scroll', hideImgBadge, true)
  window.addEventListener('resize', hideImgBadge)

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      hideEditor()
      hideToolbar()
      if (screenshotting) exitScreenshotMode()
      if (pickingRegion) {
        pickingRegion = false
        broadcastPick({ ok: false, cancelled: true, reason: t('sidepanel_region_cancelled') })
      }
    }
  })
}

async function init(): Promise<void> {
  if (!document.body) {
    document.addEventListener('DOMContentLoaded', () => void init(), { once: true })
    return
  }
  // 站点/全局开关 + 调色板：停用时保持静默（storage.onChanged 监听已在模块顶层注册）
  const [master, disabled, show, colors] = await Promise.all([
    getMaster(),
    isSiteDisabled(originOf(location.href)),
    getShowMarks(),
    getColorPalette(),
  ])
  active = master && !disabled
  marksVisible = show
  palette = colors
  if (!active) return
  injectStyles()
  ensureUi()
  connectDocument()
  applyMarksVisible()
  void restore()
}

void init()

console.log('[notemarker] highlighter injected:', location.href)
