import fs from 'fs'
import os from 'os'
import path from 'path'
import { app } from 'electron'
import { readFileTail } from './fileTail'

type LogLevel = 'info' | 'warn' | 'error'

const MAX_BYTES = 1_000_000

let logPath: string | null = null

function resolveLogPath(): string {
  if (logPath) return logPath
  // app.getPath('userData') throws before app is ready; fall back to tmpdir
  // so an exception during early imports still gets logged somewhere.
  let dir: string
  try {
    dir = path.join(app.getPath('userData'), 'logs')
  } catch {
    dir = path.join(os.tmpdir(), 'Architect', 'logs')
  }
  try {
    fs.mkdirSync(dir, { recursive: true })
  } catch {
    // best effort — appendFileSync will surface the failure if the dir is
    // genuinely unwritable, and logMain swallows that.
  }
  logPath = path.join(dir, 'main.log')
  return logPath
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
  const file = resolveLogPath()
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
  return resolveLogPath()
}

export function readMainLogTail(maxBytes: number): string {
  return readFileTail(resolveLogPath(), maxBytes)
}
