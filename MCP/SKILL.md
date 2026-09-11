# Android Test Runner (dsh-android-runner-mcp)

An MCP server installed at `C:/Users/Pezhman/AppData/Local/hermes/mcp/dsh-android-runner/server.py`, registered in `config.yaml` under `mcp_servers.dsh-android-runner-mcp`. It exposes one tool: **`mcp_dsh_android_runner_mcp_run_robolectric`** — a Python port of the `dsh-android-runner` DeepSeek Harness plugin (source: D:\Project\Android\dsh-android-runner).

## When to use it

- Running Android unit/Robolectric tests with structured results (totals, failures, slowest tests, Gradle diagnostics) instead of parsing raw `gradlew` output.
- Re-running only previously failed tests (`rerunFailed`).
- Diagnosing Gradle failures — the tool classifies errors (OOM, JDK, ANDROID_SDK, ADB, DEVICE, DEPENDENCY, COMPILATION, TIMEOUT, GRADLE_VERSION, TEST_FAILURE).
- For **compilation checks, `assembleDebug`, lint, or any non-test Gradle task — use `terminal` with gradlew directly.** This tool only runs test tasks (`test<Variant>UnitTest`, `connected<Variant>AndroidTest`).

## Usage

Minimum call — `projectRoot` (absolute path to the Android project root containing `settings.gradle(.kts)` + `gradlew(.bat)`) is REQUIRED:

```json
{"projectRoot": "D:/Project/Android/open-meteo", "module": "app", "testType": "jvm"}
```

Key parameters:
- `testType`: `jvm` (default; also `robolectric`/`auto`) or `instrumentation`/`device` (never guessed — explicit only).
- `modules`: array for multi-module; `module`: single (backward compat).
- `testFilter`: JVM `com.example.LoginTest` or `Class.method`; instrumentation `Class` or `Class#method`.
- `rerunFailed`: true → reruns previous XML failures (one module only; never combine with `testFilter`).
- `timeoutMs`: default 300000; **cold builds routinely need 600000–900000** (max 900000).
- `gradleProperties`: only `org.gradle.*` / `android.testInstrumentationRunnerArguments.*` keys (e.g. `{"org.gradle.jvmargs": "-Xmx4g"}` for OOM).
- `coverage`: parses existing JaCoCo XML (never enables JaCoCo). `compareWithPrevious`: writes `.dsh/test-history/` in the project. `detailedReport`: returns fresh report paths.

## Behavior notes

- The tool always appends `--rerun-tasks --no-daemon --console=plain` — every run is a full re-execution (slower than incremental; fresh XML reports are the authoritative source, stale reports are never trusted).
- Validation errors return `is_error` results — read the message and correct the arguments (bad module path, shell metacharacters in filters, wrapper missing → needs `useSystemGradle: true` explicitly).
- `success: true` requires exit code 0, zero failed tests, AND parseable fresh reports; `parse_error` means Gradle produced no fresh XML (wrong module/variant/task).
- Instrumentation tests need a booted, authorized device/emulator first (`adb devices` → `device`).
- First run in a session may take minutes (Gradle cold start); budget `timeoutMs` accordingly.
- If the MCP server is missing from the tool list, check `hermes mcp list` and restart the session (MCP servers load at session start).