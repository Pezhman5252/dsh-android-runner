# dsh-android-runner — Complete Installation & Usage Guide (Steps 0–100)

A step-by-step, zero-to-one-hundred guide to install and run the **dsh-android-runner** plugin on DeepSeek Harness (DSH), so you can execute JVM / Robolectric and connected-instrumentation tests against your Android project in a real environment.

> **What this plugin is and is NOT.**
> The plugin registers **one tool** — `run_robolectric` — that safely launches Gradle test tasks and parses the resulting XML test reports. It does **NOT** install the JDK, the Android SDK, Gradle, adb, or an emulator, and it does not create your Android project. All of those are **prerequisites you must supply** (steps 1–20). The plugin only orchestrates the environment you already have.

---

## Step 0 — Understand what you are installing

| Item | Detail |
|---|---|
| Plugin package | `dsh-android-runner@1.4.2` (npm) |
| Registered tool | `run_robolectric` (single tool, parameterized) |
| DSH baseline | `@deepseek-ai/dsh@0.1.1-rc.2` (compatibility baseline) |
| Peer deps (host-supplied) | `@deepseek-ai/cordis >=4.0.1 <5.0.0`, `@deepseek-ai/dsh-tools >=0.1.1-rc.2 <0.2.0` |
| Node.js requirement | `>= 22.19.0` (`engines` in package.json) |
| What it runs | `gradlew` / `gradlew.bat` with a fixed, validated Gradle argument vector — never an arbitrary shell command |
| Test strategies | `jvm` / `robolectric` / `auto` → local JVM tests; `instrumentation` / `device` → connected device tests |

**Golden rules before you start:**

1. Never install `@deepseek-ai/dsh-tools` or `@deepseek-ai/cordis` into the DSH profile yourself — the Harness host supplies them. A second copy breaks the tool scheduler.
2. The tool runs from the **active DSH session's working directory**. That directory MUST be your Android project root.
3. The Gradle **wrapper** (`gradlew` / `gradlew.bat`) is required by default; `useSystemGradle: true` is the explicit opt-in fallback.
4. Instrumentation tests need a **real device or emulator** that is online, authorized, and running a debuggable build.

---

## Phase A — Host machine prerequisites (Steps 1–20)

### Steps 1–5: Node.js and pnpm

1. **Check Node.js.** Open a terminal (PowerShell on Windows) and run:
   ```powershell
   node --version
   ```
   The output must be `v22.19.0` or newer (the plugin declares `engines.node >= 22.19.0`). If Node is missing or older, install the latest **Node.js 22 LTS** from [nodejs.org](https://nodejs.org/) (or via `winget install OpenJS.NodeJS.LTS` / nvm-windows).

2. **Verify npm** (ships with Node):
   ```powershell
   npm --version
   ```

3. **Install pnpm** (the DSH CLI commands in this guide use `pnpm dlx`):
   ```powershell
   npm install -g pnpm
   ```
   (Alternative: `corepack enable` then `corepack prepare pnpm@latest --activate`.)

4. **Verify pnpm:**
   ```powershell
   pnpm --version
   ```

5. **Check network reachability.** The DSH CLI, the plugin package, and Gradle dependencies are all fetched from npm/Maven repositories. If you are behind a proxy or firewall, make sure npm, pnpm, and Gradle can reach the internet before continuing.

### Steps 6–10: Java Development Kit (JDK)

6. **Check Java:**
   ```powershell
   java -version
   ```
   Android Gradle Plugin (AGP) 8.x requires **JDK 17**; AGP 7.x requires JDK 11. The JDK must match what your project's Gradle/AGP version expects (check `gradle/wrapper/gradle-wrapper.properties` and the AGP version in the project's build files). Recommended: **Eclipse Temurin JDK 17** (or 21 for recent AGP + Kotlin 2.x projects).

7. **Set `JAVA_HOME`** so it points at the JDK installation directory (not a JRE):
   - Windows (System → Environment Variables, or for the current session):
     ```powershell
     [Environment]::SetEnvironmentVariable('JAVA_HOME', 'C:\Program Files\Eclipse Adoptium\jdk-17.0.xx', 'User')
     ```
   - macOS/Linux (shell profile):
     ```bash
     export JAVA_HOME=$(/usr/libexec/java_home -v 17)   # macOS
     export JAVA_HOME=/usr/lib/jvm/java-17-openjdk       # Linux
     ```

8. **Add the JDK `bin` to `PATH`** (or rely on `JAVA_HOME`; Gradle uses `JAVA_HOME`).

9. **Verify from a NEW terminal:**
   ```powershell
   java -version
   echo $env:JAVA_HOME
   ```

10. **If you have several JDKs**, make sure `JAVA_HOME` points to the one matching the project's AGP requirement — Gradle uses `JAVA_HOME` preferentially, and a wrong JDK version produces the `GRADLE_VERSION` / JDK diagnostic at runtime.

### Steps 11–15: Android SDK

11. **Install the Android SDK.** The simplest path is Android Studio (SDK Manager). The command-line-tools route also works. The plugin needs the SDK *present*; it does not install it.

12. **Install these SDK components** (via SDK Manager or `sdkmanager`):
    - `platform-tools` — provides **adb** (required for instrumentation tests)
    - `build-tools;<version>` — matching your AGP requirement
    - `platforms;android-<api>` — the API level of your `compileSdk`
    - *(only for emulator testing)* `emulator` and a `system-images;android-<api>;<tag>;<abi>` image

13. **Set `ANDROID_HOME`** and put the SDK tools on `PATH`:
    ```powershell
    # Typical Windows SDK location
    [Environment]::SetEnvironmentVariable('ANDROID_HOME', "$env:LOCALAPPDATA\Android\Sdk", 'User')
    [Environment]::SetEnvironmentVariable('Path', "$env:ANDROID_HOME\platform-tools;$env:ANDROID_HOME\emulator;" + $env:Path, 'User')
    ```
    macOS/Linux: `export ANDROID_HOME=$HOME/Library/Android/sdk` (macOS) or `$HOME/Android/Sdk` (Linux), and add `$ANDROID_HOME/platform-tools` and `$ANDROID_HOME/emulator` to `PATH`.

14. **Verify adb from a NEW terminal:**
    ```powershell
    adb version
    ```

15. **Create `local.properties` in the project root** when the SDK is not discoverable from `ANDROID_HOME` (this file is read by the Gradle build; keep it out of version control). Windows paths must escape backslashes:
    ```properties
    sdk.dir=C\:\\Users\\<you>\\AppData\\Local\\Android\\Sdk
    ```

### Steps 16–20: Android project readiness

16. **Confirm the project is a Gradle Android project:** it must contain `settings.gradle` or `settings.gradle.kts` at the root and at least one module whose `build.gradle(.kts)` applies `com.android.application` or `com.android.library`.

17. **Confirm the Gradle wrapper exists** in the project root: `gradlew` (macOS/Linux) or `gradlew.bat` (Windows). The plugin's default path requires it (`wrapperExists()` check). If it is missing, generate it once with a system Gradle:
    ```powershell
    gradle wrapper --gradle-version <version-matching-your-AGP>
    ```
    (Only if you have a system Gradle installed; otherwise copy the wrapper from another project or re-create the project skeleton.)

18. **Place your tests where Gradle expects them:**
    - Local JVM / Robolectric tests → `app/src/test/java/...`
    - Instrumentation tests → `app/src/androidTest/java/...`

19. **For instrumentation tests**, the module's `build.gradle(.kts)` must declare the AndroidX test runner and dependencies:
    ```kotlin
    android {
      defaultConfig {
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
      }
    }
    dependencies {
      androidTestImplementation("androidx.test:runner:1.6.x")
      androidTestImplementation("androidx.test.ext:junit:1.2.x")
      // Robolectric (optional, JVM side): testImplementation("org.robolectric:robolectric:4.x")
    }
    ```

20. **Prove the project builds standalone before touching the plugin** (this also warms the Gradle cache and downloads AGP/Kotlin dependencies, which takes minutes on the first run):
    ```powershell
    .\gradlew.bat :app:assembleDebug     # Windows
    ./gradlew :app:assembleDebug         # macOS/Linux
    ```
    If this fails, fix the environment (JDK / SDK / dependencies) **now** — the plugin can only diagnose these errors, not fix them.

---

## Phase B — Install DeepSeek Harness and the plugin (Steps 21–40)

### Steps 21–25: Install the DSH CLI baseline

21. **Pin the DSH release family.** The plugin's tested baseline is DSH `0.1.1-rc.2` with the matching host `dsh-tools` copy. Use exactly this version in every `pnpm dlx @deepseek-ai/dsh@0.1.1-rc.2 ...` command in this guide.

22. **Smoke-test the CLI** (this also verifies npm resolution and network):
    ```powershell
    pnpm dlx @deepseek-ai/dsh@0.1.1-rc.2 --help
    ```

23. **Check the DSH profile.** The plugin installs into the `web` profile. Show the current configuration:
    ```powershell
    pnpm dlx @deepseek-ai/dsh@0.1.1-rc.2 --profile web --dump-config
    ```

24. **Know where the profile lives.** DSH stores profiles under its home directory (`~/.dsh` on the user's home, overridable with `DSH_HOME`). The `--dump-config` output shows the resolved paths.

25. **Do NOT install `@deepseek-ai/dsh-tools` or `@deepseek-ai/cordis` into the profile.** They are peer dependencies supplied by the Harness host; a second copy creates duplicate module instances and can break the tool scheduler. The plugin's `package.json` deliberately keeps them as `peerDependencies` with zero runtime `dependencies`.

### Steps 26–30: Install the plugin

26. **Add the plugin to the `web` profile:**
    ```powershell
    pnpm dlx @deepseek-ai/dsh@0.1.1-rc.2 plugin --profile web add dsh-android-runner@1.4.2
    ```

27. **Wait for completion.** The command resolves the package from npm, verifies peer dependency ranges against the host, and writes the plugin row into the profile's Cordis composition (`cordis.patch.yml` inserts `id: dsh-android-runner`, `name: dsh-android-runner`).

28. **Confirm the row landed:**
    ```powershell
    pnpm dlx @deepseek-ai/dsh@0.1.1-rc.2 --profile web --dump-config
    ```
    You must see `dsh-android-runner` among the plugin entries.

29. **Confirm there is no duplicate `dsh-tools` / `cordis`** in the profile's dependency tree (step 25). If one appeared, remove it and re-verify.

30. **If you are upgrading from an older version**, re-running the same `add` command with `@1.4.2` updates the pinned version. Afterwards re-verify with `--dump-config`.

### Steps 31–35: Verify plugin integrity

31. **Inspect the installed package** under the DSH profile's node_modules: it must contain `lib/index.js` (the compiled plugin), `cordis.patch.yml`, `README.md`, `LICENSE`, and `package.json` with `main: lib/index.js`.

32. **(Optional) Validate the package from source.** If you cloned the repository (`D:\Project\Android\dsh-android-runner`), run its own verification suite:
    ```powershell
    npm install
    npm run build
    npm run verify
    ```
    This checks the bundle manifest, the XML report parser, Gradle-property safety, the output schema, and runtime compatibility.

33. **Understand how registration happens:** the plugin's `cordis.patch.yml` is a bundle `insert` row. When DSH starts the `web` profile, Cordis loads the plugin, whose `apply(ctx)` registers the `run_robolectric` tool via `ctx.tools.register(defineTool({...}))` and injects `['tools']`.

34. **Confirm peer-dependency satisfaction:** the host must provide `@deepseek-ai/cordis >=4.0.1 <5.0.0` and `@deepseek-ai/dsh-tools >=0.1.1-rc.2 <0.2.0`. The tested baseline is DSH `0.1.1-rc.2`.

35. **Record your installed versions** for future troubleshooting:
    ```powershell
    pnpm dlx @deepseek-ai/dsh@0.1.1-rc.2 --version
    ```

---

## Phase C — Start DSH and open your project (Steps 36–50)

36. **Start the DSH web GUI:**
    ```powershell
    pnpm dlx @deepseek-ai/dsh@0.1.1-rc.2 web --no-open
    ```
    (Drop `--no-open` to auto-open the browser.)

37. **Open the URL printed by the CLI** in your browser (typically `http://127.0.0.1:3080` — use whatever the console prints).

38. **Create a new session** in the GUI.

39. **Set the session's working directory / workspace to your Android project root.** This is **mandatory**: `run_robolectric` reads `execCtx.agent.session.header.cwd` and throws `The active DSH session has no workspace/cwd` when it is missing, and it refuses to run anywhere but the project root. Open/attach the project folder (the one containing `settings.gradle(.kts)` and `gradlew(.bat)`).

40. **Sanity-check the session binding:** the session's file view should show `settings.gradle.kts`/`build.gradle.kts`, `gradlew.bat`, `local.properties`, etc.

41. **Confirm the tool is registered:** the session's available tools should include `run_robolectric` (described as the safe Android test executor). If it is missing, the plugin did not mount — check the profile config (steps 28–29) and restart the web process.

42. **Make sure the harness is running continuously** while tests execute; do not close the session or stop the web process mid-run.

43. **Plan your first run to be JVM-only** (steps 51–60) before any device work, so environment issues surface without involving a device.

44. **Note the time budget:** the default tool timeout is **300 000 ms (5 minutes)**; cold Gradle builds routinely exceed this. Budget up to **900 000 ms (15 minutes)** via `timeoutMs` for first runs.

45. **Ensure network access for Gradle:** the first run downloads AGP, Kotlin, AndroidX and other dependencies into `~/.gradle`. Without network, the run fails with the `DEPENDENCY` diagnostic.

46. **Ensure disk space** for Gradle caches and build outputs (several GB for a typical project).

47. **Behind a proxy?** Configure `gradle.properties` in the project (`systemProp.http.proxyHost`, etc.) so Gradle can resolve dependencies.

48. **Enable plugin diagnostics when troubleshooting:** pass `"debug": true` to `run_robolectric` to get extra log lines.

49. **Read the full parameter reference** in [Appendix A](#appendix-a--run_robolectric-parameter-reference) before your first call.

50. **Set expectations for results:** the tool returns a structured result (status, task, duration, totals, failures, slowest tests, Gradle diagnostic, optional coverage/history/report paths), not a raw Gradle log dump (only a bounded tail is included).

---

## Phase D — First test run: JVM / Robolectric (Steps 51–70)

51. **Understand `testType` mapping:**
    - `auto` | `jvm` | `robolectric` → local JVM strategy → task `:app:testDebugUnitTest`
    - `instrumentation` | `device` → connected-device strategy → task `:app:connectedDebugAndroidTest`
    - Default when omitted: `jvm`. **The plugin never guesses that a device test is safe** — you must explicitly choose `instrumentation`/`device` to run on a device.

52. **First safe run — full module JVM tests:**
    ```json
    { "testType": "jvm", "module": "app" }
    ```
    The plugin validates the module path, builds the fixed argument vector, and spawns `gradlew.bat :app:testDebugUnitTest --rerun-tasks --no-daemon --console=plain`.

53. **If the wrapper is missing** the tool fails with `Gradle wrapper not found.` — add the wrapper (step 17) or, only with a trusted system Gradle, retry with:
    ```json
    { "testType": "jvm", "module": "app", "useSystemGradle": true }
    ```

54. **Where results come from:** Gradle writes JUnit XML under `app/build/test-results/testDebugUnitTest/TEST-*.xml`. The plugin parses these, **but only files whose mtime is at/after the run start and strictly newer than the pre-run snapshot** — stale reports are never mistaken for fresh results.

55. **Read the result card:** `executionStatus` (`passed`/`failed`/…), `total/passed/failed/skipped`, `reportCompleteness`, failure details, slowest tests, and the `gradleErrorType` diagnostic.

56. **Run a single JVM test** (Gradle `--tests` selector syntax — `Class.method`):
    ```json
    { "testType": "jvm", "testFilter": "com.example.LoginTest" }
    ```
    ```json
    { "testType": "jvm", "testFilter": "com.example.LoginTest.login" }
    ```
    Filters are restricted to a conservative character set; anything with shell metacharacters is rejected.

57. **Run multiple modules:**
    ```json
    { "testType": "jvm", "modules": ["app", ":feature:login"] }
    ```
    (1–32 modules; module paths are normalized to `:path:form`.)

58. **Choose a variant** (default `Debug`, first letter auto-capitalized):
    ```json
    { "testType": "jvm", "module": "app", "variant": "Release" }
    ```
    A `Release` variant may require signing configuration; prefer `Debug` for testing.

59. **Give cold builds more time:**
    ```json
    { "testType": "jvm", "module": "app", "timeoutMs": 600000 }
    ```
    (Allowed range 1000–900000.)

60. **Parallel / continue-on-failure for large projects:**
    ```json
    { "testType": "jvm", "modules": ["app", ":feature:login"], "parallel": true, "continueOnFailure": true }
    ```

61. **Pass restricted Gradle properties** — only `org.gradle.*` and `android.testInstrumentationRunnerArguments.*` keys are accepted, values must be strings without newlines:
    ```json
    { "testType": "jvm", "gradleProperties": { "org.gradle.jvmargs": "-Xmx4g" } }
    ```

62. **Rerun previously failed JVM tests** (one module only; cannot be combined with `testFilter`):
    ```json
    { "testType": "jvm", "module": "app", "rerunFailed": true }
    ```
    The plugin reads the previous XML failures and converts them to `--tests` selectors (up to `maxFilters`, default 100).

63. **Parse JaCoCo coverage** — only if your project already produces JaCoCo XML under `build/reports/jacoco` (the plugin never enables JaCoCo itself):
    ```json
    { "testType": "jvm", "module": "app", "coverage": true }
    ```

64. **Track history across runs:**
    ```json
    { "testType": "jvm", "module": "app", "compareWithPrevious": true }
    ```
    Writes `.dsh/test-history/` in the project (last 100 kept) and reports failed/duration deltas.

65. **List fresh report files for manual inspection:**
    ```json
    { "testType": "jvm", "module": "app", "detailedReport": true }
    ```
    Returns up to 100 report paths (relative to the project) — read them with normal DSH file tooling.

66. **If the run fails, read the diagnostic** and fix the environment/project side (see [Appendix B](#appendix-b--gradle-diagnostics--troubleshooting)). Common first-run causes: `JDK` (bad `JAVA_HOME`), `ANDROID_SDK` (missing SDK/location), `DEPENDENCY` (no network/cache), `COMPILATION` (code errors).

67. **If the status is `parse_error`** ("no fresh XML test report could be parsed reliably"), the Gradle task failed before writing reports or the task/variant/module names do not match the produced reports — check the `gradleErrorType` and the raw output tail.

68. **Remember `--rerun-tasks` is always appended** — the plugin forces task re-execution, so every run produces genuinely fresh reports (that is also why runs are slower than incremental builds).

69. **Iterate:** fix a failing test, re-run with the same parameters, and confirm `failed` drops to 0 and `executionStatus` becomes `passed`.

70. **JVM phase complete** when `success: true` and the totals match your suite. Next, go real: device instrumentation (Phase E).

---

## Phase E — Real device / emulator instrumentation (Steps 71–90)

71. **Create an emulator (or use a physical phone).** In Android Studio's Device Manager, create an AVD with a system image whose API level is compatible with your `minSdk`/`targetSdk`. Alternatively, from the command line:
    ```powershell
    sdkmanager "system-images;android-34;google_apis;x86_64"
    avdmanager create avd -n testphone -k "system-images;android-34;google_apis;x86_64"
    ```

72. **Boot the emulator:**
    ```powershell
    emulator -avd testphone
    ```
    Headless variant for CI: `emulator -avd testphone -no-window -no-audio -no-boot-anim`.

73. **Wait until Android is fully booted** (not just "device online"):
    ```powershell
    adb wait-for-device
    adb shell getprop sys.boot_completed
    ```
    Repeat the second command until it prints `1`.

74. **Or connect a physical device** with **USB debugging** enabled (Developer Options), and **accept the RSA authorization prompt** on the phone screen the first time.

75. **Verify authorization — this is the most common instrumentation failure:**
    ```powershell
    adb devices
    ```
    The device must show state `device`. `unauthorized` means the RSA prompt was not accepted; `offline` usually means it is still booting. Fix these BEFORE running the plugin.

76. **If adb is flaky**, restart the server: `adb kill-server` then `adb start-server`, then re-check `adb devices`.

77. **Run the connected instrumentation suite:**
    ```json
    { "testType": "instrumentation", "module": "app" }
    ```
    The plugin builds `:app:connectedDebugAndroidTest`, which installs the debug APK and the test APK on the device and runs every instrumentation test.

78. **Run a single instrumentation class or method** (Android runner selector — `Class` or `Class#method`):
    ```json
    { "testType": "instrumentation", "testFilter": "com.example.LoginTest" }
    ```
    ```json
    { "testType": "instrumentation", "testFilter": "com.example.LoginTest#login" }
    ```
    This is passed as `-Pandroid.testInstrumentationRunnerArguments.class=...` — **not** as Gradle `--tests`.

79. **"No connected devices" diagnostic?** Check steps 71–76 again: emulator booted (`sys.boot_completed=1`) or phone authorized (`adb devices` → `device`).

80. **`INSTALL_FAILED` / install diagnostic?** The APK could not be installed — check ABI (`arm64-v8a`/`x86_64`) vs emulator image, `minSdk` vs device API level, and that the device has enough free space. The debug APK is debuggable by default, which the connected task requires.

81. **Rerun failed instrumentation is deliberately conservative:** it is allowed only when the previous run produced **exactly one** failed/error case (one runner selector per invocation is representable). Use an explicit `testFilter` for the specific case otherwise.

82. **`parallel` for instrumentation** only when your connected-device environment supports concurrent connected tasks; with a single device leave it off.

83. **Where instrumentation results live:** `app/build/outputs/androidTest-results/connected/` (and `app/build/test-results/connectedDebugAndroidTest/`). The plugin parses the same fresh-report rules as JVM runs.

84. **Keep a single device online** for a run — connected Android tests target the available device, and ambiguity across several devices is a common source of flakiness.

85. **A test crashes the app?** The plugin does not attach logcat; use adb directly:
    ```powershell
    adb logcat -d -t 500 | Select-String -Pattern "FATAL|AndroidRuntime"
    ```

86. **Confirm the debug variant is debuggable** (`debuggable true` — the default for `debug` builds); a `release` build without debuggable flag will fail installation.

87. **The app under test is installed automatically** by `connectedDebugAndroidTest` — you do not need to install it manually.

88. **Verify the instrumentation runner declaration** (step 19): without `testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"` the connected task cannot discover tests.

89. **Slow emulators need more headroom** — raise the timeout:
    ```json
    { "testType": "instrumentation", "module": "app", "timeoutMs": 900000 }
    ```

90. **After the run**, results land in the tool card exactly like JVM runs (status, totals, failures, slowest tests, diagnostics). You may now shut down the emulator (`adb emu kill`) or unplug the phone.

---

## Phase F — Post-install verification and troubleshooting (Steps 91–100)

91. **Re-verify the plugin is still mounted** after any DSH restart:
    ```powershell
    pnpm dlx @deepseek-ai/dsh@0.1.1-rc.2 --profile web --dump-config
    ```
    and confirm `run_robolectric` appears in the session tool list.

92. **Know your diagnostics.** Every failed run reports a `gradleErrorType` from a fixed classifier — see [Appendix B](#appendix-b--gradle-diagnostics--troubleshooting) for the exact mapping to fixes.

93. **`OOM`** → raise the Gradle heap via `gradleProperties`: `{ "org.gradle.jvmargs": "-Xmx4g -XX:MaxMetaspaceSize=1g" }` (only `org.gradle.*` keys are allowed).

94. **`DAEMON`** → the plugin already forces `--no-daemon`; a retry after killing stale Gradle daemons (`.\gradlew.bat --stop`) usually clears it.

95. **`JDK` / `ANDROID_SDK` / `ADB` / `DEVICE`** → these are environment problems, not plugin problems. Re-check steps 6–15 and 71–76 (`JAVA_HOME`, `ANDROID_HOME`/`local.properties`, adb on PATH, device authorized).

96. **`GRADLE_VERSION`** → AGP/Gradle/JDK version incompatibility in the project (see step 6 and `gradle/wrapper/gradle-wrapper.properties`); adjust the project, not the plugin.

97. **`COMPILATION`** → source or Kotlin compilation errors in the project; fix them with the IDE/compiler diagnostics.

98. **`DEPENDENCY`** → dependency resolution failed: check repositories, network/proxy (step 47), and versions in the project build files.

99. **`parse_error` with no reports** → the task exited without producing fresh XML (wrong module/variant/task name, or build failed early). Check the raw output tail and the exact `gradleTask` the tool reports.

100. **You are done.** The plugin is installed, the environment is verified, and `run_robolectric` can execute the full Android test suite — JVM/Robolectric locally and instrumentation on a real device/emulator — with structured, safety-validated results. Keep this guide as your reference.

---

## Appendix A — `run_robolectric` parameter reference

| Parameter | Type | Default | Allowed / Notes |
|---|---|---|---|
| `module` | string | detected | Single Gradle module, e.g. `app` or `:feature:login` |
| `modules` | string[] | — | Multi-module form (1–32); use instead of `module` |
| `variant` | string | `Debug` | Auto-capitalized; `Release` needs signing config |
| `testType` | string | `jvm` | `auto`/`jvm`/`robolectric` → local JVM; `instrumentation`/`device` → connected device |
| `testFilter` | string | — | JVM: `--tests` selector `Class` or `Class.method`; instrumentation: `Class` or `Class#method` |
| `rerunFailed` | boolean | false | One module only; cannot combine with `testFilter`; instrumentation limited to one previous failure |
| `timeoutMs` | number | 300000 | 1000–900000 |
| `maxFilters` | number | 100 | 1–1000 (rerun failure filters) |
| `maxOutputTail` | number | 6000 | 500–50000 (chars of raw output returned) |
| `continueOnFailure` | boolean | false | Adds Gradle `--continue` |
| `parallel` | boolean | false | Adds Gradle `--parallel` (multi-module) |
| `gradleProperties` | object | — | Only `org.gradle.*` and `android.testInstrumentationRunnerArguments.*`; string values, ≤20 entries |
| `useSystemGradle` | boolean | false | Opt-in fallback when the wrapper is missing |
| `detailedReport` | boolean | false | Return ≤100 fresh report paths |
| `debug` | boolean | false | Extra plugin diagnostics |
| `compareWithPrevious` | boolean | false | `.dsh/test-history/` storage + delta comparison |
| `coverage` | boolean | false | Parse existing JaCoCo XML only (never enables JaCoCo) |

**Task mapping:** JVM → `:<module>:test<Variant>UnitTest`; instrumentation → `:<module>:connected<Variant>AndroidTest`.

**Always appended:** `--rerun-tasks --no-daemon --console=plain` (plus filters, properties, `--parallel`/`--continue` when requested).

---

## Appendix B — Gradle diagnostics & troubleshooting

| Diagnostic | Signature | Fix |
|---|---|---|
| `OOM` | OutOfMemoryError, Java heap space | Raise `org.gradle.jvmargs` via `gradleProperties`; reduce parallel work |
| `JDK` | JAVA_HOME not set / JDK not found | Set `JAVA_HOME` to a JDK matching AGP (steps 6–10) |
| `ANDROID_SDK` | ANDROID_HOME/ANDROID_SDK_ROOT not set, SDK location not found | Set `ANDROID_HOME` or `local.properties` `sdk.dir` (steps 11–15) |
| `ADB` | adb not found / device unauthorized | Install platform-tools, `adb` on PATH, accept RSA prompt (steps 13, 74–76) |
| `DEVICE` | no connected devices / offline / INSTALL_FAILED | Boot+authorize device or emulator (steps 71–76, 80) |
| `DEPENDENCY` | Could not resolve / Could not find | Check repositories, network/proxy, versions (steps 45–47) |
| `COMPILATION` | Compilation failed, Kotlin compiler | Fix source/compiler errors in the project |
| `GRADLE_VERSION` | unsupported/minimum Gradle version | Align Gradle wrapper/AGP/JDK versions |
| `TEST_FAILURE` | tests failed | Read the XML failures from the result card; fix tests |
| `TIMEOUT` | exceeded `timeoutMs` | Raise `timeoutMs` (max 900000) |
| `UNKNOWN` | no recognized signature | Check the raw output tail and the project build logs |

---

## Final checklist

- [ ] Node.js ≥ 22.19.0 (`node --version`)
- [ ] pnpm installed (`pnpm --version`)
- [ ] JDK 17 (or project-required version), `JAVA_HOME` set
- [ ] Android SDK installed, `ANDROID_HOME` set, `adb` on PATH
- [ ] `local.properties` with `sdk.dir` when needed
- [ ] Project has `gradlew` / `gradlew.bat`; `assembleDebug` builds standalone
- [ ] Instrumentation: `testInstrumentationRunner` declared; `src/androidTest` tests exist
- [ ] DSH `0.1.1-rc.2` CLI reachable (`pnpm dlx ... --help`)
- [ ] Plugin added: `plugin --profile web add dsh-android-runner@1.4.2` and visible in `--dump-config`
- [ ] DSH web running; session workspace = Android project root
- [ ] `run_robolectric` present in the session tool list
- [ ] JVM run passes: `{ "testType": "jvm", "module": "app" }`
- [ ] Instrumentation run passes with device online: `{ "testType": "instrumentation", "module": "app" }`
