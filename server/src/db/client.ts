import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { APP_ROOT } from '../env'

export const DB_PATH = path.join(APP_ROOT, 'kb.db')

/**
 * 数据模型文档"最终表设计（精简版）"：4 张表 + 索引 + FTS5 触发器。
 * 相对文档 SQL 的两处调整：
 * - 驱动用 Node 内建 node:sqlite（better-sqlite3 预编译产物在当前网络环境无法下载，见 design D2）
 * - FTS5 加 tokenize='trigram'：默认 unicode61 分词器把中文整串当一个词，无法子串检索
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS pages (
  id            TEXT PRIMARY KEY,
  url           TEXT NOT NULL,
  url_hash      TEXT NOT NULL UNIQUE,
  title         TEXT,
  site          TEXT,
  page_type     TEXT DEFAULT 'article',
  content_hash  TEXT,
  annotation_count INTEGER DEFAULT 0,
  read_status   TEXT DEFAULT 'unread',
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS messages (
  id            TEXT PRIMARY KEY,
  page_id       TEXT NOT NULL,
  message_id    TEXT NOT NULL,
  role          TEXT,
  text          TEXT NOT NULL,
  content_hash  TEXT NOT NULL,
  sequence      INTEGER,
  captured_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (page_id) REFERENCES pages(id) ON DELETE CASCADE,
  UNIQUE(page_id, message_id)
);

CREATE INDEX IF NOT EXISTS idx_messages_page ON messages(page_id, sequence);

CREATE TABLE IF NOT EXISTS annotations (
  id            TEXT PRIMARY KEY,
  page_id       TEXT NOT NULL,
  message_id    TEXT,
  quote         TEXT NOT NULL,
  prefix        TEXT,
  suffix        TEXT,
  start_offset  INTEGER,
  end_offset    INTEGER,
  note          TEXT DEFAULT '',
  type          TEXT DEFAULT 'highlight',
  color         TEXT DEFAULT 'yellow',
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (page_id) REFERENCES pages(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_annotations_page ON annotations(page_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_annotations_unique
  ON annotations(page_id, message_id, start_offset, end_offset);
-- 跨页查询（specs/annotations-api 跨页查询标注）按 created_at 倒序分页
CREATE INDEX IF NOT EXISTS idx_annotations_created_at ON annotations(created_at DESC);

CREATE TABLE IF NOT EXISTS images (
  id            TEXT PRIMARY KEY,
  hash          TEXT NOT NULL UNIQUE,
  original_url  TEXT,
  uploaded_url  TEXT,
  filename      TEXT,
  mime_type     TEXT,
  size_bytes    INTEGER,
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_images_hash ON images(hash);

CREATE VIRTUAL TABLE IF NOT EXISTS annotations_fts USING fts5(
  quote, note,
  content='annotations',
  content_rowid='rowid',
  tokenize='trigram'
);

CREATE TRIGGER IF NOT EXISTS annotations_ai AFTER INSERT ON annotations BEGIN
  INSERT INTO annotations_fts(rowid, quote, note) VALUES (new.rowid, new.quote, new.note);
END;

CREATE TRIGGER IF NOT EXISTS annotations_ad AFTER DELETE ON annotations BEGIN
  INSERT INTO annotations_fts(annotations_fts, rowid, quote, note)
  VALUES ('delete', old.rowid, old.quote, old.note);
END;

CREATE TRIGGER IF NOT EXISTS annotations_au AFTER UPDATE ON annotations BEGIN
  INSERT INTO annotations_fts(annotations_fts, rowid, quote, note)
  VALUES ('delete', old.rowid, old.quote, old.note);
  INSERT INTO annotations_fts(rowid, quote, note) VALUES (new.rowid, new.quote, new.note);
END;
`

function openDb(): DatabaseSync {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true })
  const db = new DatabaseSync(DB_PATH)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')
  db.exec(SCHEMA)
  migrate(db)
  return db
}

/** 存量库加列迁移（幂等）：pages.read_status，旧行回填 'unread'（design D3） */
function migrate(db: DatabaseSync): void {
  const cols = db.prepare('PRAGMA table_info(pages)').all() as Array<{ name: string }>
  if (!cols.some((c) => c.name === 'read_status')) {
    db.exec("ALTER TABLE pages ADD COLUMN read_status TEXT DEFAULT 'unread'")
  }
}

/** 进程级单例：模块首次加载时建库（幂等，重复启动不报错） */
export const db = openDb()
