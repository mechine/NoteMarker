import { randomUUID } from 'node:crypto'
import { db } from '../client'

export interface ImageRow {
  id: string
  hash: string
  original_url: string | null
  uploaded_url: string | null
  filename: string | null
  mime_type: string | null
  size_bytes: number | null
  created_at: string
}

export function findImageByHash(hash: string): ImageRow | undefined {
  return db.prepare('SELECT * FROM images WHERE hash = ?').get(hash) as ImageRow | undefined
}

export function insertImage(input: {
  hash: string
  originalUrl?: string | null
  filename?: string | null
  mimeType?: string | null
  sizeBytes?: number | null
}): string {
  const id = randomUUID()
  db.prepare(
    `INSERT INTO images (id, hash, original_url, uploaded_url, filename, mime_type, size_bytes)
     VALUES (?, ?, ?, NULL, ?, ?, ?)`,
  ).run(id, input.hash, input.originalUrl ?? null, input.filename ?? null, input.mimeType ?? null, input.sizeBytes ?? null)
  return id
}
