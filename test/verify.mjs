import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const patch = fs.readFileSync(path.join(root, 'cordis.patch.yml'), 'utf8')
assert.equal(pkg.dsh?.bundle?.patch, './cordis.patch.yml')
assert.equal(pkg.main, 'lib/index.js')
assert.ok(pkg.peerDependencies?.['@deepseek-ai/dsh-tools'], 'dsh-tools must be a peer dependency')
assert.equal(pkg.dependencies?.['@deepseek-ai/dsh-tools'], undefined, 'dsh-tools must not be bundled as a runtime dependency')
assert.ok(pkg.peerDependencies?.['@deepseek-ai/cordis'], 'cordis must be a peer dependency')
assert.ok(fs.existsSync(path.join(root, 'lib', 'index.js')), 'run npm run build first')
assert.ok(patch.includes('id: dsh-robolectric-runner'))
assert.ok(patch.includes('name: dsh-robolectric-runner'))
const { parseReports } = await import(pathToFile(path.join(root, 'lib', 'results.js')))
const tmp = path.join(root, '.verify-tmp')
fs.rmSync(tmp, { recursive: true, force: true }); fs.mkdirSync(tmp, { recursive: true })
const report = `<?xml version="1.0"?><testsuite tests="3" failures="1" errors="0" skipped="1"><testcase classname="com.example.LoginTest" name="passes" time="0.2"/><testcase classname="com.example.LoginTest" name="fails" time="1.2"><failure message="Expected true">java.lang.AssertionError: Expected true</failure></testcase><testcase classname="com.example.LoginTest" name="skips"><skipped/></testcase></testsuite>`
fs.writeFileSync(path.join(tmp, 'TEST-LoginTest.xml'), report)
const parsed = parseReports([path.join(tmp, 'TEST-LoginTest.xml')])
assert.deepEqual({ total: parsed.total, passed: parsed.passed, failed: parsed.failed, skipped: parsed.skipped }, { total: 3, passed: 1, failed: 1, skipped: 1 })
assert.equal(parsed.failuresList[0]?.testClass, 'com.example.LoginTest')
assert.equal(parsed.slowestTests[0]?.testName, 'fails')
fs.rmSync(tmp, { recursive: true, force: true })
const { validateGradleProperties } = await import(pathToFile(path.join(root, 'lib', 'gradle.js')))
assert.deepEqual(validateGradleProperties({ 'org.gradle.jvmargs': '-Xmx2g' }), ['-Porg.gradle.jvmargs=-Xmx2g'])
assert.throws(() => validateGradleProperties({ 'org.gradle.jvmargs': 123 }), /must be a non-empty string/)
assert.throws(() => validateGradleProperties({ 'org.gradle.jvmargs': '-Xmx2g&echo unsafe' }), /must be a non-empty string/)
console.log('Plugin manifest, XML parser, and Gradle property safety verification: OK')
function pathToFile(file) { return new URL(`file://${file.replaceAll('\\', '/')}`) }
