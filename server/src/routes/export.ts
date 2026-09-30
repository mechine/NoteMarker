import { Router } from 'express'
import { exportPage, previewExport } from '../services/export'

export const exportRouter = Router()

// Express 4 不会自动捕获 async 处理器的异常，需显式 next(err) 交给统一错误中间件
exportRouter.post('/', async (req, res, next) => {
  try {
    const result = await exportPage(req.body ?? {})
    res.status(200).json(result)
  } catch (err) {
    next(err)
  }
})

exportRouter.post('/preview', (req, res) => {
  const result = previewExport(req.body ?? {})
  res.status(200).json(result)
})
