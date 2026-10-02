import os from 'node:os'
import path from 'node:path'

/** 知识库基础目录（多项目共享）：默认 ~/kb，环境变量 KB_HOME 覆盖 */
export const KB_HOME = process.env.KB_HOME
  ? path.resolve(process.env.KB_HOME)
  : path.join(os.homedir(), 'kb')

/** 本项目数据根：KB_HOME 下的独立子目录，避免与其他项目的数据混放 */
export const APP_ROOT = path.join(KB_HOME, 'notemarker')

export const PORT = Number(process.env.PORT ?? 8765)
export const HOST = '127.0.0.1'
