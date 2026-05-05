type Level = 'log' | 'info' | 'warn' | 'error' | 'debug'

interface Entry {
  ts: string
  level: Level
  text: string
}

let installed = false
let buffer: Entry[] = []
let capacity = 500

function stringifyArg(arg: unknown): string {
  if (arg instanceof Error) return arg.stack ?? `${arg.name}: ${arg.message}`
  if (typeof arg === 'string') return arg
  try {
    return JSON.stringify(arg)
  } catch {
    return String(arg)
  }
}

function push(level: Level, args: unknown[]): void {
  const text = args.map(stringifyArg).join(' ')
  buffer.push({ ts: new Date().toISOString(), level, text })
  if (buffer.length > capacity) buffer.splice(0, buffer.length - capacity)
}

export function installConsoleRingBuffer(size: number): void {
  if (installed) return
  installed = true
  capacity = size

  const original: Record<Level, (...args: unknown[]) => void> = {
    log: console.log.bind(console),
    info: console.info.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
    debug: console.debug.bind(console),
  }

  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    console[level] = (...args: unknown[]) => {
      push(level, args)
      original[level](...args)
    }
  }
}

export function getConsoleRingBuffer(): string {
  return buffer.map(e => `[${e.ts}] [${e.level}] ${e.text}`).join('\n')
}
