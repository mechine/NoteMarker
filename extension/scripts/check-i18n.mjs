// 语言资源完整性校验（specs extension-i18n）：en 与 zh_CN 键集合必须一致，差异非零退出
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const localesDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', '_locales')

function keysOf(locale) {
  return new Set(Object.keys(JSON.parse(readFileSync(join(localesDir, locale, 'messages.json'), 'utf8'))))
}

const en = keysOf('en')
const zh = keysOf('zh_CN')
const missingZh = [...en].filter((k) => !zh.has(k)).sort()
const missingEn = [...zh].filter((k) => !en.has(k)).sort()

if (missingZh.length || missingEn.length) {
  for (const k of missingZh) console.error(`zh_CN/messages.json 缺键: ${k}`)
  for (const k of missingEn) console.error(`en/messages.json 缺键: ${k}`)
  process.exit(1)
}
console.log(`i18n ok: en/zh_CN 各 ${en.size} 键一致`)
