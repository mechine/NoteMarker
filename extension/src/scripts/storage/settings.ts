// 开关设置（specs highlighter-toggles）：
// - disabledSites: 停用划线的站点 origin 列表（缺省 [] = 全站启用）
// - showMarks: 全局标记显隐（缺省 true）
// 供划线脚本（守卫）、侧栏（开关 UI）、background（右键勾选项）共用。

const DISABLED_SITES_KEY = 'disabledSites'
const SHOW_MARKS_KEY = 'showMarks'

export function originOf(url: string): string {
  try {
    return new URL(url).origin
  } catch {
    return ''
  }
}

async function readKey<T>(key: string, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    chrome.storage.local.get(key, (result) => {
      const v = result?.[key]
      resolve(v === undefined ? fallback : (v as T))
    })
  })
}

async function writeKey(key: string, value: unknown): Promise<void> {
  await chrome.storage.local.set({ [key]: value })
}

export async function getDisabledSites(): Promise<string[]> {
  const v = await readKey<string[]>(DISABLED_SITES_KEY, [])
  return Array.isArray(v) ? v : []
}

export async function isSiteDisabled(origin: string): Promise<boolean> {
  return origin ? (await getDisabledSites()).includes(origin) : false
}

export async function setSiteDisabled(origin: string, disabled: boolean): Promise<void> {
  if (!origin) return
  const list = await getDisabledSites()
  const next = disabled ? (list.includes(origin) ? list : [...list, origin]) : list.filter((o) => o !== origin)
  if (next.length !== list.length || next.some((o) => !list.includes(o))) {
    await writeKey(DISABLED_SITES_KEY, next)
  }
}

export async function getShowMarks(): Promise<boolean> {
  return readKey<boolean>(SHOW_MARKS_KEY, true)
}

export async function setShowMarks(show: boolean): Promise<void> {
  await writeKey(SHOW_MARKS_KEY, show)
}

// ---------- 全局总开关（specs highlighter-toggles 全局总开关） ----------

const HIGHLIGHTER_MASTER_KEY = 'highlighterMaster'

export async function getMaster(): Promise<boolean> {
  return readKey<boolean>(HIGHLIGHTER_MASTER_KEY, true)
}

export async function setMaster(enabled: boolean): Promise<void> {
  await writeKey(HIGHLIGHTER_MASTER_KEY, enabled)
}

// ---------- 自定义调色板（specs 颜色槽位自定义） ----------

const COLOR_PALETTE_KEY = 'colorPalette'

/** 5 个色槽的默认值（与原硬编码一致，向后兼容） */
export const DEFAULT_PALETTE = ['#ffd234', '#34c759', '#2f80ed', '#ff69b4', '#ff453a']

/** 色槽标识（存储/同步用名称，渲染用调色板色值） */
export const COLOR_SLOTS = ['yellow', 'green', 'blue', 'pink', 'red'] as const

export async function getColorPalette(): Promise<string[]> {
  const v = await readKey<string[]>(COLOR_PALETTE_KEY, DEFAULT_PALETTE)
  return Array.isArray(v) && v.length === 5 ? v : DEFAULT_PALETTE
}

export async function setColorPalette(colors: string[]): Promise<void> {
  if (colors.length !== 5) return
  await writeKey(COLOR_PALETTE_KEY, colors)
}

/** 名称 → 当前调色板色值（旧标注按名称查槽位；未知名称回退灰） */
export function paletteHex(palette: string[], name: string): string {
  const i = COLOR_SLOTS.indexOf(name as (typeof COLOR_SLOTS)[number])
  return i >= 0 ? palette[i] : '#999999'
}

const CLIP_RULES_KEY = 'clipRegionRules'

export async function getClipRules(): Promise<Record<string, string>> {
  const v = await readKey<Record<string, string>>(CLIP_RULES_KEY, {})
  return v && typeof v === 'object' ? v : {}
}

export async function getClipRule(origin: string): Promise<string> {
  if (!origin) return ''
  return (await getClipRules())[origin] ?? ''
}

/** selector 传空串/null 即清除该站规则 */
export async function setClipRule(origin: string, selector: string | null): Promise<void> {
  if (!origin) return
  const rules = await getClipRules()
  const next = { ...rules }
  if (selector && selector.trim()) next[origin] = selector.trim()
  else delete next[origin]
  await writeKey(CLIP_RULES_KEY, next)
}

// ---------- 本地缓存上限（specs/extension-sync 本地缓存上限与整页桶清理） ----------

const CACHE_LIMIT_KEY = 'annotationCacheLimit'

export const DEFAULT_CACHE_LIMIT = 10000

/** 本地标注库记录数上限：0 = 永不清理（缺省 10000） */
export async function getCacheLimit(): Promise<number> {
  const v = await readKey<number>(CACHE_LIMIT_KEY, DEFAULT_CACHE_LIMIT)
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : DEFAULT_CACHE_LIMIT
}

export async function setCacheLimit(limit: number): Promise<void> {
  await writeKey(CACHE_LIMIT_KEY, Math.max(0, Math.floor(limit)))
}
