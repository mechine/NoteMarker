import { randomUUID } from 'node:crypto'
import { db } from '../client'

export interface MessageRow {
  id: string
  page_id: string
  message_id: string
  role: string | null
  text: string
  content_hash: string
  sequence: number | null
  captured_at: string
}

export function findMessage(pageId: string, messageId: string): MessageRow | undefined {
  return db
    .prepare('SELECT * FROM messages WHERE page_id = ? AND message_id = ?')
    .get(pageId, messageId) as MessageRow | undefined
}

export function insertMessage(input: {
  pageId: string
  messageId: string
  role?: string | null
  text: string
  contentHash: string
  sequence?: number | null
}): string {
  const id = randomUUID()
  db.prepare(
    `INSERT INTO messages (id, page_id, message_id, role, text, content_hash, sequence)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, input.pageId, input.messageId, input.role ?? null, input.text, input.contentHash, input.sequence ?? null)
  return id
}

/** 同一 (page, messageId) 内容变化时更新快照（设计：消息快照 spec"内容变化时更新"场景） */
export function updateMessageContent(id: string, text: string, contentHash: string): void {
  db.prepare(
    "UPDATE messages SET text = ?, content_hash = ?, captured_at = CURRENT_TIMESTAMP WHERE id = ?",
  ).run(text, contentHash, id)
}

export function listMessagesByPage(pageId: string): MessageRow[] {
  // SQLite 升序中 NULL 排最前；带序号的快照按序排前，无序号的按捕获时间垫后
  return db
    .prepare(
      'SELECT * FROM messages WHERE page_id = ? ORDER BY (sequence IS NULL), sequence, captured_at',
    )
    .all(pageId) as unknown as MessageRow[]
}
