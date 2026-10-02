import fs from 'node:fs'
import path from 'node:path'
import express, { type NextFunction, type Request, type Response } from 'express'
import { KB_HOME, APP_ROOT, HOST, PORT } from './env'
import { db } from './db/client'
import { loadConfig, setTrustedExtensionId } from './services/config'
import { flushDirtySidecars } from './services/sidecar'
import { pingRouter } from './routes/ping'
import { configRouter } from './routes/config'
import { annotationsRouter } from './routes/annotations'
import { messagesRouter } from './routes/messages'
import { exportRouter } from './routes/export'
import { imagesRouter } from './routes/images'
import { pagesRouter } from './routes/pages'
import { ApiError } from './errors'

// 知识库目录初始化（建库在 db 模块加载时完成）
fs.mkdirSync(path.join(APP_ROOT, 'content', 'images'), { recursive: true })
loadConfig()

const app = express()

// 来源校验：只信任已配对的扩展上下文，防止任意网页跨站读写本机 KB。
// - 带 Origin：必须是 chrome-extension://<id> 且与已配对 id 一致（首次见到即配对，TOFU）。
//   Origin 由浏览器控制、网页无法伪造，恶意页面（https://...）直接拒绝。
// - 无 Origin：放行非浏览器客户端（curl/Node 脚本）与地址栏直达（Sec-Fetch-Site: none），
//   拒绝明确的浏览器跨站请求（cross-site/same-site，兜底 CSRF 表单等向量）。
// - Host 校验：仅接受回环地址，防 DNS rebinding。
const EXTENSION_ORIGIN = /^chrome-extension:\/\/([a-p]{32})$/
const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`])

app.use((req, res, next) => {
  if (!ALLOWED_HOSTS.has(req.headers.host ?? '')) {
    res.status(403).json({ ok: false, error: 'forbidden_host', message: '非法 Host 头' })
    return
  }
  const origin = req.headers.origin
  if (origin !== undefined) {
    const m = EXTENSION_ORIGIN.exec(origin)
    const trusted = loadConfig().trustedExtensionId
    if (m && (trusted === null || trusted === m[1])) {
      if (trusted === null) {
        setTrustedExtensionId(m[1])
        console.log(`[server] 已配对扩展 chrome-extension://${m[1]}（写入 config.json → trustedExtensionId）`)
      }
      // 扩展经 host_permissions 本就不受 CORS 限制，显式回显便于排查
      res.setHeader('Access-Control-Allow-Origin', origin)
      res.setHeader('Vary', 'Origin')
      if (req.method === 'OPTIONS') {
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
        res.sendStatus(204)
        return
      }
      next()
      return
    }
    res.status(403).json({
      ok: false,
      error: m ? 'unregistered_extension' : 'forbidden_origin',
      message: m
        ? `扩展 ${m[1]} 未配对：编辑 ${path.join(APP_ROOT, 'config.json')} 的 trustedExtensionId 后重启服务`
        : '仅允许已配对的浏览器扩展访问',
    })
    return
  }
  const secFetchSite = req.headers['sec-fetch-site']
  if (secFetchSite === 'cross-site' || secFetchSite === 'same-site') {
    res.status(403).json({ ok: false, error: 'forbidden_origin', message: '拒绝跨站请求' })
    return
  }
  next()
})

// 导出时 HTML 可能较大（接口文档设计要点：50 MB 上限）
app.use(express.json({ limit: '50mb' }))

app.use('/ping', pingRouter)
app.use('/config', configRouter)
app.use('/annotations', annotationsRouter)
app.use('/messages', messagesRouter)
app.use('/pages', pagesRouter)
app.use('/export', exportRouter)
app.use('/images', imagesRouter)

app.use((_req, res) => {
  res.status(404).json({ ok: false, error: 'not_found', message: '接口不存在' })
})

// 统一错误格式：{ ok:false, error(机器码), message(人话) }（specs/local-backend 统一错误格式）
app.use((err: Error & { type?: string }, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof ApiError) {
    res.status(err.status).json({ ok: false, error: err.code, message: err.message })
    return
  }
  if (err.type === 'entity.parse.failed') {
    res.status(400).json({ ok: false, error: 'invalid_json', message: '请求体不是合法 JSON' })
    return
  }
  if ((err as { statusCode?: number; type?: string }).statusCode === 413 || err.type === 'entity.too.large') {
    res.status(413).json({ ok: false, error: 'payload_too_large', message: '请求体超过大小上限' })
    return
  }
  console.error('[server] unhandled error:', err)
  res.status(500).json({ ok: false, error: 'internal', message: '服务器内部错误' })
})

// 侧车定时刷（specs kb-rebuild）：脏页 5 分钟批量落盘（SIDECAR_FLUSH_MS 可覆盖，运维/测试用）；
// unref 使定时器不阻碍进程退出
const SIDECAR_FLUSH_MS = Number(process.env.SIDECAR_FLUSH_MS ?? 5 * 60 * 1000)
const sidecarTimer = setInterval(() => {
  const n = flushDirtySidecars()
  if (n > 0) console.log(`[server] sidecar flushed: ${n} page(s)`)
}, SIDECAR_FLUSH_MS)
sidecarTimer.unref?.()

// 停机冲刷（Ctrl+C / kill）：把脏页窗口归零；尽力而为，失败也照常退出
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    try {
      flushDirtySidecars()
    } catch {
      /* 尽力而为 */
    }
    process.exit(0)
  })
}

app.listen(PORT, HOST, () => {
  console.log(`[server] notemarker kb backend listening at http://${HOST}:${PORT}`)
  console.log(`[server] KB_HOME=${KB_HOME}（共享基础目录），项目数据根=${APP_ROOT}`)
})
