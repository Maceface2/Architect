import fs from 'fs'
import path from 'path'
import { app } from 'electron'

type LogLevel = 'info' | 'warn' | 'error'

const MAX_BYTES = 1_000_000

let logsDir: string | null = null
let logPath: string | null = null

function resolvePaths(): { dir: string; file: string } {
  if (logsDir && logPath) return { dir: logsDir, file: logPath }
  const dir = path.join(app.getPath('userData'), 'logs')
  fs.mkdirSync(dir, { recursive: true })
  logsDir = dir
  logPath = path.join(dir, 'main.log')
  return { dir, file: logPath }
}

function rotateIfNeeded(file: string): void {
  let size = 0
  try {
    size = fs.statSync(file).size
  } catch {
    return
  }
  if (size <= MAX_BYTES) return
  const backup = `${file}.1`
  try {
    fs.rmSync(backup, { force: true })
    fs.renameSync(file, backup)
  } catch {
    // best effort — if rotation fails we still want to keep logging
  }
}

export function logMain(level: LogLevel, msg: string, err?: unknown): void {
  const { file } = resolvePaths()
  const ts = new Date().toISOString()
  let line = `[${ts}] [${level}] ${msg}`
  if (err instanceof Error) {
    line += `\n${err.stack ?? err.message}`
  } else if (err !== undefined) {
    try {
      line += ` ${JSON.stringify(err)}`
    } catch {
      line += ` ${String(err)}`
    }
  }
  rotateIfNeeded(file)
  try {
    fs.appendFileSync(file, line + '\n', 'utf-8')
  } catch {
    // swallow — logger must never throw into the crash path
  }
}

export function getMainLogPath(): string {
  return resolvePaths().file
}

export function readMainLogTail(maxBytes: number): string {
  const { file } = resolvePaths()
  let size = 0
  try {
    size = fs.statSync(file).size
  } catch {
    return ''
  }
  if (size === 0) return ''
  const start = Math.max(0, size - maxBytes)
  const fd = fs.openSync(file, 'r')
  try {
    const len = size - start
    const buf = Buffer.alloc(len)
    fs.readSync(fd, buf, 0, len, start)
    let text = buf.toString('utf-8')
    if (start > 0) {
      const nl = text.indexOf('\n')
      if (nl >= 0) text = text.slice(nl + 1)
    }
    return text
  } finally {
    fs.closeSync(fd)
  }
}
