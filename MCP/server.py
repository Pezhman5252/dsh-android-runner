#!/usr/bin/env python3
"""dsh-android-runner-mcp — MCP stdio server exposing a safe Android test runner.

A faithful Python port of the `dsh-android-runner` DeepSeek Harness plugin
(https://github.com/Pezhman5252/dsh-android-runner), adapted to Hermes' MCP
client surface (registered under the server name `dsh-android-runner-mcp`,
tool name `run_robolectric`).

The model never supplies an arbitrary shell command. The tool constructs a
fixed Gradle argument vector, validates every model-controlled value, treats
fresh Gradle JUnit XML reports as the authoritative test-result source, and
classifies Gradle errors into bounded diagnostics.

Original tool contract and safety model are preserved: module/variant/filter
validation, rerun-failure filtering with shell-metacharacter gates, fresh-report
(mtime) protection, bounded output, optional JaCoCo coverage parsing, and
optional `.dsh/test-history` comparison.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import signal
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

# ---------------------------------------------------------------------------
# Constants (mirrors src/index.ts of dsh-android-runner@1.4.2)
# ---------------------------------------------------------------------------

DEFAULT_TIMEOUT_MS = 300_000
MAX_TIMEOUT_MS = 900_000
DEFAULT_MAX_FILTERS = 100
HARD_MAX_FILTERS = 1000
DEFAULT_MAX_OUTPUT_TAIL = 6000
HARD_MAX_OUTPUT_TAIL = 50_000
MAX_MODULES = 32
MAX_CAPTURE_BYTES = 512 * 1024

MODULE_RE = re.compile(r"^:[A-Za-z0-9_.-]+(?::[A-Za-z0-9_.-]+)*$")
VARIANT_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_-]*$")
JVM_FILTER_RE = re.compile(r"^[A-Za-z0-9_.$*?:-]+$")
INSTRUMENTATION_FILTER_RE = re.compile(r"^[A-Za-z0-9_.$]+(?:#[A-Za-z0-9_.$]+)?$")
GRADLE_KEY_RE = re.compile(r"^(?:org\.gradle\.[A-Za-z0-9_.-]+|android\.testInstrumentationRunnerArguments\.[A-Za-z0-9_.-]+)$")
GRADLE_VALUE_RE = re.compile(r"^[^\r\n&|<>^()%!;`\"]{1,2000}$")
RERUN_FILTER_BAD_RE = re.compile(r"[\r\n\s'\"`&|;<>()%^!]")
TESTCASE_RE = re.compile(r"<testcase\b[\s\S]*?(?:/>|>[\s\S]*?</testcase>)", re.IGNORECASE)
OPEN_TAG_RE = re.compile(r"^<testcase\b[^>]*>", re.IGNORECASE)
SKIPPED_RE = re.compile(r"<skipped\b", re.IGNORECASE)
OUTCOME_RE = re.compile(r"<(failure|error)\b", re.IGNORECASE)

WINDOWS = sys.platform == "win32" or (os.name == "nt")


# ---------------------------------------------------------------------------
# Diagnostics (port of src/diagnostics.ts)
# ---------------------------------------------------------------------------

_GRADLE_PATTERNS: list[tuple[str, re.Pattern[str]]] = [
    ("OOM", re.compile(r"(OutOfMemoryError|Java heap space|GC overhead limit exceeded|Metaspace)", re.I)),
    ("JDK", re.compile(r"(JAVA_HOME|JDK|Java home).*(not set|not found|could not be determined|invalid)|No Java runtime present", re.I)),
    ("ANDROID_SDK", re.compile(r"(ANDROID_SDK_ROOT|ANDROID_HOME).*(not set|not found|does not exist)|SDK location not found", re.I)),
    ("ADB", re.compile(r"(adb.*(not found|cannot be found|failed)|device .*unauthorized|adb server)", re.I)),
    ("DEVICE", re.compile(r"(no connected devices|no devices found|device .*offline|emulator.*offline|failed to install.*apk|INSTALL_FAILED)", re.I)),
    ("DAEMON", re.compile(r"(Gradle daemon.*(stopped|disappeared|could not be started)|Daemon is stopped|daemon disappeared)", re.I)),
    ("DEPENDENCY", re.compile(r"(Could not resolve .*|Could not find .*|Failed to resolve|dependency.*failed)", re.I)),
    ("COMPILATION", re.compile(r"(Compilation failed|Kotlin compiler|compile.*failed|e: .*\.kt:)", re.I)),
    ("GRADLE_VERSION", re.compile(r"(unsupported Gradle version|minimum supported Gradle version|requires Gradle|Could not determine the dependencies of task)", re.I)),
    ("TEST_FAILURE", re.compile(r"(There were failing tests|tests failed|UnitTest FAILED|AndroidTest FAILED)", re.I)),
]

_DIAGNOSIS = {
    "OOM": "Gradle/JVM memory exhaustion detected. Consider increasing org.gradle.jvmargs or reducing parallel work.",
    "DAEMON": "Gradle daemon startup/lifecycle failure detected. A clean non-daemon retry may be useful.",
    "JDK": "Java/JDK configuration problem detected. Verify JAVA_HOME and that the required JDK is installed.",
    "ANDROID_SDK": "Android SDK configuration problem detected. Verify SDK location and required SDK components.",
    "ADB": "ADB problem detected. Verify adb availability and server/device authorization.",
    "DEVICE": "Android device/emulator problem detected. Verify a ready, authorized device and APK installation compatibility.",
    "DEPENDENCY": "Gradle dependency resolution failed. Check repositories, network access, versions, and dependency declarations.",
    "COMPILATION": "Source compilation failed before or during test execution. Inspect compiler diagnostics.",
    "GRADLE_VERSION": "Gradle/Android Gradle Plugin version compatibility problem detected.",
    "TEST_FAILURE": "Gradle reported test failures. The XML reports are the authoritative source for individual failures.",
    "TIMEOUT": "Gradle execution exceeded the configured timeout.",
    "UNKNOWN": "Gradle failed without matching a known diagnostic signature.",
}


def classify_gradle_error(stdout: str, stderr: str, timed_out: bool = False) -> dict[str, str]:
    if timed_out:
        return {"type": "TIMEOUT", "message": _DIAGNOSIS["TIMEOUT"]}
    text = f"{stdout}\n{stderr}"
    for type_, pattern in _GRADLE_PATTERNS:
        if pattern.search(text):
            return {"type": type_, "message": _DIAGNOSIS[type_]}
    return {"type": "UNKNOWN", "message": _DIAGNOSIS["UNKNOWN"]}


# ---------------------------------------------------------------------------
# Gradle helpers (port of src/gradle.ts)
# ---------------------------------------------------------------------------


def _read_build_script(project_root: Path) -> str:
    for name in ("build.gradle.kts", "build.gradle"):
        try:
            return (project_root / name).read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
    return ""


def looks_like_android_module(project_root: Path) -> bool:
    script = _read_build_script(project_root)
    return bool(re.search(r"com\.android\.(application|library)", script) or re.search(r"android\s*\{", script))


def _gradle_project_path_to_directory(project_root: Path, module_path: str) -> Path:
    relative = "/".join(p for p in module_path[1:].split(":") if p)
    return project_root / relative


def _included_modules(project_root: Path) -> list[str]:
    settings = None
    for name in ("settings.gradle.kts", "settings.gradle"):
        candidate = project_root / name
        if candidate.exists():
            settings = candidate
            break
    if settings is None:
        return []
    try:
        text = settings.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return []
    result: list[str] = []
    # include ':app', ':feature:login'  /  include(":app", ":core:ui")
    for match in re.finditer(r"\binclude\b(?!Build)\s*(?:\(([^)]*)\)|([^\n]+))", text):
        body = match.group(1) if match.group(1) is not None else (match.group(2) or "")
        for token in re.finditer(r"['\"](:?[A-Za-z0-9_.-]+(?::[A-Za-z0-9_.-]+)*)['\"]", body):
            raw = token.group(1)
            if raw:
                result.append(raw if raw.startswith(":") else f":{raw}")
    seen: set[str] = set()
    unique: list[str] = []
    for item in result:
        if item not in seen:
            seen.add(item)
            unique.append(item)
    return unique


def detect_default_module(project_root: Path) -> str:
    if looks_like_android_module(project_root):
        return ""
    candidates = _included_modules(project_root)
    android_candidates = []
    for module in candidates:
        directory = _gradle_project_path_to_directory(project_root, module)
        if directory.is_dir() and looks_like_android_module(directory):
            android_candidates.append(module)
    if ":app" in android_candidates:
        return ":app"
    if len(android_candidates) == 1:
        return android_candidates[0]
    try:
        android_dirs: list[str] = []
        for entry in project_root.iterdir():
            if entry.is_dir() and not entry.name.startswith("."):
                if looks_like_android_module(entry):
                    android_dirs.append(entry.name)
        if "app" in android_dirs:
            return ":app"
        if len(android_dirs) == 1:
            return f":{android_dirs[0]}"
    except OSError:
        pass
    return ""


def normalize_modules(project_root: Path, value: Any) -> list[str]:
    if value is None:
        raw: list[str] = [detect_default_module(project_root)]
    elif isinstance(value, list):
        raw = [str(item) for item in value]
    else:
        raw = [str(value)]
    if not 1 <= len(raw) <= 32:
        raise ToolError("module must contain between 1 and 32 Gradle modules.")
    normalized: list[str] = []
    for item in raw:
        trimmed = item.strip()
        if not trimmed:
            continue
        candidate = trimmed if trimmed.startswith(":") else f":{trimmed}"
        if not MODULE_RE.match(candidate):
            raise ToolError(f'Invalid module "{item}".')
        normalized.append(candidate)
    deduped: list[str] = []
    for item in normalized:
        if item not in deduped:
            deduped.append(item)
    return deduped


def normalize_variant(value: str | None) -> str:
    raw = (value or "").strip() or "Debug"
    if not VARIANT_RE.match(raw):
        raise ToolError("Invalid variant.")
    return raw[0].upper() + raw[1:]


def normalize_jvm_filter(value: str | None) -> str | None:
    filt = (value or "").strip()
    if not filt:
        return None
    if len(filt) > 300 or re.search(r"[\r\n\s'\"`&|;<>()\[\]{}]", filt) or not JVM_FILTER_RE.match(filt):
        raise ToolError(
            'Invalid JVM testFilter. Use a Gradle --tests selector such as "com.example.LoginTest" or "com.example.LoginTest.login".'
        )
    return filt


def normalize_instrumentation_filter(value: str | None) -> str | None:
    filt = (value or "").strip()
    if not filt:
        return None
    if len(filt) > 300 or not INSTRUMENTATION_FILTER_RE.match(filt):
        raise ToolError('Invalid instrumentation testFilter. Use "com.example.LoginTest" or "com.example.LoginTest#login".')
    return filt


def validate_rerun_filter(value: str) -> str:
    filt = value.strip()
    if not filt or len(filt) > 300 or RERUN_FILTER_BAD_RE.search(filt):
        raise ToolError(
            f'Invalid test selector extracted from the previous XML report: "{value}". Run a specific testFilter instead.'
        )
    return filt


def build_tasks(modules: list[str], variant: str, test_type: str) -> list[str]:
    suffix = f"connected{variant}AndroidTest" if test_type == "instrumentation" else f"test{variant}UnitTest"
    return [f"{module}:{suffix}" for module in modules]


def wrapper_exists(project_root: Path) -> bool:
    name = "gradlew.bat" if WINDOWS else "gradlew"
    return (project_root / name).exists()


def validate_gradle_properties(properties: dict[str, Any] | None) -> list[str]:
    if not properties:
        return []
    entries = list(properties.items())
    if len(entries) > 20:
        raise ToolError("gradleProperties may contain at most 20 entries.")
    args: list[str] = []
    for key, value in entries:
        if not GRADLE_KEY_RE.match(key):
            raise ToolError(f"Gradle property key is not allowed: {key}")
        if not isinstance(value, str) or not GRADLE_VALUE_RE.match(value):
            raise ToolError(f"Gradle property value must be a non-empty string without newlines (max 2000 chars) for: {key}")
        args.append(f"-P{key}={value}")
    return args


def _kill_process_tree(pid: int) -> None:
    if WINDOWS:
        try:
            subprocess.run(
                ["taskkill", "/PID", str(pid), "/T", "/F"],
                capture_output=True,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
                timeout=15,
            )
        except (OSError, subprocess.TimeoutExpired):
            pass
    else:
        try:
            os.killpg(os.getpgid(pid), signal.SIGTERM)
        except (OSError, ProcessLookupError):
            try:
                os.kill(pid, signal.SIGTERM)
            except OSError:
                pass
        time.sleep(1.5)
        try:
            os.killpg(os.getpgid(pid), signal.SIGKILL)
        except (OSError, ProcessLookupError):
            try:
                os.kill(pid, signal.SIGKILL)
            except OSError:
                pass


async def run_gradle(project_root: Path, gradle_args: list[str], timeout_ms: int, use_system_gradle: bool) -> dict[str, Any]:
    """Run Gradle with a fixed argument vector; bounded capture, tree-kill on timeout."""
    wrapper = "gradlew.bat" if WINDOWS else "./gradlew"
    command = ("gradle.bat" if WINDOWS else "gradle") if use_system_gradle else wrapper
    started_at = time.monotonic()
    timeout_s = timeout_ms / 1000.0

    if WINDOWS:
        # On Windows a .bat must go through cmd.exe; argv is passed as a list so
        # no shell interpolation happens (matches the TS plugin's `cmd /d /s /c`).
        argv = ["cmd.exe", "/d", "/s", "/c", command, *gradle_args]
        creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    else:
        argv = [command, *gradle_args]
        creationflags = 0

    try:
        proc = await asyncio.create_subprocess_exec(
            *argv,
            cwd=str(project_root),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            stdin=asyncio.subprocess.DEVNULL,
            creationflags=creationflags,
            start_new_session=not WINDOWS,
        )
    except OSError as exc:
        return {
            "exitCode": None, "signal": None,
            "stdout": "", "stderr": str(exc),
            "timedOut": False, "aborted": False,
            "durationMs": int((time.monotonic() - started_at) * 1000),
            "spawnError": True,
        }

    stdout_buf = bytearray()
    stderr_buf = bytearray()

    async def _pump(stream: asyncio.StreamReader, buf: bytearray) -> None:
        while True:
            chunk = await stream.read(65536)
            if not chunk:
                break
            if len(buf) < MAX_CAPTURE_BYTES:
                buf.extend(chunk[: MAX_CAPTURE_BYTES - len(buf)])

    try:
        pump_out = asyncio.ensure_future(_pump(proc.stdout, stdout_buf))
        pump_err = asyncio.ensure_future(_pump(proc.stderr, stderr_buf))
        try:
            await asyncio.wait_for(proc.wait(), timeout=timeout_s)
            timed_out = False
        except asyncio.TimeoutError:
            timed_out = True
            _kill_process_tree(proc.pid)
            await proc.wait()
    finally:
        for task in (locals().get("pump_out"), locals().get("pump_err")):
            if task:
                task.cancel()
                try:
                    await task
                except (asyncio.CancelledError, Exception):
                    pass

    return {
        "exitCode": proc.returncode,
        "signal": None,
        "stdout": stdout_buf.decode("utf-8", errors="replace"),
        "stderr": stderr_buf.decode("utf-8", errors="replace"),
        "timedOut": timed_out,
        "aborted": False,
        "durationMs": int((time.monotonic() - started_at) * 1000),
    }


# ---------------------------------------------------------------------------
# Results parsing (port of src/results.ts)
# ---------------------------------------------------------------------------


def _xml_decode(value: str) -> str:
    return (
        value.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", '"')
        .replace("&apos;", "'")
        .replace("&amp;", "&")
    )


def _strip_xml(value: str) -> str:
    return re.sub(r"\s+", " ", _xml_decode(re.sub(r"<[^>]*>", " ", value))).strip()


def _attr(open_tag: str, name: str) -> str:
    match = re.search(rf"\b{name}\s*=\s*([\"'])(.*?)\1", open_tag, re.IGNORECASE | re.DOTALL)
    return _xml_decode(match.group(2)) if match else ""


MAX_ERROR_LENGTH = 4000
MAX_FAILURES = 1000
MAX_SLOW_TESTS = 10


def _parse_testcases(xml: str) -> dict[str, Any]:
    cases = failed = skipped = 0
    failures: list[dict[str, str]] = []
    timings: list[dict[str, Any]] = []
    for match in TESTCASE_RE.finditer(xml):
        block = match.group(0)
        cases += 1
        open_tag = OPEN_TAG_RE.match(block)
        open_text = open_tag.group(0) if open_tag else block
        test_class = _attr(open_text, "classname") or "UnknownTestClass"
        test_name = _attr(open_text, "name") or "UnknownTest"
        try:
            seconds = float(_attr(open_text, "time"))
        except ValueError:
            seconds = -1
        if seconds >= 0:
            timings.append({"testClass": test_class, "testName": test_name, "durationMs": round(seconds * 1000)})
        if SKIPPED_RE.search(block):
            skipped += 1
            continue
        outcome = OUTCOME_RE.search(block)
        if not outcome:
            continue
        failed += 1
        if len(failures) >= MAX_FAILURES:
            continue
        tag = outcome.group(1).lower()
        failure_match = re.search(rf"<{tag}\b[^>]*(?:/>|>[\s\S]*?</{tag}>)", block, re.IGNORECASE)
        failure_block = failure_match.group(0) if failure_match else ""
        failure_message = _attr(failure_block, "message")
        body_match = re.search(rf"<{tag}\b[^>]*>([\s\S]*?)</{tag}>", failure_block, re.IGNORECASE)
        body = _strip_xml(body_match.group(1)) if body_match else ""
        failures.append(
            {
                "testClass": test_class,
                "testName": test_name,
                "error": (failure_message or body or "Test failed; see the Gradle report/output.")[:MAX_ERROR_LENGTH],
            }
        )
    return {"cases": cases, "failed": failed, "skipped": skipped, "failures": failures, "timings": timings}


def _parse_suite_fallback(xml: str) -> dict[str, int]:
    total = failed = skipped = 0
    for match in re.finditer(r"<testsuite\b[^>]*>", xml, re.IGNORECASE):
        tag = match.group(0)
        total += int(_attr(tag, "tests") or 0)
        failed += int(_attr(tag, "failures") or 0) + int(_attr(tag, "errors") or 0)
        skipped += int(_attr(tag, "skipped") or 0)
    return {"total": total, "failed": failed, "skipped": skipped}


def _walk_report_files(directory: Path, output: list[str], depth: int) -> None:
    if depth > 6:
        return
    try:
        entries = list(directory.iterdir())
    except OSError:
        return
    for entry in entries:
        if entry.is_dir():
            _walk_report_files(entry, output, depth + 1)
        elif entry.is_file() and re.match(r"^TEST-.*\.xml$", entry.name, re.IGNORECASE):
            output.append(str(entry))


def report_directories(project_root: Path, module_path: str, task_name: str, instrumentation: bool) -> list[Path]:
    module_directory = "/".join(p for p in module_path[1:].split(":") if p) if module_path else ""
    base = project_root / module_directory / "build" if module_directory else project_root / "build"
    if instrumentation:
        return [base / "outputs" / "androidTest-results", base / "test-results" / task_name]
    return [base / "test-results" / task_name]


def collect_report_files(project_root: Path, module_path: str, task_name: str, instrumentation: bool = False) -> list[str]:
    files: list[str] = []
    for directory in report_directories(project_root, module_path, task_name, instrumentation):
        _walk_report_files(directory, files, 0)
    return sorted(set(files))


def parse_reports(files: list[str], minimum_mtime_ms: float | None = None, max_failures: int = 100) -> dict[str, Any]:
    total = failed = skipped = usable = 0
    failures: list[dict[str, str]] = []
    timings: list[dict[str, Any]] = []
    for file in files:
        try:
            mtime = os.stat(file).st_mtime * 1000
            if minimum_mtime_ms is not None and mtime < minimum_mtime_ms:
                continue
            xml = Path(file).read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        parsed = _parse_testcases(xml)
        if parsed["cases"] > 0:
            usable += 1
            total += parsed["cases"]
            failed += parsed["failed"]
            skipped += parsed["skipped"]
            failures.extend(parsed["failures"])
            timings.extend(parsed["timings"])
        else:
            fallback = _parse_suite_fallback(xml)
            if fallback["total"] > 0:
                usable += 1
                total += fallback["total"]
                failed += fallback["failed"]
                skipped += fallback["skipped"]
    capped = failures[: max(1, min(max_failures, MAX_FAILURES))]
    timings.sort(key=lambda t: t["durationMs"], reverse=True)
    completeness = "none" if usable == 0 else ("complete" if usable == len(files) else "partial")
    return {
        "reportFiles": len(files),
        "usableReports": usable,
        "total": total,
        "passed": max(0, total - failed - skipped),
        "failed": failed,
        "skipped": skipped,
        "failuresList": capped,
        "reportCompleteness": completeness,
        "slowestTests": timings[:MAX_SLOW_TESTS],
    }


def empty_summary() -> dict[str, Any]:
    return {
        "reportFiles": 0, "usableReports": 0, "total": 0, "passed": 0, "failed": 0, "skipped": 0,
        "failuresList": [], "reportCompleteness": "none", "slowestTests": [],
    }


# ---------------------------------------------------------------------------
# Coverage + history (ports of src/coverage.ts and src/history.ts)
# ---------------------------------------------------------------------------


def collect_coverage(project_root: Path, modules: list[str]) -> dict[str, Any]:
    """Parse existing JaCoCo XML reports under module build/reports/jacoco."""
    xml_paths: list[Path] = []
    for module in modules:
        module_dir = "/".join(p for p in module[1:].split(":") if p) if module else ""
        base = (project_root / module_dir / "build") if module_dir else (project_root / "build")
        jacoco_dir = base / "reports" / "jacoco"
        if jacoco_dir.is_dir():
            for path in jacoco_dir.rglob("*.xml"):
                xml_paths.append(path)
    if not xml_paths:
        return {"available": False, "linePercent": -1, "branchPercent": -1, "instructionPercent": -1,
                "methodPercent": -1, "classPercent": -1, "reportFiles": 0}

    def counter_values(xml: str, counter_type: str) -> tuple[int, int]:
        for match in re.finditer(rf"<counter type=\"{counter_type}\"[^>]*missed=\"(\d+)\" covered=\"(\d+)\"", xml):
            pass
        matches = re.findall(rf"<counter type=\"{counter_type}\"[^>]*missed=\"(\d+)\" covered=\"(\d+)\"", xml)
        if not matches:
            return 0, 0
        missed, covered = matches[-1]  # last = report-level aggregate
        return int(missed), int(covered)

    def pct(missed: int, covered: int) -> float:
        return round(covered * 100.0 / (covered + missed), 1) if (covered + missed) > 0 else -1

    line_m = line_c = branch_m = branch_c = instr_m = instr_c = method_m = method_c = class_m = class_c = 0
    for path in xml_paths:
        try:
            xml = path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        for key, kind in (("line", "LINE"), ("branch", "BRANCH"), ("instruction", "INSTRUCTION"), ("method", "METHOD"), ("class", "CLASS")):
            m, c = counter_values(xml, kind)
            if kind == "LINE":
                line_m, line_c = line_m + m, line_c + c
            elif kind == "BRANCH":
                branch_m, branch_c = branch_m + m, branch_c + c
            elif kind == "INSTRUCTION":
                instr_m, instr_c = instr_m + m, instr_c + c
            elif kind == "METHOD":
                method_m, method_c = method_m + m, method_c + c
            elif kind == "CLASS":
                class_m, class_c = class_m + m, class_c + c

    return {
        "available": True,
        "linePercent": pct(line_m, line_c),
        "branchPercent": pct(branch_m, branch_c),
        "instructionPercent": pct(instr_m, instr_c),
        "methodPercent": pct(method_m, method_c),
        "classPercent": pct(class_m, class_c),
        "reportFiles": len(xml_paths),
    }


def empty_coverage() -> dict[str, Any]:
    return {"available": False, "linePercent": -1, "branchPercent": -1, "instructionPercent": -1,
            "methodPercent": -1, "classPercent": -1, "reportFiles": 0}


HISTORY_DIR = ".dsh/test-history"
HISTORY_KEEP = 100


def _history_file(project_root: Path) -> Path:
    return project_root / HISTORY_DIR / "latest.json"


def load_previous(project_root: Path) -> dict[str, Any] | None:
    try:
        return json.loads(_history_file(project_root).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


def save_history(project_root: Path, entry: dict[str, Any]) -> None:
    history_file = _history_file(project_root)
    try:
        history_file.parent.mkdir(parents=True, exist_ok=True)
        # Rotate: latest.json -> previous.json (bounded history, last 100 kept as
        # numbered records; the TS plugin keeps 100, we keep the same latest/previous pair
        # plus numbered archive up to 100).
        previous = project_root / HISTORY_DIR / "previous.json"
        if history_file.exists():
            previous.write_text(history_file.read_text(encoding="utf-8"), encoding="utf-8")
        archive_dir = history_file.parent / "archive"
        archive_dir.mkdir(exist_ok=True)
        existing = sorted(archive_dir.glob("run-*.json"))
        if len(existing) >= HISTORY_KEEP:
            existing[0].unlink()
        stamp = time.strftime("%Y%m%d-%H%M%S")
        (archive_dir / f"run-{stamp}.json").write_text(json.dumps(entry), encoding="utf-8")
        history_file.write_text(json.dumps(entry), encoding="utf-8")
    except OSError:
        pass


def compare_summary(previous: dict[str, Any] | None, current: dict[str, Any]) -> dict[str, Any]:
    if not previous:
        return {"previousAvailable": False, "failedDelta": 0, "durationDeltaMs": 0}
    return {
        "previousAvailable": True,
        "failedDelta": current["failed"] - int(previous.get("failed", 0)),
        "durationDeltaMs": current["durationMs"] - int(previous.get("durationMs", 0)),
    }


# ---------------------------------------------------------------------------
# Tool core (port of src/index.ts execute())
# ---------------------------------------------------------------------------

SERVER_NAME = "dsh-android-runner-mcp"
TOOL_NAME = "run_robolectric"


class ToolError(Exception):
    """Raised for validation errors; surfaces as an MCP tool error result."""


INPUT_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "module": {"type": "string", "description": "Backward-compatible single Gradle module path, for example app or :feature:login."},
        "modules": {"type": "array", "items": {"type": "string"},
                    "description": 'Optional Gradle module paths for multi-module execution, for example ["app", ":feature:login"]. Use this instead of module when running multiple modules.'},
        "variant": {"type": "string", "description": "Android build variant, for example Debug, Release, or BenchmarkDebug. Defaults to Debug."},
        "testType": {"type": "string", "enum": ["auto", "jvm", "robolectric", "instrumentation", "device"],
                     "description": "Test strategy: auto/jvm/robolectric use local JVM tests; instrumentation/device uses connected Android device tests. Default jvm."},
        "testFilter": {"type": "string", "description": "JVM: Gradle --tests selector. Instrumentation: Android runner selector such as com.example.LoginTest or com.example.LoginTest#login."},
        "rerunFailed": {"type": "boolean", "description": "Rerun failed/error cases found in the previous XML reports. Cannot be combined with testFilter."},
        "timeoutMs": {"type": "number", "description": f"Maximum Gradle execution time. Default {DEFAULT_TIMEOUT_MS}; allowed 1000-{MAX_TIMEOUT_MS}."},
        "maxFilters": {"type": "number", "description": f"Maximum failure filters used for rerun. Default {DEFAULT_MAX_FILTERS}; hard maximum {HARD_MAX_FILTERS}."},
        "maxOutputTail": {"type": "number", "description": f"Maximum Gradle output characters returned. Default {DEFAULT_MAX_OUTPUT_TAIL}; hard maximum {HARD_MAX_OUTPUT_TAIL}."},
        "continueOnFailure": {"type": "boolean", "description": "Add Gradle --continue so independent tasks can complete and report all failures."},
        "parallel": {"type": "boolean", "description": "Add Gradle --parallel for multi-module execution. For instrumentation, use only when the connected-device environment supports it."},
        "gradleProperties": {"type": "object", "additionalProperties": {"type": "string"},
                             "description": "Optional safe Gradle -P properties. Only org.gradle.* and android.testInstrumentationRunnerArguments.* keys are accepted."},
        "useSystemGradle": {"type": "boolean", "description": "Opt in to a system Gradle executable when the project wrapper is unavailable. Default false."},
        "detailedReport": {"type": "boolean", "description": "Return a bounded list of fresh report file paths. Default false."},
        "debug": {"type": "boolean", "description": "Enable additional diagnostics in the result. Default false."},
        "compareWithPrevious": {"type": "boolean", "description": "Store a compact .dsh/test-history entry and compare the run with the previous entry."},
        "coverage": {"type": "boolean", "description": "Parse existing JaCoCo XML reports after the test run. The tool does not enable JaCoCo itself."},
    },
}


def normalize_test_type(value: str | None) -> str:
    raw = (value or "jvm").strip().lower()
    if raw in ("jvm", "robolectric", "auto"):
        return "jvm"
    if raw in ("instrumentation", "device"):
        return "instrumentation"
    raise ToolError("testType must be one of: auto, jvm, robolectric, instrumentation, device.")


def validate_limits(args: dict[str, Any]) -> dict[str, int]:
    timeout_ms = int(args.get("timeoutMs", DEFAULT_TIMEOUT_MS))
    if timeout_ms < 1000 or timeout_ms > MAX_TIMEOUT_MS:
        raise ToolError(f"timeoutMs must be an integer between 1000 and {MAX_TIMEOUT_MS}.")
    max_filters = int(args.get("maxFilters", DEFAULT_MAX_FILTERS))
    if max_filters < 1 or max_filters > HARD_MAX_FILTERS:
        raise ToolError(f"maxFilters must be an integer between 1 and {HARD_MAX_FILTERS}.")
    max_output_tail = int(args.get("maxOutputTail", DEFAULT_MAX_OUTPUT_TAIL))
    if max_output_tail < 500 or max_output_tail > HARD_MAX_OUTPUT_TAIL:
        raise ToolError(f"maxOutputTail must be an integer between 500 and {HARD_MAX_OUTPUT_TAIL}.")
    return {"timeoutMs": timeout_ms, "maxFilters": max_filters, "maxOutputTail": max_output_tail}


def _project_root_from_args(args: dict[str, Any]) -> Path:
    raw = args.get("projectRoot") or args.get("cwd")
    if not isinstance(raw, str) or not raw.strip():
        raise ToolError(
            "projectRoot is required: the absolute path of the Android project root "
            "(the directory containing settings.gradle.kts and gradlew)."
        )
    root = Path(raw).expanduser().resolve()
    if not root.is_dir():
        raise ToolError(f"projectRoot is not a directory: {root}")
    return root


def execute_tool(args: dict[str, Any]) -> dict[str, Any]:
    """Synchronous core of run_robolectric; run via asyncio.to_thread."""
    project_root = _project_root_from_args(args)
    limits = validate_limits(args)
    if args.get("rerunFailed") and args.get("testFilter"):
        raise ToolError("rerunFailed and testFilter cannot be used together.")
    test_type = normalize_test_type(args.get("testType"))
    module_input = args.get("modules") if args.get("modules") is not None else args.get("module")
    modules = normalize_modules(project_root, module_input)
    if len(modules) > MAX_MODULES:
        raise ToolError(f"A maximum of {MAX_MODULES} modules is supported.")
    if not wrapper_exists(project_root) and not args.get("useSystemGradle"):
        raise ToolError("Gradle wrapper not found. Set useSystemGradle=true only when a trusted system Gradle installation is intentionally available.")
    variant = normalize_variant(args.get("variant"))
    properties = validate_gradle_properties(args.get("gradleProperties"))
    explicit_filter = (
        normalize_instrumentation_filter(args.get("testFilter"))
        if test_type == "instrumentation"
        else normalize_jvm_filter(args.get("testFilter"))
    )
    tasks = build_tasks(modules, variant, test_type)
    task_names = [task.split(":").filter(None)[-1] if False else [p for p in task.split(":") if p][-1] for task in tasks]
    selected_filters: list[str] = [explicit_filter] if explicit_filter else []

    if args.get("rerunFailed"):
        if len(modules) > 1:
            raise ToolError(
                "rerunFailed is currently supported for one module at a time. Run each module separately so a failure filter "
                "from one module cannot be incorrectly applied to another module."
            )
        previous_files = collect_report_files(project_root, modules[0], task_names[0], test_type == "instrumentation")
        previous_summary = parse_reports(previous_files, None, limits["maxFilters"])
        failures = previous_summary["failuresList"]
        sep = "#" if test_type == "instrumentation" else "."
        selected_filters = []
        for failure in failures:
            filt = f"{failure['testClass']}{sep}{failure['testName']}"
            if filt not in selected_filters:
                selected_filters.append(filt)
            if len(selected_filters) >= limits["maxFilters"]:
                break
        # Rerun filters derive from XML report attribute values and flow through
        # cmd.exe on Windows exactly like an explicit testFilter; same gate applies.
        selected_filters = [validate_rerun_filter(f) for f in selected_filters]
        if test_type == "instrumentation" and len(selected_filters) > 1:
            raise ToolError(
                "Instrumentation rerunFailed found multiple failing test cases. The Android runner accepts one class/method "
                "selector per invocation; run a specific testFilter for the desired case."
            )
        if not selected_filters:
            return {
                "success": True, "executionStatus": "no_previous_failures",
                "message": "No previous failed/error test cases were found; nothing was rerun.",
                "projectRoot": str(project_root), "testType": test_type, "gradleTask": " ".join(tasks),
                "selectedFilters": [], "durationMs": 0, "summary": empty_summary(),
                "gradleErrorType": "UNKNOWN", "gradleErrorMessage": "No execution was required.",
                "reportPaths": [], "coverage": empty_coverage(),
                "comparison": {"previousAvailable": False, "failedDelta": 0, "durationDeltaMs": 0},
                "rawOutputTail": "",
            }

    gradle_args = [*tasks]
    if test_type == "jvm":
        for filt in selected_filters:
            gradle_args.extend(["--tests", filt])
    if test_type == "instrumentation" and len(selected_filters) == 1:
        gradle_args.append(f"-Pandroid.testInstrumentationRunnerArguments.class={selected_filters[0]}")
    gradle_args.extend(properties)
    if args.get("parallel") and len(modules) > 1:
        gradle_args.append("--parallel")
    if args.get("continueOnFailure"):
        gradle_args.append("--continue")
    gradle_args.extend(["--rerun-tasks", "--no-daemon", "--console=plain"])

    debug = bool(args.get("debug"))
    if debug:
        print(f"[dsh-android-runner-mcp] type={test_type} modules={','.join(modules)} tasks={','.join(tasks)} filters={len(selected_filters)}", file=sys.stderr)

    # Snapshot pre-existing test reports (path -> mtime) BEFORE Gradle runs so a
    # run that fails before producing reports never inherits stale results.
    pre_run_reports: dict[str, float] = {}
    for module, task_name in zip(modules, task_names):
        for file in collect_report_files(project_root, module, task_name, test_type == "instrumentation"):
            try:
                pre_run_reports[file] = os.stat(file).st_mtime * 1000
            except OSError:
                pass

    started_at_epoch = time.time() * 1000
    run = asyncio.run(run_gradle(project_root, gradle_args, limits["timeoutMs"], bool(args.get("useSystemGradle"))))
    raw_text = run["stdout"] + (f"\n[stderr]\n{run['stderr']}" if run["stderr"] else "")
    max_tail = limits["maxOutputTail"]
    raw_output_tail = raw_text.strip()[-max_tail:]

    if run.get("spawnError"):
        return _error_result(f"Unable to execute Gradle: {run['stderr']}", project_root, test_type, tasks,
                             selected_filters, run["durationMs"], raw_output_tail, "execution_error")
    if run["timedOut"]:
        result = _error_result(f"Gradle exceeded the {limits['timeoutMs']} ms timeout.", project_root, test_type, tasks,
                               selected_filters, run["durationMs"], raw_output_tail, "timeout")
        result["gradleErrorType"] = "TIMEOUT"
        result["gradleErrorMessage"] = "Gradle execution exceeded the configured timeout."
        return result

    report_files: list[str] = []
    for module, task_name in zip(modules, task_names):
        report_files.extend(collect_report_files(project_root, module, task_name, test_type == "instrumentation"))
    unique_report_files = sorted(set(report_files))
    fresh_report_files = []
    for file in unique_report_files:
        try:
            mtime = os.stat(file).st_mtime * 1000
        except OSError:
            continue
        if mtime < started_at_epoch:
            continue
        previous = pre_run_reports.get(file)
        if previous is not None and mtime <= previous:
            continue
        fresh_report_files.append(file)

    summary = parse_reports(fresh_report_files, started_at_epoch, limits["maxFilters"])
    if summary["failed"] > 0:
        diagnostic = {"type": "TEST_FAILURE", "message": "The fresh XML reports contain failed/error test cases."}
    elif run["exitCode"] == 0:
        diagnostic = {"type": "UNKNOWN", "message": "Gradle completed without a recognized error."}
    else:
        diagnostic = classify_gradle_error(run["stdout"], run["stderr"])

    report_paths = []
    if args.get("detailedReport"):
        report_paths = [os.path.relpath(f, project_root) for f in fresh_report_files[:100]]

    coverage = collect_coverage(project_root, modules) if args.get("coverage") else empty_coverage()

    current_history = {
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "task": " ".join(tasks), "modules": modules, "testType": test_type,
        "total": summary["total"], "passed": summary["passed"], "failed": summary["failed"],
        "skipped": summary["skipped"], "durationMs": run["durationMs"],
    }
    if args.get("compareWithPrevious"):
        previous = load_previous(project_root)
        comparison = compare_summary(previous, current_history)
        save_history(project_root, current_history)
    else:
        comparison = {"previousAvailable": False, "failedDelta": 0, "durationDeltaMs": 0}

    has_reports = summary["usableReports"] > 0
    success = run["exitCode"] == 0 and summary["failed"] == 0 and has_reports
    status = "passed" if success else ("failed" if (has_reports or run["exitCode"] != 0) else "parse_error")
    if success:
        message = f"Gradle completed successfully. {summary['total']} tests: {summary['passed']} passed, {summary['failed']} failed, {summary['skipped']} skipped."
    elif has_reports:
        message = f"Gradle finished with {summary['failed']} failed/error test(s)."
    else:
        message = f"Gradle completed but no fresh XML test report could be parsed reliably. Exit code: {run['exitCode']}."

    return {
        "success": success, "executionStatus": status, "message": message,
        "projectRoot": str(project_root), "testType": test_type, "gradleTask": " ".join(tasks),
        "selectedFilters": selected_filters, "durationMs": run["durationMs"], "summary": summary,
        "gradleErrorType": diagnostic["type"], "gradleErrorMessage": diagnostic["message"],
        "reportPaths": report_paths, "coverage": coverage, "comparison": comparison,
        "rawOutputTail": raw_output_tail,
    }


def _error_result(message: str, project_root: Path, test_type: str, tasks: list[str], selected_filters: list[str],
                  duration_ms: int, raw_output_tail: str, status: str) -> dict[str, Any]:
    return {
        "success": False, "executionStatus": status, "message": message,
        "projectRoot": str(project_root), "testType": test_type, "gradleTask": " ".join(tasks),
        "selectedFilters": selected_filters, "durationMs": duration_ms, "summary": empty_summary(),
        "gradleErrorType": "UNKNOWN", "gradleErrorMessage": message,
        "reportPaths": [], "coverage": empty_coverage(),
        "comparison": {"previousAvailable": False, "failedDelta": 0, "durationDeltaMs": 0},
        "rawOutputTail": raw_output_tail,
    }


# ---------------------------------------------------------------------------
# MCP server wiring (mcp SDK 2.x lowlevel API, constructor-based handlers)
# ---------------------------------------------------------------------------


def build_server():
    from mcp.server.lowlevel import Server
    import mcp.types as types

    async def on_list_tools(ctx, params) -> types.ListToolsResult:
        return types.ListToolsResult(
            tools=[
                types.Tool(
                    name=TOOL_NAME,
                    description=(
                        "Safely run Android local JVM/Robolectric tests or Android instrumentation tests from an Android "
                        "project root. Supports single- and multi-module execution, failure reruns, Gradle diagnostics "
                        "(OOM/JDK/SDK/ADB/dependency/compilation/timeout), fresh-report protection, optional JaCoCo coverage "
                        "parsing and test-history comparison. Never accepts an arbitrary shell command. Requires the "
                        "absolute projectRoot of the Android project (a directory containing settings.gradle and gradlew)."
                    ),
                    inputSchema=INPUT_SCHEMA,
                )
            ]
        )

    async def on_call_tool(ctx, params) -> types.CallToolResult:
        if params.name != TOOL_NAME:
            return types.CallToolResult(
                content=[types.TextContent(type="text", text=f"Unknown tool: {params.name}")],
                is_error=True,
            )
        args = dict(params.arguments or {})
        try:
            result = await asyncio.to_thread(execute_tool, args)
        except ToolError as exc:
            # Per the MCP spec, tool-level errors belong in the result with
            # is_error=true (not a protocol error) so the LLM can self-correct.
            return types.CallToolResult(
                content=[types.TextContent(type="text", text=str(exc))],
                is_error=True,
            )
        except Exception as exc:  # noqa: BLE001 — surface unexpected errors as tool errors
            return types.CallToolResult(
                content=[types.TextContent(type="text", text=f"dsh-android-runner-mcp internal error: {exc}")],
                is_error=True,
            )
        return types.CallToolResult(
            content=[types.TextContent(type="text", text=json.dumps(result, ensure_ascii=False))],
            structured_content=result,
        )

    return Server(SERVER_NAME, on_list_tools=on_list_tools, on_call_tool=on_call_tool)


def main() -> None:
    server = build_server()
    from mcp.server.stdio import stdio_server

    async def run() -> None:
        async with stdio_server() as (read_stream, write_stream):
            await server.run(read_stream, write_stream, server.create_initialization_options())

    asyncio.run(run())


if __name__ == "__main__":
    main()
