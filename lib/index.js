import { defineTool } from '@deepseek-ai/dsh-tools';
import { statSync } from 'node:fs';
import { relative } from 'node:path';
import { classifyGradleError } from './diagnostics.js';
import { collectCoverage } from './coverage.js';
import { buildTasks, normalizeInstrumentationFilter, normalizeJvmFilter, normalizeModules, normalizeVariant, runGradle, validateGradleProperties, validateRerunFilter, wrapperExists } from './gradle.js';
import { compareSummary, loadPrevious, saveHistory } from './history.js';
import { collectReportFiles, emptySummary, parseReports } from './results.js';
export const name = 'dsh-android-runner';
export const inject = ['tools'];
const DEFAULT_TIMEOUT_MS = 300_000;
const MAX_TIMEOUT_MS = 900_000;
const DEFAULT_MAX_FILTERS = 100;
const HARD_MAX_FILTERS = 1000;
const DEFAULT_MAX_OUTPUT_TAIL = 6000;
const HARD_MAX_OUTPUT_TAIL = 50_000;
const MAX_MODULES = 32;
function sessionCwd(execCtx) {
    const cwd = execCtx?.agent?.session?.header?.cwd;
    if (typeof cwd !== 'string' || !cwd.trim())
        throw new Error('The active DSH session has no workspace/cwd. Start the tool from an active project session.');
    const stat = statSync(cwd);
    if (!stat.isDirectory())
        throw new Error('The active DSH session cwd is not a directory.');
    return cwd;
}
function validateLimits(args) {
    const timeoutMs = args.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > MAX_TIMEOUT_MS)
        throw new Error(`timeoutMs must be an integer between 1000 and ${MAX_TIMEOUT_MS}.`);
    const maxFilters = args.maxFilters ?? DEFAULT_MAX_FILTERS;
    if (!Number.isInteger(maxFilters) || maxFilters < 1 || maxFilters > HARD_MAX_FILTERS)
        throw new Error(`maxFilters must be an integer between 1 and ${HARD_MAX_FILTERS}.`);
    const maxOutputTail = args.maxOutputTail ?? DEFAULT_MAX_OUTPUT_TAIL;
    if (!Number.isInteger(maxOutputTail) || maxOutputTail < 500 || maxOutputTail > HARD_MAX_OUTPUT_TAIL)
        throw new Error(`maxOutputTail must be an integer between 500 and ${HARD_MAX_OUTPUT_TAIL}.`);
    return { timeoutMs, maxFilters, maxOutputTail };
}
function outputTail(stdout, stderr, maxChars) {
    const text = `${stdout}${stderr ? `\n[stderr]\n${stderr}` : ''}`.trim();
    return text.length <= maxChars ? text : text.slice(-maxChars);
}
function uniqueFilters(failures, maxFilters) {
    const result = [];
    for (const failure of failures) {
        const filter = `${failure.testClass}.${failure.testName}`;
        if (!result.includes(filter))
            result.push(filter);
        if (result.length >= maxFilters)
            break;
    }
    return result;
}
function uniqueInstrumentationFilters(failures, maxFilters) {
    const result = [];
    for (const failure of failures) {
        const filter = `${failure.testClass}#${failure.testName}`;
        if (!result.includes(filter))
            result.push(filter);
        if (result.length >= maxFilters)
            break;
    }
    return result;
}
function normalizeTestType(value) {
    const raw = (value ?? 'jvm').trim().toLowerCase();
    // AUTO remains deliberately conservative: this release never guesses that a
    // device/emulator test is safe to launch from a model call.
    if (raw === 'jvm' || raw === 'robolectric' || raw === 'auto')
        return 'jvm';
    if (raw === 'instrumentation' || raw === 'device')
        return 'instrumentation';
    throw new Error('testType must be one of: auto, jvm, robolectric, instrumentation, device.');
}
function emptyCoverage() { return { available: false, linePercent: -1, branchPercent: -1, instructionPercent: -1, methodPercent: -1, classPercent: -1, reportFiles: 0 }; }
function emptyComparison() { return { previousAvailable: false, failedDelta: 0, durationDeltaMs: 0 }; }
export function apply(ctx) {
    const logger = ctx.logger(name);
    ctx.effect(() => ctx.tools.register(defineTool({
        name: 'run_robolectric',
        description: 'Safely run Android local JVM/Robolectric tests or Android instrumentation tests from the active DSH workspace. Supports multi-module execution, failure reruns, Gradle diagnostics, bounded output, optional coverage parsing, and test history. It never accepts an arbitrary shell command.',
        parameters: {
            module: { type: 'string', description: 'Backward-compatible single Gradle module path, for example app or :feature:login.' },
            modules: { type: 'array', description: 'Optional Gradle module paths for multi-module execution, for example ["app", ":feature:login"]. Use this instead of module when running multiple modules.', items: { type: 'string' } },
            variant: { type: 'string', description: 'Android build variant, for example Debug, Release, or BenchmarkDebug. Defaults to Debug.' },
            testType: { type: 'string', description: 'Test strategy: auto, jvm, robolectric, instrumentation, or device. auto/jvm/robolectric use local JVM tests; instrumentation/device uses connected Android device tests.' },
            testFilter: { type: 'string', description: 'JVM: Gradle --tests selector. Instrumentation: Android runner selector such as com.example.LoginTest or com.example.LoginTest#login.' },
            rerunFailed: { type: 'boolean', description: 'Rerun failed/error cases found in the previous XML reports. Cannot be combined with testFilter.' },
            timeoutMs: { type: 'number', description: `Maximum Gradle execution time. Default ${DEFAULT_TIMEOUT_MS}; allowed 1000-${MAX_TIMEOUT_MS}.` },
            maxFilters: { type: 'number', description: `Maximum failure filters used for rerun. Default ${DEFAULT_MAX_FILTERS}; hard maximum ${HARD_MAX_FILTERS}.` },
            maxOutputTail: { type: 'number', description: `Maximum Gradle output characters returned. Default ${DEFAULT_MAX_OUTPUT_TAIL}; hard maximum ${HARD_MAX_OUTPUT_TAIL}.` },
            continueOnFailure: { type: 'boolean', description: 'Add Gradle --continue so independent tasks can complete and report all failures.' },
            parallel: { type: 'boolean', description: 'Add Gradle --parallel for multi-module execution. For instrumentation, use only when the connected-device environment supports it.' },
            gradleProperties: { type: 'object', additionalProperties: true, description: 'Optional safe Gradle -P properties. Values must be strings. Only org.gradle.* and android.testInstrumentationRunnerArguments.* keys are accepted.' },
            useSystemGradle: { type: 'boolean', description: 'Opt in to a system Gradle executable when the project wrapper is unavailable. Default false.' },
            detailedReport: { type: 'boolean', description: 'Return a bounded list of fresh report file paths for follow-up inspection. Default false.' },
            debug: { type: 'boolean', description: 'Enable additional plugin diagnostics in the tool result/logs. Default false.' },
            compareWithPrevious: { type: 'boolean', description: 'Store a compact .dsh/test-history entry and compare the run with the previous entry.' },
            coverage: { type: 'boolean', description: 'Parse existing JaCoCo XML reports after the test run. The plugin does not enable JaCoCo itself.' },
        },
        output: {
            schema: {
                type: 'object', additionalProperties: false,
                properties: {
                    success: { type: 'boolean', required: true }, executionStatus: { type: 'string', required: true }, message: { type: 'string', required: true }, projectRoot: { type: 'string', required: true },
                    testType: { type: 'string', required: true }, gradleTask: { type: 'string', required: true }, selectedFilters: { type: 'array', required: true, items: { type: 'string' } }, durationMs: { type: 'number', required: true },
                    summary: { type: 'object', required: true, additionalProperties: false, properties: {
                            total: { type: 'number', required: true }, passed: { type: 'number', required: true }, failed: { type: 'number', required: true }, skipped: { type: 'number', required: true }, reportFiles: { type: 'number', required: true }, usableReports: { type: 'number', required: true }, reportCompleteness: { type: 'string', required: true },
                            failuresList: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: { testClass: { type: 'string', required: true }, testName: { type: 'string', required: true }, error: { type: 'string', required: true } } } },
                            slowestTests: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: { testClass: { type: 'string', required: true }, testName: { type: 'string', required: true }, durationMs: { type: 'number', required: true } } } },
                        } },
                    gradleErrorType: { type: 'string', required: true }, gradleErrorMessage: { type: 'string', required: true }, reportPaths: { type: 'array', required: true, items: { type: 'string' } },
                    coverage: { type: 'object', required: true, additionalProperties: false, properties: { available: { type: 'boolean', required: true }, linePercent: { type: 'number' }, branchPercent: { type: 'number' }, instructionPercent: { type: 'number' }, methodPercent: { type: 'number' }, classPercent: { type: 'number' }, reportFiles: { type: 'number', required: true } } },
                    comparison: { type: 'object', required: true, additionalProperties: false, properties: { previousAvailable: { type: 'boolean', required: true }, failedDelta: { type: 'number' }, durationDeltaMs: { type: 'number' } } },
                    rawOutputTail: { type: 'string', required: true },
                },
            },
            render: (_args, value) => {
                const result = value;
                const lines = [
                    '📊 **Android Test Results**', '', `- **Status:** ${result.success ? '✅ Passed' : '❌ Failed'}`, `- **Execution:** ${result.executionStatus}`, `- **Type:** ${result.testType}`,
                    `- **Task(s):** ${result.gradleTask}`, `- **Duration:** ${result.durationMs} ms`, `- **Tests:** ${result.summary.total} total, ${result.summary.passed} passed, ${result.summary.failed} failed, ${result.summary.skipped} skipped`,
                    `- **Reports:** ${result.summary.usableReports} usable of ${result.summary.reportFiles} discovered (${result.summary.reportCompleteness})`, `- **Gradle diagnostic:** ${result.gradleErrorType} — ${result.gradleErrorMessage}`,
                ];
                if (result.coverage.available)
                    lines.push(`- **JaCoCo:** line ${formatPct(result.coverage.linePercent)}, branch ${formatPct(result.coverage.branchPercent)}, instruction ${formatPct(result.coverage.instructionPercent)}`);
                if (result.comparison.previousAvailable)
                    lines.push(`- **Previous run:** failed delta ${result.comparison.failedDelta}, duration delta ${result.comparison.durationDeltaMs} ms`);
                if (result.selectedFilters.length)
                    lines.push(`- **Filters:** ${result.selectedFilters.join(', ')}`);
                if (result.summary.failuresList.length) {
                    lines.push('', '**Failures:**');
                    for (const f of result.summary.failuresList.slice(0, 20))
                        lines.push(`- ${f.testClass}#${f.testName}\n  ${f.error.replace(/\s+/g, ' ').slice(0, 1200)}`);
                }
                if (result.summary.slowestTests.length) {
                    lines.push('', '**Slowest tests:**');
                    for (const t of result.summary.slowestTests)
                        lines.push(`- ${t.testClass}#${t.testName}: ${t.durationMs} ms`);
                }
                if (result.reportPaths.length)
                    lines.push('', '**Fresh report files:**', ...result.reportPaths.map((p) => `- ${p}`));
                if (result.rawOutputTail)
                    lines.push('', '**Gradle output tail:**', '```text', result.rawOutputTail, '```');
                return [{ type: 'text', text: lines.join('\n') }];
            },
        },
        async execute(args, execCtx) {
            const projectRoot = sessionCwd(execCtx);
            const limits = validateLimits(args);
            if (args.rerunFailed && args.testFilter)
                throw new Error('rerunFailed and testFilter cannot be used together.');
            const testType = normalizeTestType(args.testType);
            const moduleInput = args.modules !== undefined ? args.modules : args.module;
            const modules = normalizeModules(projectRoot, moduleInput);
            if (modules.length > MAX_MODULES)
                throw new Error(`A maximum of ${MAX_MODULES} modules is supported.`);
            if (!wrapperExists(projectRoot) && !args.useSystemGradle)
                throw new Error(`Gradle wrapper not found. Set useSystemGradle=true only when a trusted system Gradle installation is intentionally available.`);
            const variant = normalizeVariant(args.variant);
            const properties = validateGradleProperties(args.gradleProperties);
            const explicitFilter = testType === 'instrumentation' ? normalizeInstrumentationFilter(args.testFilter) : normalizeJvmFilter(args.testFilter);
            const tasks = buildTasks(modules, variant, testType);
            const taskNames = tasks.map((t) => t.split(':').filter(Boolean).at(-1) ?? t);
            let selectedFilters = explicitFilter ? [explicitFilter] : [];
            const previousSummaries = [];
            if (args.rerunFailed) {
                if (modules.length > 1) {
                    throw new Error('rerunFailed is currently supported for one module at a time. Run each module separately so a failure filter from one module cannot be incorrectly applied to another module.');
                }
                for (let i = 0; i < modules.length; i++) {
                    const previousFiles = collectReportFiles(projectRoot, modules[i], taskNames[i], testType === 'instrumentation');
                    previousSummaries.push(parseReports(previousFiles, undefined, limits.maxFilters));
                }
                const failures = previousSummaries.flatMap((s) => s.failuresList);
                selectedFilters = testType === 'instrumentation'
                    ? uniqueInstrumentationFilters(failures, limits.maxFilters)
                    : uniqueFilters(failures, limits.maxFilters);
                // Rerun filters derive from XML report attribute values (test class/method
                // names), which on Windows flow through `cmd /d /s /c` exactly like an
                // explicit testFilter does. They must pass the same shell-metacharacter
                // gate so a crafted report cannot smuggle a cmd injection past the tool.
                selectedFilters = selectedFilters.map((filter) => validateRerunFilter(filter));
                if (testType === 'instrumentation' && selectedFilters.length > 1) {
                    throw new Error('Instrumentation rerunFailed found multiple failing test cases. The Android runner accepts one class/method selector per invocation; run a specific testFilter for the desired case.');
                }
                if (!selectedFilters.length) {
                    return { success: true, executionStatus: 'no_previous_failures', message: 'No previous failed/error test cases were found; nothing was rerun.', projectRoot, testType, gradleTask: tasks.join(' '), selectedFilters: [], durationMs: 0, summary: emptySummary(), gradleErrorType: 'UNKNOWN', gradleErrorMessage: 'No execution was required.', reportPaths: [], coverage: emptyCoverage(), comparison: emptyComparison(), rawOutputTail: '' };
                }
            }
            const gradleArgs = [...tasks];
            if (testType === 'jvm')
                for (const filter of selectedFilters)
                    gradleArgs.push('--tests', filter);
            if (testType === 'instrumentation' && selectedFilters.length === 1)
                gradleArgs.push(`-Pandroid.testInstrumentationRunnerArguments.class=${selectedFilters[0]}`);
            gradleArgs.push(...properties);
            if (args.parallel && modules.length > 1)
                gradleArgs.push('--parallel');
            if (args.continueOnFailure)
                gradleArgs.push('--continue');
            gradleArgs.push('--rerun-tasks', '--no-daemon', '--console=plain');
            if (args.debug)
                logger.info(`run_robolectric debug: type=${testType} modules=${modules.join(',')} tasks=${tasks.join(',')} filters=${selectedFilters.length}`);
            else
                logger.info(`Running ${tasks.join(', ')} in ${projectRoot}`);
            // Snapshot pre-existing test reports (path -> mtime) BEFORE Gradle runs. A run that
            // fails before producing reports must never inherit the previous run's results as
            // "fresh". Previously the mtime grace window (startedAt - 2000) accepted reports
            // written up to 2s before the run started, which made a fast-failing run inherit the
            // previous run's test counts. The snapshot plus the strict startedAt cutoff below
            // closes that window completely.
            const preRunReports = new Map();
            for (const file of new Set(modules.flatMap((module, i) => collectReportFiles(projectRoot, module, taskNames[i], testType === 'instrumentation')))) {
                try {
                    preRunReports.set(file, statSync(file).mtimeMs);
                }
                catch { /* file vanished between listing and stat */ }
            }
            const startedAt = Date.now();
            let run;
            try {
                run = await runGradle(projectRoot, gradleArgs, limits.timeoutMs, execCtx.signal, Boolean(args.useSystemGradle));
            }
            catch (error) {
                logger.error(String(error));
                return { success: false, executionStatus: execCtx.signal?.aborted ? 'cancelled' : 'execution_error', message: `Unable to execute Gradle: ${String(error)}`, projectRoot, testType, gradleTask: tasks.join(' '), selectedFilters, durationMs: Date.now() - startedAt, summary: emptySummary(), gradleErrorType: 'UNKNOWN', gradleErrorMessage: String(error), reportPaths: [], coverage: emptyCoverage(), comparison: emptyComparison(), rawOutputTail: '' };
            }
            const rawOutputTail = outputTail(run.stdout, run.stderr, limits.maxOutputTail);
            if (run.timedOut)
                return { success: false, executionStatus: 'timeout', message: `Gradle exceeded the ${limits.timeoutMs} ms timeout.`, projectRoot, testType, gradleTask: tasks.join(' '), selectedFilters, durationMs: run.durationMs, summary: emptySummary(), gradleErrorType: 'TIMEOUT', gradleErrorMessage: 'Gradle execution exceeded the configured timeout.', reportPaths: [], coverage: emptyCoverage(), comparison: emptyComparison(), rawOutputTail };
            if (run.aborted || execCtx.signal?.aborted)
                return { success: false, executionStatus: 'cancelled', message: 'Gradle execution was cancelled.', projectRoot, testType, gradleTask: tasks.join(' '), selectedFilters, durationMs: run.durationMs, summary: emptySummary(), gradleErrorType: 'UNKNOWN', gradleErrorMessage: 'Execution was cancelled.', reportPaths: [], coverage: emptyCoverage(), comparison: emptyComparison(), rawOutputTail };
            const reportFiles = modules.flatMap((module, i) => collectReportFiles(projectRoot, module, taskNames[i], testType === 'instrumentation'));
            const uniqueReportFiles = [...new Set(reportFiles)];
            // Only accept reports this run actually produced: mtime at/after the run
            // start AND strictly newer than the pre-run snapshot (new or modified).
            const freshReportFiles = uniqueReportFiles.filter((file) => {
                try {
                    const mtime = statSync(file).mtimeMs;
                    if (mtime < startedAt)
                        return false;
                    const previous = preRunReports.get(file);
                    if (previous !== undefined && mtime <= previous)
                        return false;
                    return true;
                }
                catch {
                    return false;
                }
            });
            const summary = parseReports(freshReportFiles, startedAt, limits.maxFilters);
            const diagnostic = summary.failed > 0 ? { type: 'TEST_FAILURE', message: 'The fresh XML reports contain failed/error test cases.' } : run.exitCode === 0 ? { type: 'UNKNOWN', message: 'Gradle completed without a recognized error.' } : classifyGradleError(run.stdout, run.stderr);
            const reportPaths = args.detailedReport ? freshReportFiles.slice(0, 100).map((file) => relative(projectRoot, file)) : [];
            const coverage = args.coverage ? collectCoverage(projectRoot, modules) : emptyCoverage();
            const currentHistory = { timestamp: new Date().toISOString(), task: tasks.join(' '), modules, testType, total: summary.total, passed: summary.passed, failed: summary.failed, skipped: summary.skipped, durationMs: run.durationMs };
            const comparison = args.compareWithPrevious ? compareSummary(loadPrevious(projectRoot), currentHistory) : emptyComparison();
            if (args.compareWithPrevious)
                saveHistory(projectRoot, currentHistory);
            const hasReports = summary.usableReports > 0;
            const success = run.exitCode === 0 && summary.failed === 0 && hasReports;
            const status = success ? 'passed' : hasReports || run.exitCode !== 0 ? 'failed' : 'parse_error';
            return {
                success, executionStatus: status, message: success
                    ? `Gradle completed successfully. ${summary.total} tests: ${summary.passed} passed, ${summary.failed} failed, ${summary.skipped} skipped.`
                    : hasReports ? `Gradle finished with ${summary.failed} failed/error test(s).` : `Gradle completed but no fresh XML test report could be parsed reliably. Exit code: ${run.exitCode ?? 'unknown'}.`,
                projectRoot, testType, gradleTask: tasks.join(' '), selectedFilters, durationMs: run.durationMs, summary,
                gradleErrorType: diagnostic.type, gradleErrorMessage: diagnostic.message, reportPaths, coverage, comparison, rawOutputTail,
            };
        },
    })));
}
function formatPct(value) { return value < 0 ? 'n/a' : `${value.toFixed(1)}%`; }
