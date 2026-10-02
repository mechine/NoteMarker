// 侧车快照（specs kb-rebuild）：content/{pageId}.anno.json 是 pages + annotations + messages 的全量快照，
// 二级后缀 .anno.json 定位为注解通用协议文件（annotation sidecar），与普通 .json 区分；
// 坏库重建（src/rebuild.ts）从此文件恢复。写入时机（用户约定：不为单次标注付文件 IO）：
// - 剪藏导出（/export）立即写（saveJson 开关控制，沿旧行为）
// - 其余标注/消息变更只做内存脏页标记，由 index.ts 的 5 分钟定时器批量刷盘
// - 停机（SIGINT/SIGTERM）时冲刷一次，把丢失窗口归零
import fs from 'node:fs'
import path from 'node:path'
import { APP_ROOT } from '../env'
import { getPageById } from '../db/repositories/pages'
import { listAnnotationsByPage } from '../db/repositories/annotations'
import { listMessagesByPage } from '../db/repositories/messages'

export const CONTENT_DIR = path.join(APP_ROOT, 'content')

/** 脏页集合：已变更未刷盘的 pageId（进程内存态；进程被强杀丢最后 ≤5 分钟，见 spec） */
const dirty = new Set<string>()

export function markSidecarDirty(pageId: string): void {
  dirty.add(pageId)
}

/**
 * 把某页当前库内状态写为侧车快照（与 /export 落盘结构同一份，含 messages）。
 * 页面已不存在（被删除）时清脏标记并返回 false——不为已删页复活侧车。
 */
export function writeSidecar(pageId: string, trigger: string = 'snapshot'): boolean {
  const page = getPageById(pageId)
  if (!page) {
    dirty.delete(pageId)
    return false
  }
  const sidecar = {
    page: {
      id: page.id,
      url: page.url,
      title: page.title,
      site: page.site,
      trigger,
      exportedAt: new Date().toISOString(),
      contentHash: page.content_hash,
    },
    annotations: listAnnotationsByPage(pageId),
    messages: listMessagesByPage(pageId),
  }
  fs.mkdirSync(CONTENT_DIR, { recursive: true })
  fs.writeFileSync(path.join(CONTENT_DIR, `${pageId}.anno.json`), JSON.stringify(sidecar, null, 2), 'utf8')
  dirty.delete(pageId)
  return true
}

/** 刷全部脏页（定时器/停机调用）；返回本次实际写盘的页数 */
export function flushDirtySidecars(): number {
  const ids = Array.from(dirty)
  let n = 0
  for (const id of ids) {
    if (writeSidecar(id)) n++
  }
  return n
}
