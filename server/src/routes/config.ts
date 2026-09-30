import { Router } from 'express'
import { getConfigView, saveConfig } from '../services/config'

export const configRouter = Router()

configRouter.get('/', (_req, res) => {
  res.status(200).json({ ok: true, ...getConfigView() })
})

configRouter.put('/', (req, res) => {
  // 未知字段被忽略（白名单合并），非法值由 saveConfig 抛 ApiError(400)
  const saved = saveConfig(req.body ?? {})
  res.status(200).json({ ok: true })
})
