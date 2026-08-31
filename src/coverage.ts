import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

export interface CoverageSummary { available: boolean; linePercent: number; branchPercent: number; instructionPercent: number; methodPercent: number; classPercent: number; reportFiles: number }
function walk(dir: string, files: string[], depth: number): void {
  if (depth > 6) return
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const e of entries) {
    const p = join(dir, e.name)
    if (e.isDirectory()) walk(p, files, depth + 1)
    else if (e.isFile() && /jacoco.*\.xml$/i.test(e.name)) files.push(p)
  }
}
function attr(tag: string, name: string): string {
  const match = new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, 'i').exec(tag)
  return match ? match[1] ?? '' : ''
}
function counter(xml: string, type: string): { covered: number; missed: number } | null {
  const re = new RegExp(`<counter\\b[^>]*type=["']${type}["'][^>]*/?>`, 'gi')
  let last: string | null = null
  let m: RegExpExecArray | null
  while ((m = re.exec(xml)) !== null) last = m[0]
  if (!last) return null
  const covered = attr(last, 'covered')
  const missed = attr(last, 'missed')
  if (covered === '' || missed === '') return null
  return { covered: Number(covered), missed: Number(missed) }
}
export function collectCoverage(projectRoot: string, modules: string[]): CoverageSummary {
  const files: string[] = []
  for (const module of modules) {
    const rel = module.slice(1).split(':').filter(Boolean).join('/')
    walk(join(projectRoot, rel, 'build', 'reports', 'jacoco'), files, 0)
  }
  const unique = [...new Set(files)]
  if (!unique.length) return { available: false, linePercent: -1, branchPercent: -1, instructionPercent: -1, methodPercent: -1, classPercent: -1, reportFiles: 0 }
  const sums = new Map<string, { covered: number; missed: number }>()
  for (const file of unique) {
    try {
      const xml = readFileSync(file, 'utf8')
      for (const type of ['LINE', 'BRANCH', 'INSTRUCTION', 'METHOD', 'CLASS']) {
        const value = counter(xml, type)
        if (value) {
          const current = sums.get(type) ?? { covered: 0, missed: 0 }
          current.covered += value.covered; current.missed += value.missed; sums.set(type, current)
        }
      }
    } catch {}
  }
  const pct = (type: string) => { const v = sums.get(type); if (!v) return -1; const total = v.covered + v.missed; return total ? (v.covered / total) * 100 : 100 }
  return { available: true, linePercent: pct('LINE'), branchPercent: pct('BRANCH'), instructionPercent: pct('INSTRUCTION'), methodPercent: pct('METHOD'), classPercent: pct('CLASS'), reportFiles: unique.length }
}
