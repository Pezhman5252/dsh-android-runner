# dsh-android-runner

A DeepSeek Harness bundle that registers `run_robolectric`, a safety-focused Android test execution and diagnostics tool. It supports Android local JVM/Robolectric tests and connected instrumentation tests while preserving the original DSH tool contract.

## Why this design

The plugin intentionally stays on the stable DeepSeek Harness extension shape: one Cordis plugin, `ctx.tools.register()`, and `defineTool()`. The model never supplies an arbitrary shell command. The tool constructs a fixed Gradle argument vector, validates model-controlled values, uses the active DSH session workspace, and treats fresh Gradle XML reports as the authoritative test-result source.

The current DSH documentation defines `defineTool()` + `ctx.tools.register()` as the first-party tool pattern and requires a canonical output schema. This plugin follows that contract and avoids newer optional ToolDefinition features so that the package remains compatible with the runtime surface it targets.

## Installation

```powershell
# Use the same DSH release family as the plugin compatibility baseline.
pnpm dlx @deepseek-ai/dsh@0.1.1-rc.2 plugin --profile web add dsh-android-runner@1.4.2

pnpm dlx @deepseek-ai/dsh@0.1.1-rc.2 --profile web --dump-config
pnpm dlx @deepseek-ai/dsh@0.1.1-rc.2 web --no-open
```

Do not install `@deepseek-ai/dsh-tools` or `@deepseek-ai/cordis` into the plugin profile yourself. They are peer dependencies supplied by the Harness host; installing a second copy of a DSH core package inside the profile can create duplicate module instances and break the Harness tool scheduler.

## Supported capabilities

- Android local JVM / Robolectric tests
- Android connected instrumentation tests
- Single-module and multi-module execution
- Optional Gradle `--parallel` and `--continue`
- Rerun failed/error JVM tests from previous XML reports
- Bounded configurable failure filters and output tail
- Gradle error classification: OOM, daemon, JDK, SDK, ADB/device, dependency, compilation, timeout, version, and test failure
- Fresh-report protection to prevent stale XML from being treated as a new result
- Test duration and slow-test reporting
- Optional JaCoCo XML parsing (the plugin never enables JaCoCo itself)
- Optional `.dsh/test-history` storage and comparison
- Optional bounded report paths for detailed follow-up inspection
- Explicit debug diagnostics
- Optional system Gradle fallback, disabled by default
- Restricted `-P` Gradle properties; arbitrary shell commands are never accepted

## Tool parameters

### Backward-compatible single module

```json
{
  "module": "app"
}
```

### Multi-module

The DSH schema remains conservative for compatibility, so the original `module: string` parameter is preserved and a new `modules: string[]` parameter is added:

```json
{
  "modules": ["app", ":feature:login"]
}
```

Both forms are normalized to Gradle project paths.

### Test type

```json
{"testType":"jvm"}
{"testType":"robolectric"}
{"testType":"instrumentation"}
{"testType":"device"}
{"testType":"auto"}
```

`device` is an alias for `instrumentation`. `auto` currently selects the safe JVM strategy. Explicit `instrumentation`/`device` is required when a device/emulator test is intended; this avoids unexpectedly launching an emulator/device test from an agent call.

### JVM test filter

```json
{"testType":"jvm","testFilter":"com.example.LoginTest.login"}
```

The value is converted to Gradle `--tests` arguments and is restricted to a conservative selector character set.

### Instrumentation filter

```json
{"testType":"instrumentation","testFilter":"com.example.LoginTest#login"}
```

The value is passed as Android instrumentation runner class/method data rather than incorrectly using Gradle `--tests`.

### Rerun failed tests

```json
{"rerunFailed":true}
```

For JVM tests the previous failure list is converted to repeated `--tests` selectors. `rerunFailed` is intentionally limited to one module so a failure selector from one module can never be applied to another module. Instrumentation rerun is additionally conservative: if more than one previous instrumentation failure is found, the tool refuses to silently run the complete device suite. This is safer than pretending multiple runner filters can be represented by one Gradle property.

### Large projects

```json
{
  "maxFilters": 250,
  "maxOutputTail": 20000,
  "continueOnFailure": true,
  "parallel": true
}
```

Defaults are 100 filters and 6000 output characters. Hard safety limits are 1000 filters and 50000 characters.

### Gradle properties

Only these key families are accepted:

- `org.gradle.*`
- `android.testInstrumentationRunnerArguments.*`

Values are passed as individual argv entries, never interpolated into a shell command.

### System Gradle

The Gradle wrapper is always preferred. If it is missing, execution fails unless the caller explicitly sets:

```json
{"useSystemGradle":true}
```

This keeps reproducible wrapper-based execution as the default.

### Detailed reports

```json
{"detailedReport":true}
```

The result includes a bounded list of fresh XML report paths. The XML contents are not injected wholesale into the model context; the model can inspect individual artifacts with the normal DSH filesystem tooling when needed.

### Coverage

```json
{"coverage":true}
```

The tool parses existing JaCoCo XML reports under module `build/reports/jacoco`. It reports line, branch, instruction, method, and class percentages when available. It does not modify the Gradle build or enable JaCoCo.

### History

```json
{"compareWithPrevious":true}
```

A compact record is written atomically under:

```text
.dsh/test-history/
```

Only the most recent 100 records are retained. The result reports failure and duration deltas when a previous run exists.

## Safety model

The model cannot provide an arbitrary executable command. The plugin validates module paths, variants, filters, limits, and Gradle properties before creating the fixed argument vector.

The plugin also:

- uses the active DSH session workspace
- prefers the project Gradle wrapper
- kills the process tree on timeout/cancellation
- bounds stdout/stderr capture
- rejects shell metacharacters in test selectors and Gradle property values (including Windows `cmd.exe` metacharacters)
- does not expose a model-controlled webhook URL
- does not log secrets or environment variables
- does not enable JaCoCo automatically
- does not trust stale test reports after a fresh run

## Output for agents

The canonical result contains:

- execution status
- test strategy
- Gradle task(s)
- duration
- total/passed/failed/skipped
- report count and completeness
- failure details
- slowest tests
- Gradle error classification and diagnostic guidance
- optional coverage metrics
- optional history comparison
- optional report paths
- bounded raw Gradle output tail

This structured output is deliberately more useful to an agent than returning only a human-oriented Gradle log.

## Development

```powershell
npm install
npm run build
npm run verify
```

The verification suite checks the bundle manifest, XML parser, output schema, and—when a DSH runtime installation is discoverable—the runtime schema validator.

## Compatibility

The plugin keeps the existing public tool name `run_robolectric`, the DSH workspace source, and the `defineTool()` / `ctx.tools.register()` integration model. `@deepseek-ai/dsh-tools` is intentionally a peer dependency, not a bundled runtime dependency, so the plugin reuses the Harness-owned ToolRuntime instance and avoids duplicate `dsh-tools` copies that can break the internal scheduler symbol identity. The supported peer range is `>=0.1.1-rc.2 <0.2.0`; the current tested baseline is DSH `0.1.1-rc.2` with the matching host `dsh-tools` copy. Existing calls using `module`, `variant`, `testFilter`, `rerunFailed`, and `timeoutMs` remain supported.

## License

MIT
