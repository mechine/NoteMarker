// 页面标题存储（侧栏可编辑，默认回落标签页名）：
// chrome.storage.local 单键 pageTitles，按规范化页面 URL 记录 { title, dirty? }。
// dirty 标记待推送后端的标题（同步编排先推脏标题再推标注）；推送成功清除。
// 未设置（无记录）= 未编辑过，显示与同步都用采集到的标签页/页面标题。

const PAGE_TITLES_KEY = 'pageTitles'

export interface PageTitleEntry {
  title: string
  /** 待推送后端（PUT /pages/title）；推送成功后清除 */
  dirty?: true
}

type TitleMap = Record<string, PageTitleEntry>

async function readMap(): Promise<TitleMap> {
  return new Promise((resolve) => {
    chrome.storage.local.get(PAGE_TITLES_KEY, (result) => {
      const map = result?.[PAGE_TITLES_KEY]
      resolve(map && typeof map === 'object' ? (map as TitleMap) : {})
    })
  })
}

async function writeMap(map: TitleMap): Promise<void> {
  await chrome.storage.local.set({ [PAGE_TITLES_KEY]: map })
}

/** 用户设置的标题；未编辑过返回 null（调用方回落标签页名） */
export async function getPageTitle(url: string): Promise<string | null> {
  const e = (await readMap())[url]
  return e?.title ?? null
}

/** 全部标题映射（同步时覆盖标注记录自带的 title 用） */
export async function getAllPageTitles(): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const [url, e] of Object.entries(await readMap())) out[url] = e.title
  return out
}

/** 保存标题并标记待推送 */
export async function setPageTitle(url: string, title: string): Promise<void> {
  if (!url || !title) return
  const map = await readMap()
  map[url] = { title, dirty: true }
  await writeMap(map)
}

/** 待推送标题列表（同步编排入口用） */
export async function listDirtyPageTitles(): Promise<Array<{ url: string; title: string }>> {
  return Object.entries(await readMap())
    .filter(([, e]) => e.dirty === true)
    .map(([url, e]) => ({ url, title: e.title }))
}

/** 推送成功：清 dirty 保留标题 */
export async function clearDirtyPageTitle(url: string): Promise<void> {
  const map = await readMap()
  if (map[url]?.dirty) {
    map[url] = { title: map[url].title }
    await writeMap(map)
  }
}
