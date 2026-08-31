import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface HistoryEntry { timestamp: string; task: string; modules: string[]; testType: string; total: number; passed: number; failed: number; skipped: number; durationMs: number }
const MAX_HISTORY = 100
export function historyDir(projectRoot: string): string { return join(projectRoot, '.dsh', 'test-history') }
export function loadPrevious(projectRoot: string): HistoryEntry | null {
  const dir = historyDir(projectRoot)
  if (!existsSync(dir)) return null
  let files: string[] = []
  try { files = readdirSync(dir).filter((x: string) => x.endsWith('.json')).sort().reverse() } catch { return null }
  for (const file of files) {
    try { return JSON.parse(readFileSync(join(dir, file), 'utf8')) as HistoryEntry } catch {}
  }
  return null
}
export function saveHistory(projectRoot: string, entry: HistoryEntry): void {
  const dir = historyDir(projectRoot)
  mkdirSync(dir, { recursive: true })
  const safe = entry.timestamp.replace(/[:.]/g, '-')
  const tmp = join(dir, `.${safe}.tmp`)
  const target = join(dir, `${safe}.json`)
  writeFileSync(tmp, JSON.stringify(entry, null, 2), 'utf8')
  try { renameSync(tmp, target) } catch { try { unlinkSync(target) } catch {}; try { renameSync(tmp, target) } catch {} }
  try {
    const files = readdirSync(dir).filter((x: string) => x.endsWith('.json')).sort()
    for (const old of files.slice(0, Math.max(0, files.length - MAX_HISTORY))) unlinkSync(join(dir, old))
  } catch {}
}
export function compareSummary(previous: HistoryEntry | null, current: HistoryEntry): { previousAvailable: boolean; failedDelta: number; durationDeltaMs: number } {
  if (!previous) return { previousAvailable: false, failedDelta: 0, durationDeltaMs: 0 }
  const sameShape = previous.testType === current.testType
    && previous.task === current.task
    && previous.modules.length === current.modules.length
    && previous.modules.every((module, index) => module === current.modules[index])
  if (!sameShape) return { previousAvailable: false, failedDelta: 0, durationDeltaMs: 0 }
  return { previousAvailable: true, failedDelta: current.failed - previous.failed, durationDeltaMs: current.durationMs - previous.durationMs }
}
