import fs from 'fs'

export function readFileTail(file: string, maxBytes: number): string {
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
