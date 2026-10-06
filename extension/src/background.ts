// 剪藏导出走本地 REST：/ping 预检 + POST /export（design D2）
// 同步编排（design D9）：收集本地 pending → 批量 upsert → 逐条删除 tombstone；badge 反映待同步数
// 侧栏（annotation-side-panel design D1/D4）：图标单击打开 Side Panel，剪藏抽为 clipTab 由面板触发
import { t } from './scripts/i18n'
import {
  deleteAnnotation,
  exportPage,
  listAnnotations,
  ping,
  syncAnnotationsBatch,
  updatePageTitle,
  uploadImage,
  type SyncItemInput,
} from './scripts/api'
import {
  countPending,
  evictOverLimit,
  listPending,
  listSyncedTombstones,
  markSynced,
  removeTombstone,
  replaceBucketFromServer,
  type LocalAnnotation,
} from './scripts/storage/annotations'
import { getCacheLimit, getMaster, getShowMarks, isSiteDisabled, originOf, setMaster, setSiteDisabled, setShowMarks } from './scripts/storage/settings'
import { clearDirtyPageTitle, getAllPageTitles, listDirtyPageTitles } from './scripts/storage/pages'
import { isPageSavePayload } from './scripts/types'

// ---------- 图标行为：优先打开侧栏；老版本 Chrome（<114 无 sidePanel）回退为点击剪藏 ----------

const sidePanelAvailable =
  typeof chrome.sidePanel !== 'undefined' && typeof chrome.sidePanel.setPanelBehavior === 'function'

if (sidePanelAvailable) {
  // 显式关闭"点击即开面板"托管行为：该路径不触发 action.onClicked，activeTab 授权不可靠
  // （点击激活模型依赖 onClicked 授权注入，见下方 chrome.action.onClicked）
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {})
}

// ---------- 剪藏（原 action.onClicked 流程抽函数，供面板按钮与降级路径复用） ----------

/** 探测并按需注入剪藏脚本 content.js（幂等） */
async function ensureContentInjected(tabId: number): Promise<boolean> {
  try {
    if (!(await clipScriptReady(tabId))) {
      await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] })
    }
    return true
  } catch (err) {
    // 受限页面（chrome:// 等）注入失败：静默降级（规格约定）
    console.warn('[notemarker] cannot inject clip script (restricted page?):', err)
    return false
  }
}

/** 探测并按需注入划线脚本 highlighter.js（幂等；点击激活模型——面板打开/换页时由 activateTab 触发） */
async function ensureHighlighterInjected(tabId: number): Promise<boolean> {
  try {
    const res = await chrome.tabs.sendMessage(tabId, { notemarker: 'ping' })
    if (res?.ready === true) return true
  } catch {
    /* 未注入，走注入 */
  }
  try {
    // 页面侧有重复注入守卫，探测漏检时重注入也无害
    await chrome.scripting.executeScript({ target: { tabId }, files: ['highlighter.js'] })
    return true
  } catch (err) {
    // 受限页面或 activeTab 未授权（未点击图标即换页）：静默降级
    console.warn('[notemarker] cannot inject highlighter (inactive tab?):', err)
    return false
  }
}

/** 旧直连剪藏路径（图标降级 onClicked 用）：注入 → 采集保存（无 toast，静默） */
async function clipTab(tabId: number): Promise<void> {
  if (!(await ensureContentInjected(tabId))) return
  void chrome.tabs.sendMessage(tabId, { notemarkerClip: 'save' }).catch(() => {
    // 注入后理论必达；兜底吞掉未处理拒绝，避免 SW 控制台噪音
  })
}

/** 预览流程第一步：注入 → 采集（specs/clip-content 分层策略）→ 转发面板预览 */
async function collectForPreview(tabId: number, mode?: string): Promise<void> {
  if (!(await ensureContentInjected(tabId))) return
  try {
    const res = await chrome.tabs.sendMessage(tabId, { notemarkerClip: 'collect', mode })
    if (!res?.ok) return
    await chrome.runtime.sendMessage({
      clipPreview: {
        title: res.title,
        html: res.html,
        mode: res.mode,
        textLen: res.textLen,
        images: res.images ?? [],
        url: res.url,
      },
    })
  } catch (err) {
    // 面板未开等场景：无接收方，忽略
    console.log('[notemarker] collect for preview failed:', err)
  }
}

// 图标单击（specs extension-highlighter 点击激活模型）：onClicked 属用户手势——
// activeTab 授权确定生效，随后开面板 + 注入划线脚本（面板打开后其 activateTab 路由幂等兜底）
chrome.action.onClicked.addListener((tab) => {
  if (!tab.id) return
  if (sidePanelAvailable) {
    void chrome.sidePanel.open({ tabId: tab.id }).catch((err) => {
      console.log('[notemarker] open side panel failed:', err)
    })
  } else {
    // 降级：无 Side Panel API 的老 Chrome 保留旧行为（图标单击 = 剪藏）
    void clipTab(tab.id)
  }
  void ensureHighlighterInjected(tab.id).then((ok) => {
    if (ok && tab.id !== undefined) markTabActivated(tab.id)
  })
})

// ---------- 手动同步（specs/extension-sync，design D9） ----------

export interface SyncSummary {
  offline: boolean
  pushed: number
  failed: number
  deleted: number
  deleteFailed: number
}

const BATCH_CHUNK = 500

function toSyncItem(a: LocalAnnotation, titleOverride?: string): SyncItemInput {
  return {
    id: a.id,
    pageUrl: a.url,
    // 用户在侧栏改过的标题优先（随标注创建补全 server pages.title）
    pageTitle: titleOverride ?? a.title,
    quote: a.quote,
    prefix: a.prefix,
    suffix: a.suffix,
    startOffset: a.startOffset,
    endOffset: a.endOffset,
    note: a.note,
    type: a.type,
    color: a.color,
    // 旧记录（升级前创建）无 createdAt：不传，服务端保持自有值/默认写入
    createdAt: typeof a.createdAt === 'number' ? new Date(a.createdAt).toISOString() : undefined,
  }
}

async function doSync(): Promise<SyncSummary> {
  const summary: SyncSummary = { offline: false, pushed: 0, failed: 0, deleted: 0, deleteFailed: 0 }
  await chrome.action.setBadgeText({ text: '…' })
  try {
    // 先推送用户改过的页面标题（侧栏标题编辑，PUT /pages/title）：
    // 失败保留 dirty 下次再试；后端无该页时不代创建（首次标注同步会携带 pageTitle 建页）
    for (const d of await listDirtyPageTitles()) {
      const r = await updatePageTitle(d.url, d.title)
      if (r.offline) {
        summary.offline = true
        break
      }
      if (r.json?.ok) await clearDirtyPageTitle(d.url)
    }

    const pending = summary.offline ? [] : await listPending()
    // 用户标题覆盖：同页标注统一用侧栏设置的标题建页/补全
    const titleOverrides = await getAllPageTitles()
    for (let i = 0; i < pending.length; i += BATCH_CHUNK) {
      const chunk = pending.slice(i, i + BATCH_CHUNK)
      const r = await syncAnnotationsBatch(chunk.map((a) => toSyncItem(a, titleOverrides[a.url])))
      if (r.offline || !r.json?.ok) {
        summary.offline = r.offline
        summary.failed += chunk.length
        break
      }
      for (const res of r.json.results) {
        const local = chunk[res.index]
        if (!local) continue
        if (res.ok) {
          // deduped 场景服务端可能返回不同 id，采用服务端权威 id（design D1）
          await markSynced(local.url, local.id, res.id && res.id !== local.id ? res.id : undefined)
          summary.pushed++
        } else {
          summary.failed++
        }
      }
    }

    if (!summary.offline) {
      for (const t of await listSyncedTombstones()) {
        const r = await deleteAnnotation(t.id)
        if (!r.offline && r.json?.ok) {
          await removeTombstone(t.url, t.id)
          summary.deleted++
        } else {
          summary.deleteFailed++
          if (r.offline) {
            summary.offline = true
            break
          }
        }
      }
    }
  } finally {
    // 同步收尾触发缓存清理（specs/extension-sync 本地缓存上限，design D3）：
    // 同步刚结束时全部可推记录必为 synced，是天然安全点；offline 跳过（本地必有 pending，本就无可清桶）
    if (!summary.offline) {
      const removed = await evictOverLimit(await getCacheLimit())
      if (removed > 0) console.log('[notemarker] annotation cache evicted:', removed)
    }
    await updateBadge()
  }
  return summary
}

/** 并发触发（面板/管理页/右键菜单）串行执行，各自拿到自己那次的结果 */
let syncChain: Promise<SyncSummary> | null = null

function runSync(): Promise<SyncSummary> {
  syncChain = (syncChain ?? Promise.resolve()).then(doSync, doSync)
  return syncChain
}

// ---------- 直连同步（specs/extension-sync 标注即同步）：本地库有变更即防抖自动推送 ----------

const AUTO_SYNC_DEBOUNCE_MS = 2000
let autoSyncTimer: ReturnType<typeof setTimeout> | undefined

/**
 * 防抖触发一次同步：合并短时间连发（连续划线/批注只打一次接口）。
 * 同步自身的 markSynced/tombstone 清理也会写 annotations 再触发本调度——
 * 无 pending 且无 tombstone 时直接跳过，避免空转循环。
 * 失败静默（离线等）：记录保持 pending、badge 可见，下次变更/启动/手动同步再试。
 */
function scheduleAutoSync(): void {
  if (autoSyncTimer) clearTimeout(autoSyncTimer)
  autoSyncTimer = setTimeout(() => {
    autoSyncTimer = undefined
    void (async () => {
      if (
        !(await countPending()) &&
        !(await listSyncedTombstones()).length &&
        !(await listDirtyPageTitles()).length
      )
        return
      const s = await runSync()
      if (!s.offline && (s.failed || s.deleteFailed)) {
        console.log('[notemarker] auto sync partial failure:', JSON.stringify(s))
      }
    })()
  }, AUTO_SYNC_DEBOUNCE_MS)
}

// ---------- badge：待同步数可见（specs/extension-sync） ----------

async function updateBadge(): Promise<void> {
  try {
    const n = await countPending()
    await chrome.action.setBadgeText({ text: n > 0 ? String(n) : '' })
    if (n > 0) await chrome.action.setBadgeBackgroundColor({ color: '#c2410c' })
  } catch (err) {
    console.log('[notemarker] update badge failed:', err)
  }
}

// 本地库任何变更（含 content script 写入）都刷新 badge，并防抖触发直连同步（specs 标注即同步）
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.annotations) {
    void updateBadge()
    scheduleAutoSync()
  }
})
void updateBadge()
scheduleAutoSync() // SW 启动兜底：清掉上次离线/关浏览器遗留的 pending

// ---------- 激活状态图标（点击激活模型）：当前标签已激活=彩色，未激活=灰阶 ----------

/** 会话内已激活标签（storage.session 兜底：SW 被杀重启可恢复；浏览器重启自动清空，与 activeTab 语义一致） */
let activatedTabs = new Set<number>()

async function loadActivatedTabs(): Promise<void> {
  try {
    const v = (await chrome.storage.session.get('activatedTabs')).activatedTabs
    if (Array.isArray(v)) activatedTabs = new Set(v.filter((x): x is number => typeof x === 'number'))
  } catch {
    /* 无 storage.session 支持（老 Chrome）时退化为仅内存态 */
  }
}

function persistActivatedTabs(): void {
  void chrome.storage.session.set({ activatedTabs: [...activatedTabs] }).catch(() => {})
}

/** 灰阶图标：OffscreenCanvas 运行时生成（无需准备灰阶素材），SW 生命周期内缓存 */
let grayIcons: Record<string, ImageData> | undefined

async function getGrayIcons(): Promise<Record<string, ImageData>> {
  if (grayIcons) return grayIcons
  const out: Record<string, ImageData> = {}
  for (const size of [16, 48, 128] as const) {
    try {
      const resp = await fetch(chrome.runtime.getURL(`icons/icon-${size}.png`))
      const bitmap = await createImageBitmap(await resp.blob())
      const ctx = new OffscreenCanvas(size, size).getContext('2d')!
      ctx.drawImage(bitmap, 0, 0)
      const data = ctx.getImageData(0, 0, size, size)
      const px = data.data
      for (let i = 0; i < px.length; i += 4) {
        const lum = Math.round(px[i] * 0.299 + px[i + 1] * 0.587 + px[i + 2] * 0.114)
        px[i] = px[i + 1] = px[i + 2] = lum
      }
      out[String(size)] = data
    } catch (err) {
      console.warn('[notemarker] gray icon build failed:', size, err)
    }
  }
  grayIcons = out
  return out
}

const COLOR_ICON_PATH = { 16: 'icons/icon-16.png', 48: 'icons/icon-48.png', 128: 'icons/icon-128.png' }

/** 按标签刷新图标：探测页面真实状态（防刷新/跳转后残留彩色），已激活=彩色，否则=灰阶 */
async function refreshActionIcon(tabId: number): Promise<void> {
  let ready = false
  try {
    const res = await chrome.tabs.sendMessage(tabId, { notemarker: 'ping' })
    ready = res?.ready === true
  } catch {
    /* 无监听者=未激活 */
  }
  if (ready) {
    if (!activatedTabs.has(tabId)) {
      activatedTabs.add(tabId)
      persistActivatedTabs()
    }
  } else if (activatedTabs.delete(tabId)) {
    persistActivatedTabs()
  }
  try {
    if (ready) await chrome.action.setIcon({ tabId, path: COLOR_ICON_PATH })
    else await chrome.action.setIcon({ tabId, imageData: await getGrayIcons() })
  } catch {
    /* 标签已关闭/受限页等 */
  }
}

/** 激活成功后立即点亮（activateTab 路由调用；探测兜底在 tabs 事件里） */
function markTabActivated(tabId: number): void {
  if (activatedTabs.has(tabId)) return
  activatedTabs.add(tabId)
  persistActivatedTabs()
  void chrome.action.setIcon({ tabId, path: COLOR_ICON_PATH }).catch(() => {})
}

// ---------- 图标右键菜单：同步 / 打开管理页 ----------

chrome.runtime.onInstalled.addListener((details) => {
  chrome.contextMenus.create({ id: 'notemarker-sync', title: t('menu_sync'), contexts: ['action'] })
  chrome.contextMenus.create({ id: 'notemarker-open-manage', title: t('menu_open_manage'), contexts: ['action'] })
  // 开关勾选项（specs highlighter-toggles + sidebar-settings-reader 全局总开关）
  chrome.contextMenus.create({ id: 'notemarker-master-toggle', type: 'checkbox', title: t('menu_master'), checked: true, contexts: ['action'] })
  chrome.contextMenus.create({ id: 'notemarker-site-toggle', type: 'checkbox', title: t('menu_site'), checked: true, contexts: ['action'] })
  chrome.contextMenus.create({ id: 'notemarker-marks-toggle', type: 'checkbox', title: t('menu_marks'), checked: true, contexts: ['action'] })
  void updateMenuChecks()
  // 首次安装引导：打开管理页并定位到设置视图（快速开始卡片在设置视图顶部，服务未连接时显示）
  if (details.reason === 'install') {
    void chrome.tabs.create({ url: `${chrome.runtime.getURL('src/views/options.html')}?view=settings` })
  }
})

chrome.contextMenus.onClicked.addListener((info) => {
  if (info.menuItemId === 'notemarker-sync') {
    void runSync().then((s) => console.log('[notemarker] sync done:', JSON.stringify(s)))
  } else if (info.menuItemId === 'notemarker-open-manage') {
    chrome.runtime.openOptionsPage()
  } else if (info.menuItemId === 'notemarker-master-toggle') {
    void setMaster(info.checked === true)
  } else if (info.menuItemId === 'notemarker-site-toggle') {
    // info.checked 为点击后的新状态；origin 优先取点击时活动页地址
    const origin = typeof info.pageUrl === 'string' ? originOf(info.pageUrl) : ''
    if (origin) void setSiteDisabled(origin, !info.checked)
  } else if (info.menuItemId === 'notemarker-marks-toggle') {
    void setShowMarks(info.checked === true)
  }
})

/** 勾选态跟随活动标签页的站点与全局设置（切页/切换后刷新） */
async function updateMenuChecks(): Promise<void> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    const origin = typeof tab?.url === 'string' ? originOf(tab.url) : ''
    const [master, disabled, show] = await Promise.all([
      getMaster(),
      origin ? isSiteDisabled(origin) : Promise.resolve(false),
      getShowMarks(),
    ])
    void chrome.contextMenus.update('notemarker-master-toggle', { checked: master })
    void chrome.contextMenus.update('notemarker-site-toggle', { checked: !disabled })
    void chrome.contextMenus.update('notemarker-marks-toggle', { checked: show })
  } catch (err) {
    console.log('[notemarker] update menu checks failed:', err)
  }
}

chrome.tabs.onActivated.addListener((activeInfo) => {
  void updateMenuChecks()
  void refreshActionIcon(activeInfo.tabId)
})
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'complete') {
    void updateMenuChecks()
    // 刷新/跳转后划线脚本消失：探测失败自动变灰（面板开着会随即重新激活点亮）
    void refreshActionIcon(tabId)
  }
})
chrome.tabs.onRemoved.addListener((tabId) => {
  if (activatedTabs.delete(tabId)) persistActivatedTabs()
})
// SW 冷启动：恢复会话激活集，并校正当前活动标签图标
void loadActivatedTabs().then(async () => {
  const id = await activeTabId()
  if (id !== undefined) void refreshActionIcon(id)
})
// 设置经侧栏等入口变化后同步勾选态
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.highlighterMaster || changes.disabledSites || changes.showMarks)) {
    void updateMenuChecks()
  }
})

// ---------- 消息路由 ----------

async function activeTabId(): Promise<number | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  return tab?.id
}

chrome.runtime.onMessage.addListener((message, sender, _sendResponse) => {

  if (message?.action === 'openOptions') {
    chrome.runtime.openOptionsPage()
    return false
  }

  ;(async () => {
    if (message.action === 'saveCollected' && isPageSavePayload(message)) {
      // 旧直连路径（无侧栏老 Chrome）：服务预检 + 导出；toast 已移除，本路径静默（反馈面在侧栏）
      const { url, title, html } = message
      const health = await ping()
      if (!health.online) return
      await exportPage({ pageUrl: url, pageTitle: title, html })
    } else if (message.action === 'sync') {
      // 面板/管理页/右键菜单触发：返回成败汇总（specs/extension-sync 手动同步推送）
      _sendResponse(await runSync())
    } else if (message.action === 'clipPage') {
      // 侧栏"剪藏本页"：预览流程（specs/clip-content 剪藏预览）——采集回面板确认后才导出
      const id = await activeTabId()
      if (id) await collectForPreview(id, message.mode)
      _sendResponse({ ok: id !== undefined })
    } else if (message.action === 'activateTab') {
      // 点击激活（specs extension-highlighter 点击激活模型）：侧栏打开/换页时注入划线脚本到当前页
      const id = await activeTabId()
      const ok = id !== undefined && (await ensureHighlighterInjected(id))
      if (ok && id !== undefined) markTabActivated(id)
      _sendResponse({ ok })
    } else if (message.action === 'uploadImage') {
      // 图片本地化中转（specs/clip-content 图片本地化）：content.js 上传经扩展上下文调 /images
      const r = await uploadImage(message.data, message.filename)
      _sendResponse({ ok: !r.offline && r.json?.ok === true, local: r.json?.local, offline: r.offline })
    } else if (message.action === 'refetchPage' && typeof message.url === 'string') {
      // 被清页回源（specs/extension-sync 被清理页面重访回源，design D4）：
      // 拉取该页全部标注重建本地桶；成功（含空列表）移除清理索引项；失败静默空结果（下次加载重试）
      const r = await listAnnotations(message.url)
      if (r.offline || r.json?.ok !== true) {
        _sendResponse({ ok: false })
      } else {
        await replaceBucketFromServer(message.url, r.json.annotations)
        _sendResponse({ ok: true, count: r.json.annotations.length })
      }
    } else if (message.action === 'exportCollected') {
      // 预览确认"保存"：提交导出并反馈（面板 + 页面 toast）；
      // 勾选"本地保存图片"时先执行两步流第一步（页面抓图上传 + 引用改写，specs 图片本地化）
      const { url, title } = message as { url: string; title: string }
      let html = message.html as string
      let imageStats: { total: number; localized: number; failed: number } | undefined
      if (message.localize && Array.isArray(message.urls) && message.urls.length > 0) {
        const tabId = await activeTabId()
        if (tabId) {
          try {
            const loc = await chrome.tabs.sendMessage(tabId, { notemarkerClip: 'localizeImages', urls: message.urls })
            if (loc?.ok && typeof loc.html === 'string') {
              html = loc.html
              imageStats = loc.stats
            }
          } catch (err) {
            // 本地化整体失败：按原 HTML 导出（降级不阻塞）
            console.log('[notemarker] localize images failed:', err)
          }
        }
      }
      // toast 已移除（specs remove-clip-toast）：成败反馈统一由面板消息区承担
      const health = await ping()
      if (!health.online) {
        _sendResponse({ ok: false, offline: true })
        return
      }
      const r = await exportPage({ pageUrl: url, pageTitle: title, html })
      _sendResponse({
        ok: r.result === 'success',
        offline: r.result === 'offline',
        message: r.message,
        filePath: r.filePath,
        duplicate: r.duplicate === true,
        imageStats,
      })
    } else if (message.action === 'startScreenshot') {
      // 侧栏「截图标记」（specs/screenshot-annotation）：通知活动页划线脚本进入截图模式；
      // 回执区分失败原因（页面未注入/划线停用），面板据此给可操作的提示
      const id = await activeTabId()
      if (!id) {
        _sendResponse({ ok: false, reason: 'unsupported' })
        return
      }
      let entered = false
      let reason = 'inactive'
      try {
        const r = await chrome.tabs.sendMessage(id, { notemarker: 'screenshot' })
        entered = r?.screenshotting === true
      } catch {
        // 划线脚本未注入：扩展更新后页面未刷新（旧注入实例已断连）或受限页面
        reason = 'no-receiver'
      }
      _sendResponse({ ok: entered, reason: entered ? undefined : reason })
    } else if (message.action === 'captureTab') {
      // 可视区域捕获（specs/screenshot-annotation）：物理像素 PNG dataUrl，裁剪在页面侧做（design D1）
      try {
        const dataUrl = await chrome.tabs.captureVisibleTab(
          sender.tab?.windowId ?? chrome.windows.WINDOW_ID_CURRENT,
          { format: 'png' },
        )
        _sendResponse({ ok: true, dataUrl })
      } catch (err) {
        console.log('[notemarker] captureVisibleTab failed:', err)
        _sendResponse({ ok: false })
      }
    } else if (message.action === 'pickRegion') {
      // 框选剪藏区域：转发到活动标签页的划线脚本进入/退出拾取（specs/clip-content 选区推断规则）
      const id = await activeTabId()
      if (id) {
        void chrome.tabs.sendMessage(id, { notemarker: 'pickRegion', cancel: message.cancel === true }).catch(() => {})
      }
      _sendResponse({ ok: true })
    }
  })()

  return true
})

/** 注入探测：只有剪藏脚本 content.js 会应答 ping（常驻划线脚本不注册 ping 应答，见 highlighter 头注） */
async function clipScriptReady(tabId: number): Promise<boolean> {
  try {
    const res = await chrome.tabs.sendMessage(tabId, { message: 'ping' })
    return res?.ready === true
  } catch {
    return false
  }
}
