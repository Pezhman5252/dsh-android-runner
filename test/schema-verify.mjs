import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const { apply } = await import(pathToFile(path.join(root, 'lib', 'index.js')))
let captured
const ctx = { logger: () => ({ info() {}, warn() {}, error() {} }), tools: { register(def) { captured = def } }, effect(cb) { return cb() } }
apply(ctx)
assert.ok(captured); assert.equal(captured.name, 'run_robolectric')
const check = (value) => { const violations = validateJsonSchemaValue(captured.output.schema, value, 'value'); assert.deepEqual(violations, [], violations.join('; ')) }
const parameterViolations = validateJsonSchemaValue(captured.parameters, { gradleProperties: { 'org.gradle.jvmargs': '-Xmx2g' } }, 'args')
assert.deepEqual(parameterViolations, [], parameterViolations.join('; '))

const { validateGradleProperties } = await import(pathToFile(path.join(root, 'lib', 'gradle.js')))
assert.deepEqual(validateGradleProperties({ 'org.gradle.jvmargs': '-Xmx2g' }), ['-Porg.gradle.jvmargs=-Xmx2g'])
assert.throws(() => validateGradleProperties({ 'org.gradle.jvmargs': 123 }), /must be a non-empty string/)
assert.throws(() => validateGradleProperties({ 'org.gradle.jvmargs': '-Xmx2g&echo unsafe' }), /must be a non-empty string/)

check({ success:true, executionStatus:'passed', message:'ok', projectRoot:'C:/p', testType:'jvm', gradleTask:':app:testDebugUnitTest', selectedFilters:[], durationMs:10, summary:{ total:1, passed:1, failed:0, skipped:0, reportFiles:1, usableReports:1, reportCompleteness:'complete', failuresList:[], slowestTests:[] }, gradleErrorType:'UNKNOWN', gradleErrorMessage:'Gradle completed without a recognized error.', reportPaths:[], coverage:{available:false,linePercent:-1,branchPercent:-1,instructionPercent:-1,methodPercent:-1,classPercent:-1,reportFiles:0}, comparison:{previousAvailable:false,failedDelta:0,durationDeltaMs:0}, rawOutputTail:'' })
console.log('Output schema validation: OK')
function pathToFile(file) { return new URL(`file://${file.replaceAll('\\', '/')}`) }
