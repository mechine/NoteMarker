import fs from 'node:fs'
import path from 'node:path'
import { KB_HOME } from '../env'
import { ApiError } from '../errors'

export interface KbConfig {
  dedupeWindow: number
  maxCacheSize: number
  autoExportEnabled: boolean
  autoExportDelay: number
  /** 已配对扩展 ID（TOFU：首次见到 chrome-extension:// Origin 时固化；null 表示未配对） */
  trustedExtensionId: string | null
}

const CONFIG_PATH = path.join(KB_HOME, 'config.json')

export const DEFAULT_CONFIG: KbConfig = {
  dedupeWindow: 5,
  maxCacheSize: 524288000,
  autoExportEnabled: true,
  autoExportDelay: 5,
  trustedExtensionId: null,
}

/** 白名单字段与校验规则（specs/server-config） */
const INT_KEYS = ['dedupeWindow', 'maxCacheSize', 'autoExportDelay'] as const
const BOOL_KEYS = ['autoExportEnabled'] as const

let cached: KbConfig | null = null

export function loadConfig(): KbConfig {
  if (cached) return cached
  let merged: KbConfig = { ...DEFAULT_CONFIG }
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
    merged = { ...merged, ...pickWhitelisted(raw) }
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error('[config] 读取失败，使用默认值:', err)
    }
  }
  cached = merged
  return merged
}

/** 部分更新：白名单合并、校验、原子写回（临时文件 + rename） */
export function saveConfig(patch: Record<string, unknown>): KbConfig {
  const current = loadConfig()
  const next = { ...current }
  for (const key of INT_KEYS) {
    if (patch[key] !== undefined) {
      const v = patch[key]
      if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) {
        throw new ApiError(400, 'invalid_request', `${key} 必须是非负整数`)
      }
      next[key] = v
    }
  }
  for (const key of BOOL_KEYS) {
    if (patch[key] !== undefined) {
      const v = patch[key]
      if (typeof v !== 'boolean') {
        throw new ApiError(400, 'invalid_request', `${key} 必须是布尔值`)
      }
      next[key] = v
    }
  }
  writeConfig(next)
  return next
}

/** 配对扩展（TOFU 注册）：仅中间件调用，不经 PUT /config 白名单 */
export function setTrustedExtensionId(id: string): KbConfig {
  const next = { ...loadConfig(), trustedExtensionId: id }
  writeConfig(next)
  return next
}

function writeConfig(next: KbConfig): void {
  const tmp = `${CONFIG_PATH}.tmp`
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true })
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8')
  fs.renameSync(tmp, CONFIG_PATH)
  cached = next
}

export function getConfigView() {
  const c = loadConfig()
  return { outputDir: KB_HOME, ...c }
}

function pickWhitelisted(raw: unknown): Partial<KbConfig> {
  const out: Partial<KbConfig> = {}
  if (!raw || typeof raw !== 'object') return out
  for (const key of [...INT_KEYS, ...BOOL_KEYS]) {
    const v = (raw as Record<string, unknown>)[key]
    if (v !== undefined) (out as Record<string, unknown>)[key] = v
  }
  const trusted = (raw as Record<string, unknown>).trustedExtensionId
  if (typeof trusted === 'string' || trusted === null) out.trustedExtensionId = trusted
  return out
}
