import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const dshToolsEntry = require.resolve('@deepseek-ai/dsh-tools')
const runtimeTools = await import(pathToFile(dshToolsEntry))
const { apply } = await import(pathToFile(path.join(root, 'lib', 'index.js')))

let captured
const ctx = {
  logger: () => ({ info() {}, warn() {}, error() {} }),
  tools: { register(definition) { captured = definition } },
  effect(cb) { return cb() },
}

apply(ctx)
assert.ok(captured, 'run_robolectric must register')
assert.equal(captured.name, 'run_robolectric')
assert.doesNotThrow(() => runtimeTools.assertSupportedJsonSchema(captured.output.schema))

const value = {
  success: true,
  executionStatus: 'passed',
  message: 'ok',
  projectRoot: '/workspace/project',
  testType: 'jvm',
  gradleTask: ':app:testDebugUnitTest',
  selectedFilters: [],
  durationMs: 10,
  summary: {
    total: 1, passed: 1, failed: 0, skipped: 0,
    reportFiles: 1, usableReports: 1, reportCompleteness: 'complete',
    failuresList: [], slowestTests: [],
  },
  gradleErrorType: 'UNKNOWN',
  gradleErrorMessage: 'Gradle completed without a recognized error.',
  reportPaths: [],
  coverage: { available: false, linePercent: -1, branchPercent: -1, instructionPercent: -1, methodPercent: -1, classPercent: -1, reportFiles: 0 },
  comparison: { previousAvailable: false, failedDelta: 0, durationDeltaMs: 0 },
  rawOutputTail: '',
}

const violations = runtimeTools.validateJsonSchemaValue(captured.output.schema, value, 'value')
assert.deepEqual(violations, [], violations.join('; '))

console.log('DSH runtime compatibility: OK')

function pathToFile(file) {
  return new URL(`file://${file.replaceAll('\\', '/')}`)
}
