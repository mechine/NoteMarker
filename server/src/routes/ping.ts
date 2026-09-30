import fs from 'node:fs'
import path from 'node:path'
import { Router } from 'express'
import { KB_HOME } from '../env'
import { DB_PATH } from '../db/client'

export const pingRouter = Router()

function serverVersion(): string {
  try {
    // dist/routes/ping.js → 上两级即 server/package.json
    const pkgPath = path.join(__dirname, '..', '..', 'package.json')
    return JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
}

pingRouter.get('/', (_req, res) => {
  res.status(200).json({
    ok: true,
    version: serverVersion(),
    uptime: Math.floor(process.uptime()),
    dbPath: DB_PATH,
    outputDir: KB_HOME,
  })
})
