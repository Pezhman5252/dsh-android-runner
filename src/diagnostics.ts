export type GradleErrorType = 'OOM' | 'DAEMON' | 'JDK' | 'ANDROID_SDK' | 'ADB' | 'DEVICE' | 'DEPENDENCY' | 'COMPILATION' | 'TIMEOUT' | 'GRADLE_VERSION' | 'TEST_FAILURE' | 'UNKNOWN'

const patterns: Array<[GradleErrorType, RegExp]> = [
  ['OOM', /(OutOfMemoryError|Java heap space|GC overhead limit exceeded|Metaspace)/i],
  ['JDK', /(JAVA_HOME|JDK|Java home).*(not set|not found|could not be determined|invalid)|No Java runtime present/i],
  ['ANDROID_SDK', /(ANDROID_SDK_ROOT|ANDROID_HOME).*(not set|not found|does not exist)|SDK location not found/i],
  ['ADB', /(adb.*(not found|cannot be found|failed)|device .*unauthorized|adb server)/i],
  ['DEVICE', /(no connected devices|no devices found|device .*offline|emulator.*offline|failed to install.*apk|INSTALL_FAILED)/i],
  ['DAEMON', /(Gradle daemon.*(stopped|disappeared|could not be started)|Daemon is stopped|daemon disappeared)/i],
  ['DEPENDENCY', /(Could not resolve .*|Could not find .*|Failed to resolve|dependency.*failed)/i],
  ['COMPILATION', /(Compilation failed|Kotlin compiler|compile.*failed|e: .*\.kt:)/i],
  ['GRADLE_VERSION', /(unsupported Gradle version|minimum supported Gradle version|requires Gradle|Could not determine the dependencies of task)/i],
  ['TEST_FAILURE', /(There were failing tests|tests failed|UnitTest FAILED|AndroidTest FAILED)/i],
]

export function classifyGradleError(stdout: string, stderr: string, timedOut = false): { type: GradleErrorType; message: string } {
  if (timedOut) return { type: 'TIMEOUT', message: 'Gradle execution exceeded the configured timeout.' }
  const text = `${stdout}\n${stderr}`
  for (const [type, pattern] of patterns) if (pattern.test(text)) return { type, message: diagnosis(type) }
  return { type: 'UNKNOWN', message: 'Gradle failed without matching a known diagnostic signature.' }
}
function diagnosis(type: GradleErrorType): string {
  switch (type) {
    case 'OOM': return 'Gradle/JVM memory exhaustion detected. Consider increasing org.gradle.jvmargs or reducing parallel work.'
    case 'DAEMON': return 'Gradle daemon startup/lifecycle failure detected. A clean non-daemon retry may be useful.'
    case 'JDK': return 'Java/JDK configuration problem detected. Verify JAVA_HOME and that the required JDK is installed.'
    case 'ANDROID_SDK': return 'Android SDK configuration problem detected. Verify SDK location and required SDK components.'
    case 'ADB': return 'ADB problem detected. Verify adb availability and server/device authorization.'
    case 'DEVICE': return 'Android device/emulator problem detected. Verify a ready, authorized device and APK installation compatibility.'
    case 'DEPENDENCY': return 'Gradle dependency resolution failed. Check repositories, network access, versions, and dependency declarations.'
    case 'COMPILATION': return 'Source compilation failed before or during test execution. Inspect compiler diagnostics.'
    case 'GRADLE_VERSION': return 'Gradle/Android Gradle Plugin version compatibility problem detected.'
    case 'TEST_FAILURE': return 'Gradle reported test failures. The XML reports are the authoritative source for individual failures.'
    default: return 'Unknown Gradle failure.'
  }
}
