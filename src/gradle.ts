import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

export interface ProcessResult {
  exitCode: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  timedOut: boolean
  aborted: boolean
  durationMs: number
}

const MAX_CAPTURE_BYTES = 512 * 1024
const MODULE_RE = /^:[A-Za-z0-9_.-]+(?::[A-Za-z0-9_.-]+)*$/
const VARIANT_RE = /^[A-Za-z][A-Za-z0-9_-]*$/
const JVM_FILTER_RE = /^[A-Za-z0-9_.$*?:-]+$/
const INSTRUMENTATION_FILTER_RE = /^[A-Za-z0-9_.$]+(?:#[A-Za-z0-9_.$]+)?$/
const GRADLE_KEY_RE = /^(?:org\.gradle\.[A-Za-z0-9_.-]+|android\.testInstrumentationRunnerArguments\.[A-Za-z0-9_.-]+)$/
const GRADLE_VALUE_RE = /^[^\r\n&|<>^()%!;`"]{1,2000}$/

function limitedAppend(parts: Buffer[], currentBytes: { value: number }, chunk: Buffer): void {
  if (currentBytes.value >= MAX_CAPTURE_BYTES) return
  const remaining = MAX_CAPTURE_BYTES - currentBytes.value
  const slice = chunk.subarray(0, remaining)
  parts.push(slice)
  currentBytes.value += slice.byteLength
}

async function killProcessTree(child: ReturnType<typeof spawn>): Promise<void> {
  if (!child.pid) return
  if (process.platform === 'win32') {
    await new Promise<void>((resolve) => {
      const killer = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'taskkill', '/PID', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      })
      killer.once('close', () => resolve())
      killer.once('error', () => resolve())
    })
  } else {
    try { process.kill(-child.pid, 'SIGTERM') } catch { try { child.kill('SIGTERM') } catch {} }
    await new Promise((resolve) => setTimeout(resolve, 1500))
    try { process.kill(-child.pid, 'SIGKILL') } catch { try { child.kill('SIGKILL') } catch {} }
  }
}

export async function runGradle(
  projectRoot: string,
  gradleArgs: string[],
  timeoutMs: number,
  signal: AbortSignal | undefined,
  useSystemGradle = false,
): Promise<ProcessResult> {
  const windows = process.platform === 'win32'
  const wrapper = windows ? 'gradlew.bat' : './gradlew'
  const command = useSystemGradle ? (windows ? 'gradle.bat' : 'gradle') : wrapper
  const startedAt = Date.now()
  const child = windows
    ? spawn(process.env.ComSpec || 'cmd.exe',
        ['/d', '/s', '/c', command, ...gradleArgs],
        { cwd: projectRoot, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], detached: false })
    : spawn(command, gradleArgs, { cwd: projectRoot, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], detached: true })

  const stdout: Buffer[] = []
  const stderr: Buffer[] = []
  const stdoutBytes = { value: 0 }
  const stderrBytes = { value: 0 }
  child.stdout?.on('data', (chunk: Buffer) => limitedAppend(stdout, stdoutBytes, Buffer.from(chunk)))
  child.stderr?.on('data', (chunk: Buffer) => limitedAppend(stderr, stderrBytes, Buffer.from(chunk)))

  let timedOut = false
  let aborted = false
  let settled = false
  let timer: NodeJS.Timeout | undefined
  let abortHandler: (() => void) | undefined
  const result = await new Promise<ProcessResult>((resolve) => {
    const finish = (value: ProcessResult) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      if (signal && abortHandler) signal.removeEventListener('abort', abortHandler)
      resolve(value)
    }
    const snapshot = (): ProcessResult => ({
      exitCode: null,
      signal: null,
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8'),
      timedOut,
      aborted,
      durationMs: Date.now() - startedAt,
    })
    timer = setTimeout(() => {
      timedOut = true
      void killProcessTree(child).finally(() => finish(snapshot()))
    }, timeoutMs)
    abortHandler = () => {
      aborted = true
      void killProcessTree(child).finally(() => finish(snapshot()))
    }
    if (signal) {
      if (signal.aborted) abortHandler()
      else signal.addEventListener('abort', abortHandler, { once: true })
    }
    child.once('error', (error: Error) => finish({ ...snapshot(), stderr: `${snapshot().stderr}\n${String(error)}`.trim() }))
    child.once('close', (code: number | null, closeSignal: NodeJS.Signals | null) => finish({
      exitCode: code,
      signal: closeSignal,
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8'),
      timedOut,
      aborted,
      durationMs: Date.now() - startedAt,
    }))
  })
  return result
}

function readBuildScript(projectRoot: string): string {
  for (const name of ['build.gradle.kts', 'build.gradle']) {
    try { return readFileSync(join(projectRoot, name), 'utf8') } catch {}
  }
  return ''
}

export function looksLikeAndroidModule(projectRoot: string): boolean {
  const script = readBuildScript(projectRoot)
  return /com\.android\.(application|library)/.test(script) || /android\s*\{/.test(script)
}

function gradleProjectPathToDirectory(projectRoot: string, modulePath: string): string {
  const relativePath = modulePath.slice(1).split(':').filter(Boolean).join('/')
  return join(projectRoot, relativePath)
}

function includedModules(projectRoot: string): string[] {
  const settings = ['settings.gradle.kts', 'settings.gradle'].map((name) => join(projectRoot, name)).find(existsSync)
  if (!settings) return []
  let text = ''
  try { text = readFileSync(settings, 'utf8') } catch { return [] }
  const result: string[] = []
  const regex = /\binclude\b(?!Build)\s*(?:\(([^)]*)\)|([^\n]+))/g
  let match: RegExpExecArray | null
  while ((match = regex.exec(text)) !== null) {
    const body = match[1] ?? match[2] ?? ''
    for (const token of body.matchAll(/['"](:?[A-Za-z0-9_.-]+(?::[A-Za-z0-9_.-]+)*)['"]/g)) {
      const raw = token[1]
      if (raw) result.push(raw.startsWith(':') ? raw : `:${raw}`)
    }
  }
  return [...new Set(result)]
}

export function detectDefaultModule(projectRoot: string): string {
  if (looksLikeAndroidModule(projectRoot)) return ''
  const candidates = includedModules(projectRoot)
  const androidCandidates = candidates.filter((module) => {
    const dir = gradleProjectPathToDirectory(projectRoot, module)
    return existsSync(dir) && statSync(dir).isDirectory() && looksLikeAndroidModule(dir)
  })
  if (androidCandidates.includes(':app')) return ':app'
  if (androidCandidates.length === 1) return androidCandidates[0]!
  try {
    const androidDirs: string[] = []
    for (const entry of readdirSync(projectRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue
      const dir = join(projectRoot, entry.name)
      if (looksLikeAndroidModule(dir)) androidDirs.push(entry.name)
    }
    if (androidDirs.includes('app')) return ':app'
    if (androidDirs.length === 1) return `:${androidDirs[0]}`
  } catch {}
  return ''
}

export function normalizeModules(projectRoot: string, value: string | string[] | undefined): string[] {
  const raw = value === undefined ? [detectDefaultModule(projectRoot)] : Array.isArray(value) ? value : [value]
  if (raw.length < 1 || raw.length > 32) throw new Error('module must contain between 1 and 32 Gradle modules.')
  const normalized = raw.map((item) => {
    const trimmed = item.trim()
    if (!trimmed) return ''
    const candidate = trimmed.startsWith(':') ? trimmed : `:${trimmed}`
    if (!MODULE_RE.test(candidate)) throw new Error(`Invalid module "${item}".`)
    return candidate
  })
  return [...new Set(normalized)]
}

export function normalizeVariant(value: string | undefined): string {
  const raw = value?.trim() || 'Debug'
  if (!VARIANT_RE.test(raw)) throw new Error('Invalid variant.')
  return raw[0]!.toUpperCase() + raw.slice(1)
}

export function normalizeJvmFilter(value: string | undefined): string | undefined {
  const filter = value?.trim()
  if (!filter) return undefined
  if (filter.length > 300 || /[\r\n\s'"`&|;<>()[\]{}]/.test(filter) || !JVM_FILTER_RE.test(filter)) {
    throw new Error('Invalid JVM testFilter. Use a Gradle --tests selector such as "com.example.LoginTest" or "com.example.LoginTest.login".')
  }
  return filter
}

export function normalizeInstrumentationFilter(value: string | undefined): string | undefined {
  const filter = value?.trim()
  if (!filter) return undefined
  if (filter.length > 300 || !INSTRUMENTATION_FILTER_RE.test(filter)) {
    throw new Error('Invalid instrumentation testFilter. Use "com.example.LoginTest" or "com.example.LoginTest#login".')
  }
  return filter
}

export function buildTask(modulePath: string, variant: string, testType: 'jvm' | 'instrumentation'): string {
  return `${modulePath}:${testType === 'instrumentation' ? `connected${variant}AndroidTest` : `test${variant}UnitTest`}`
}

export function buildTasks(modules: string[], variant: string, testType: 'jvm' | 'instrumentation'): string[] {
  return modules.map((modulePath) => buildTask(modulePath, variant, testType))
}

export function wrapperExists(projectRoot: string): boolean {
  return process.platform === 'win32' ? existsSync(join(projectRoot, 'gradlew.bat')) : existsSync(join(projectRoot, 'gradlew'))
}

export function validateGradleProperties(properties: Record<string, unknown> | undefined): string[] {
  if (!properties) return []
  const entries = Object.entries(properties)
  if (entries.length > 20) throw new Error('gradleProperties may contain at most 20 entries.')
  return entries.map(([key, value]) => {
    if (!GRADLE_KEY_RE.test(key)) throw new Error(`Gradle property key is not allowed: ${key}`)
    if (typeof value !== 'string' || !GRADLE_VALUE_RE.test(value)) throw new Error(`Gradle property value must be a non-empty string without newlines (max 2000 chars) for: ${key}`)
    return `-P${key}=${value}`
  })
}

/**
 * Validate a rerun-generated test selector derived from XML report data.
 * Rejects the same shell metacharacters the explicit `testFilter` normalizers
 * catch, while being permissive enough to preserve JUnit parameterized
 * suffixes (`method[0]`) and Gradle `--tests` wildcard patterns (`*`, `?`).
 * On Windows these values flow through `cmd /d /s /c`, so every cmd
 * metacharacter must be intercepted.
 */
export function validateRerunFilter(value: string): string {
  const filter = value.trim()
  if (!filter || filter.length > 300 || /[\r\n\s'"`&|;<>()%^!]/.test(filter)) {
    throw new Error(`Invalid test selector extracted from the previous XML report: "${value}". Run a specific testFilter instead.`)
  }
  return filter
}
