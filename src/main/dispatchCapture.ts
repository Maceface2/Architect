import fs from 'fs'
import { join } from 'path'

export interface DispatchRecord {
  architectSessionId: string
  zoneIds: string[]
  zoneLabels: string[]
  userPrompt: string
  model: string
  planMode: boolean
  timestamp: string
}

const DISPATCHES_SUBDIR = 'dispatches'

function dispatchesDir(projectDir: string): string {
  return join(projectDir, 'ARCHITECT', DISPATCHES_SUBDIR)
}

export function saveDispatch(projectDir: string, record: DispatchRecord): void {
  const dir = dispatchesDir(projectDir)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    join(dir, `${record.architectSessionId}.json`),
    JSON.stringify(record, null, 2),
  )
}

export function listDispatches(projectDir: string): DispatchRecord[] {
  const dir = dispatchesDir(projectDir)
  let entries: string[]
  try {
    entries = fs.readdirSync(dir).filter(name => name.endsWith('.json'))
  } catch {
    return []
  }
  const records: DispatchRecord[] = []
  for (const name of entries) {
    try {
      const parsed = JSON.parse(fs.readFileSync(join(dir, name), 'utf-8')) as DispatchRecord
      if (typeof parsed?.architectSessionId === 'string' && Array.isArray(parsed.zoneIds)) {
        records.push(parsed)
      }
    } catch {}
  }
  records.sort((a, b) => (b.timestamp ?? '').localeCompare(a.timestamp ?? ''))
  return records
}
