// 本地优先标注库（specs/extension-sync，design D8）：
// chrome.storage.local 单键 annotations，按规范化页面 URL 分桶。
// content script（划线读写）与 background（同步改状态）共用；写放大可接受（万级记录 <5MB）。

export type SyncState = 'pending' | 'synced'
export type LocalAnnotationType = 'highlight' | 'underline' | 'image' | 'screenshot'

export interface LocalAnnotation {
  /** 客户端 UUID：同步时直通服务端（design D1），deduped 场景采用服务端返回 id */
  id: string
  /** 规范化页面 URL（分桶键） */
  url: string
  /** 页面标题：同步时补全 pages.title（页面可能从未剪藏） */
  title: string
  quote: string
  prefix: string
  suffix: string
  startOffset: number | null
  endOffset: number | null
  note: string
  type: LocalAnnotationType
  color: string
  syncState: SyncState
  updatedAt: number
  /** 页内自增编号（specs/extension-highlighter 标注编号）：纯本地元数据，不同步；删除不重排、编号不复用 */
  seq?: number
  /** 图片标注锚点（specs image-annotation）：仅本地与恢复用，不同步 */
  imgSrc?: string
  imgAlt?: string
  /** 同 src 图片中的 document 序号 */
  imgIndex?: number
  /** 图片标注自动存图结果（specs image-annotation 自动存图）：content/images/{hash}.{ext}，仅本地不同步 */
  imgLocal?: string
  /** tombstone：仅"曾 synced 后删除"保留（design 删除同步） */
  deleted?: true
}

export type NewLocalAnnotation = Omit<LocalAnnotation, 'syncState' | 'updatedAt' | 'deleted'>

const STORE_KEY = 'annotations'

type Bucket = LocalAnnotation[]
type StoreMap = Record<string, Bucket>

/** URL 规范化：复刻 server/src/services/url.ts（去 fragment、pathname 去尾斜杠），保证本地键与后端 url_hash 语义一致 */
export function normalizePageUrl(input: string): string {
  const u = new URL(input)
  u.hash = ''
  if (u.pathname !== '/') {
    u.pathname = u.pathname.replace(/\/+$/, '') || '/'
  }
  return u.toString()
}

/** crypto.randomUUID 在非安全上下文（纯 http 页面）可能缺失，兜底手写 v4 */
export function uuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  const buf = new Uint8Array(16)
  crypto.getRandomValues(buf)
  buf[6] = (buf[6] & 0x0f) | 0x40
  buf[8] = (buf[8] & 0x3f) | 0x80
  const hex = Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

async function readMap(): Promise<StoreMap> {
  return new Promise((resolve) => {
    chrome.storage.local.get(STORE_KEY, (result) => {
      const map = result?.[STORE_KEY]
      resolve(map && typeof map === 'object' ? (map as StoreMap) : {})
    })
  })
}

async function writeMap(map: StoreMap): Promise<void> {
  await chrome.storage.local.set({ [STORE_KEY]: map })
}

async function mutateBucket(url: string, fn: (bucket: Bucket) => boolean): Promise<boolean> {
  const map = await readMap()
  const bucket = map[url] ?? []
  if (!fn(bucket)) return false
  map[url] = bucket
  await writeMap(map)
  return true
}

/** 该页全部未删除记录（页面加载恢复用） */
export async function listByPage(url: string): Promise<LocalAnnotation[]> {
  const map = await readMap()
  return (map[url] ?? []).filter((a) => !a.deleted)
}

export async function create(input: NewLocalAnnotation): Promise<LocalAnnotation> {
  const record: LocalAnnotation = { ...input, syncState: 'pending', updatedAt: Date.now() }
  await mutateBucket(input.url, (bucket) => {
    bucket.push(record)
    return true
  })
  return record
}

export async function update(
  url: string,
  id: string,
  patch: Partial<
    Pick<LocalAnnotation, 'note' | 'color' | 'type' | 'quote' | 'prefix' | 'suffix' | 'imgLocal'>
  >,
): Promise<LocalAnnotation | undefined> {
  let updated: LocalAnnotation | undefined
  await mutateBucket(url, (bucket) => {
    const i = bucket.findIndex((a) => a.id === id && !a.deleted)
    if (i === -1) return false
    bucket[i] = { ...bucket[i], ...patch, syncState: 'pending', updatedAt: Date.now() }
    updated = bucket[i]
    return true
  })
  return updated
}

/** 删除：曾 synced → tombstone（同步时删服务端）；pending 新建即删 → 物理删除 */
export async function softDelete(url: string, id: string): Promise<void> {
  await mutateBucket(url, (bucket) => {
    const i = bucket.findIndex((a) => a.id === id && !a.deleted)
    if (i === -1) return false
    if (bucket[i].syncState === 'synced') {
      bucket[i] = { ...bucket[i], deleted: true, updatedAt: Date.now() }
    } else {
      bucket.splice(i, 1)
    }
    return true
  })
}

/** 同步成功后清除 tombstone */
export async function removeTombstone(url: string, id: string): Promise<void> {
  await mutateBucket(url, (bucket) => {
    const i = bucket.findIndex((a) => a.id === id && a.deleted)
    if (i === -1) return false
    bucket.splice(i, 1)
    return true
  })
}

/** 全部待推送（跨页面，非删除、pending） */
export async function listPending(): Promise<LocalAnnotation[]> {
  const map = await readMap()
  return Object.values(map)
    .flat()
    .filter((a) => !a.deleted && a.syncState === 'pending')
}

/** 曾同步成功、待删除的 tombstone（同步时逐条 DELETE） */
export async function listSyncedTombstones(): Promise<LocalAnnotation[]> {
  const map = await readMap()
  return Object.values(map)
    .flat()
    .filter((a) => a.deleted === true && a.syncState === 'synced')
}

/** 单条同步成功：标记 synced；deduped 场景服务端返回不同 id 时采用之 */
export async function markSynced(url: string, localId: string, serverId?: string): Promise<void> {
  await mutateBucket(url, (bucket) => {
    const i = bucket.findIndex((a) => a.id === localId && !a.deleted)
    if (i === -1) return false
    bucket[i] = { ...bucket[i], id: serverId ?? localId, syncState: 'synced' }
    return true
  })
}

export async function countPending(): Promise<number> {
  return (await listPending()).length
}

// ---------- 缓存清理与回源（specs/extension-sync 本地缓存上限与整页桶清理 / 被清理页面重访回源） ----------

const EVICTED_KEY = 'evictedPages'

/** 全部未删除记录总数（pending + synced，跨页面） */
export async function countActive(): Promise<number> {
  const map = await readMap()
  let n = 0
  for (const bucket of Object.values(map)) n += bucket.filter((a) => !a.deleted).length
  return n
}

/**
 * 超限整桶 LRU 清理（design D1/D3）：仅当桶内全部记录 synced 且无 tombstone 才可清
 * （pending 未到服务端、tombstone 删除未确认，清了即丢语义）；按桶内最大 updatedAt 升序
 * （最久未活动的页面先清）逐桶清到 limit 的 90%（留缓冲避免临界反复清理）。
 * limit<=0 不清理。幂等重入：重算总数，无超限即空操作。返回清理的记录数。
 * 每清一桶把 URL 记入 evictedPages 索引（重访回源判定，design D2）。
 */
export async function evictOverLimit(limit: number): Promise<number> {
  if (limit <= 0) return 0
  const map = await readMap()
  let total = 0
  for (const bucket of Object.values(map)) total += bucket.filter((a) => !a.deleted).length
  if (total <= limit) return 0
  const target = Math.floor(limit * 0.9)

  const evictable: Array<{ url: string; size: number; lastTouched: number }> = []
  for (const [url, bucket] of Object.entries(map)) {
    if (!bucket.length) continue
    if (!bucket.every((a) => !a.deleted && a.syncState === 'synced')) continue
    evictable.push({
      url,
      size: bucket.length,
      lastTouched: bucket.reduce((m, a) => Math.max(m, a.updatedAt), 0),
    })
  }
  evictable.sort((x, y) => x.lastTouched - y.lastTouched)

  const evictedUrls: string[] = []
  let removed = 0
  let n = total
  for (const e of evictable) {
    if (n <= target) break
    delete map[e.url]
    n -= e.size
    removed += e.size
    evictedUrls.push(e.url)
  }
  if (removed > 0) {
    await writeMap(map)
    await addEvictedPages(evictedUrls)
  }
  return removed
}

async function readEvicted(): Promise<string[]> {
  return new Promise((resolve) => {
    chrome.storage.local.get(EVICTED_KEY, (result) => {
      const v = result?.[EVICTED_KEY]
      resolve(Array.isArray(v) ? (v as string[]) : [])
    })
  })
}

export async function isEvicted(url: string): Promise<boolean> {
  return (await readEvicted()).includes(url)
}

async function addEvictedPages(urls: string[]): Promise<void> {
  if (!urls.length) return
  const list = await readEvicted()
  const next = Array.from(new Set([...list, ...urls]))
  if (next.length !== list.length) await chrome.storage.local.set({ [EVICTED_KEY]: next })
}

async function removeEvictedPage(url: string): Promise<void> {
  const list = await readEvicted()
  if (!list.includes(url)) return
  await chrome.storage.local.set({ [EVICTED_KEY]: list.filter((u) => u !== url) })
}

/** 回源拉回的服务端标注记录（api.ts Annotation 的写入子集） */
export interface ServerAnnotationItem {
  id: string
  quote: string
  prefix: string | null
  suffix: string | null
  startOffset: number | null
  endOffset: number | null
  note: string
  type: string
  color: string
}

/**
 * 回源重建整桶（design D4/D5）：以服务端返回记录整桶替换（synced、采用服务端 id），
 * 按返回顺序（created_at 序）直接补 seq；成功（含空列表）即移除 evictedPages 索引项。
 * 调用方保证仅在本地桶为空时调用——不会覆盖本地未同步修改。
 */
export async function replaceBucketFromServer(url: string, items: ServerAnnotationItem[]): Promise<void> {
  await mutateBucket(url, (bucket) => {
    bucket.length = 0
    bucket.push(
      ...items.map((s, i) => ({
        id: s.id,
        url,
        // 页面标题仅在同步时用于补全 server pages.title，恢复渲染不读它
        title: '',
        quote: s.quote,
        prefix: s.prefix ?? '',
        suffix: s.suffix ?? '',
        startOffset: s.startOffset,
        endOffset: s.endOffset,
        note: s.note ?? '',
        type: s.type as LocalAnnotationType,
        color: s.color,
        syncState: 'synced' as const,
        updatedAt: Date.now(),
        seq: i + 1,
      })),
    )
    return true
  })
  await removeEvictedPage(url)
}

/** 管理页"标注同步"视图：全部未删除记录（跨页面），按更新时间倒序 */
export async function listAll(): Promise<LocalAnnotation[]> {
  const map = await readMap()
  return Object.values(map)
    .flat()
    .filter((a) => !a.deleted)
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

// ---------- 页内编号（specs/extension-highlighter 标注编号） ----------

/** 该页下一个编号：基于原始桶（含 tombstone）取最大 seq +1，保证已删编号不被复用 */
export async function nextSeq(url: string): Promise<number> {
  const map = await readMap()
  return (map[url] ?? []).reduce((m, a) => Math.max(m, a.seq ?? 0), 0) + 1
}

/**
 * 存量迁移：桶内无 seq 的记录（含 tombstone）按桶内顺序（即创建顺序）补分配编号。
 * 已有 seq 的记录保持不变；全部已有编号时幂等无写入。
 */
export async function assignSeqs(url: string): Promise<void> {
  await mutateBucket(url, (bucket) => {
    if (bucket.every((a) => typeof a.seq === 'number')) return false
    let n = bucket.reduce((m, a) => Math.max(m, a.seq ?? 0), 0)
    for (let i = 0; i < bucket.length; i++) {
      if (typeof bucket[i].seq !== 'number') {
        bucket[i] = { ...bucket[i], seq: ++n }
      }
    }
    return true
  })
}
