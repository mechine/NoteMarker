import os from 'node:os'
import path from 'node:path'

/** 知识库根目录：默认 ~/kb，环境变量 KB_HOME 覆盖 */
export const KB_HOME = process.env.KB_HOME
  ? path.resolve(process.env.KB_HOME)
  : path.join(os.homedir(), 'kb')

export const PORT = Number(process.env.PORT ?? 8765)
export const HOST = '127.0.0.1'
