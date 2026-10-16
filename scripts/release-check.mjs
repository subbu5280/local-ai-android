#!/usr/bin/env node
/**
 * Release checks (M8): run before building a release. Usage:
 *   node scripts/release-check.mjs           TypeScript, ESLint (errors), Jest (all suites incl. migrations, backup
 *                                            format, restore safety), manifest permissions/flags, secret scan of the
 *                                            files git would track, and a scan for dangerous APIs
 *   node scripts/release-check.mjs --build   ...and build the release APK, check its merged manifest and signing
 *                                            certificate (apksigner), report size and SHA-256
 *   --emulator emulator-5554                 ...and run the Kotlin crypto tests and the release app's backup/restore
 *                                            end to end on that EMULATOR (never a phone: it clears the app data)
 *   --reference D:/Projects/AI-ChatBot       ...and check that the reference repository has no changes
 * The Kotlin JVM tests of the production crypto (BackupCrypto) always run (Gradle --offline).
 * Exits non-zero if any check fails. Static scans catch known mistakes; they do not prove the app is secure.
 */
import { execSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`); };
const run = (name, cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { stdio: opts.quiet ? 'pipe' : 'inherit', shell: process.platform === 'win32', ...opts });
  check(name, r.status === 0, r.status === 0 ? '' : `exit ${r.status}`);
  return r;
};

// 1. Code checks.
run('TypeScript', 'npx', ['tsc', '--noEmit']);
run('ESLint (errors)', 'npx', ['eslint', '.', '--quiet']);
run('Jest (all suites)', 'npx', ['jest', '--silent']);

// 2. Android manifest: only the permissions the features need; no app data in cloud backup / device transfer.
const manifest = readFileSync('android/app/src/main/AndroidManifest.xml', 'utf8');
const perms = [...manifest.matchAll(/<uses-permission android:name="([^"]+)" \/>/g)].map(m => m[1]).sort();
const allowed = ['android.permission.ACCESS_COARSE_LOCATION', 'android.permission.ACCESS_NETWORK_STATE', 'android.permission.INTERNET', 'android.permission.POST_NOTIFICATIONS', 'android.permission.RECEIVE_BOOT_COMPLETED', 'android.permission.RECORD_AUDIO'];
check('Manifest permissions', JSON.stringify(perms) === JSON.stringify(allowed), perms.join(', '));
check('Manifest backup settings', /android:allowBackup="false"/.test(manifest) && /android:dataExtractionRules=/.test(manifest), 'allowBackup=false + dataExtractionRules');
check('Manifest not debuggable', !/android:debuggable="true"/.test(manifest));
check('Release cleartext HTTP off', /<base-config cleartextTrafficPermitted="false"/.test(readFileSync('android/app/src/main/res/xml/network_security_config.xml', 'utf8')));

// 3. Secrets in files git would track (committed or not ignored).
const files = execSync('git ls-files -co --exclude-standard', { encoding: 'utf8' }).split('\n').filter(Boolean)
  .filter(f => existsSync(f) && statSync(f).size < 2_000_000 && !/\.(png|jpg|jar|keystore|gguf|apk|ttf|lock)$/i.test(f) && !f.startsWith('node_modules/'));
const SECRET = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/, /\bAKIA[0-9A-Z]{16}\b/, /\bgh[pousr]_[A-Za-z0-9]{36}\b/, /\bsk-[A-Za-z0-9]{32,}\b/, /\bhf_[A-Za-z0-9]{30,}\b/,
  /\bAIza[0-9A-Za-z_-]{35}\b/, /(store|key)Password\s+['"](?!android['"])[^'"]+['"]/, /LOCALAI_RELEASE_\w+_PASSWORD\s*=\s*(?!\.\.\.|<)\S+/, // a real value, not the "..." placeholder in the docs
];
const TEST_FIXTURE = /^(__tests__|testUtils|eval)\//; // test data deliberately contains fake secrets to test redaction
const leaks = files.filter(f => !TEST_FIXTURE.test(f) && SECRET.some(re => re.test(readFileSync(f, 'utf8'))));
check('No secrets in tracked files', leaks.length === 0, leaks.join(', '));
check('No keystore, database, backup or model files tracked', !files.some(f => /\.(jks|db|gguf|laibackup)$|(^|\/)\.env$|release\.keystore$/i.test(f)));

// 4. Dangerous APIs that must not appear in app code.
const appFiles = files.filter(f => /^(src\/|App\.tsx|android\/app\/src\/main\/)/.test(f) && /\.(tsx?|kt|java|xml)$/.test(f));
const DANGER = [/(require\(|from )['"]child_process['"]/, /\beval\(/, /new Function\(/, /Runtime\.getRuntime\(\)\.exec/, /ProcessBuilder/, /DexClassLoader/,
  /<WebView|react-native-webview/, /MANAGE_EXTERNAL_STORAGE/, /setWebContentsDebuggingEnabled\(true\)/];
const danger = appFiles.filter(f => DANGER.some(re => re.test(readFileSync(f, 'utf8'))));
check('No execution / unrestricted-storage APIs', danger.length === 0, danger.join(', '));

// 5. The production Kotlin cryptography on the laptop JVM (offline: test libraries come from the Gradle cache).
const gradle = (name, task, opts = {}) => (process.platform === 'win32'
  // An explicit .\ path: cmd may be set not to search the current directory (NoDefaultCurrentDirectoryInExePath).
  ? run(name, 'cmd.exe', ['/d', '/c', `.\\gradlew.bat ${task} --console=plain`], { cwd: resolve('android'), quiet: true, shell: false, ...opts })
  : run(name, './gradlew', [...task.split(' '), '--console=plain'], { cwd: 'android', quiet: true, ...opts }));
const unit = gradle('Kotlin crypto tests on the JVM (BackupCrypto)', ':app:testDebugUnitTest --offline');
const xml = 'android/app/build/test-results/testDebugUnitTest/TEST-com.subbu.localai.BackupCryptoJvmTest.xml';
if (existsSync(xml)) {
  const s = readFileSync(xml, 'utf8').match(/<testsuite[^>]*tests="(\d+)"[^>]*failures="(\d+)"[^>]*errors="(\d+)"/);
  check('Kotlin JVM test results', !!s && s[2] === '0' && s[3] === '0' && Number(s[1]) > 0, s ? `${s[1]} tests, ${s[2]} failures, ${s[3]} errors` : 'no results');
} else if (unit.status === 0) check('Kotlin JVM test results', false, 'no result file');

// 6. Optional release build, with the merged manifest and the APK's signing certificate checked.
const apk = 'android/app/build/outputs/apk/release/app-release.apk';
if (process.argv.includes('--build')) {
  const r = gradle('Android release build', 'assembleRelease');
  if (r.status !== 0) console.log(String(r.stdout ?? '').slice(-3000), String(r.stderr ?? '').slice(-3000));
  const merged = 'android/app/build/intermediates/merged_manifest/release/processReleaseMainManifest/AndroidManifest.xml';
  if (existsSync(merged)) {
    const m = readFileSync(merged, 'utf8');
    check('Release manifest: no cloud backup / device transfer, no cleartext, not debuggable',
      /android:allowBackup="false"/.test(m) && /android:dataExtractionRules="@xml\/data_extraction_rules"/.test(m) && /android:usesCleartextTraffic="false"/.test(m) && !/android:debuggable="true"/.test(m));
  }
  if (existsSync(apk)) {
    const bytes = readFileSync(apk);
    console.log(`APK ${apk}: ${(bytes.length / 1048576).toFixed(1)} MB, sha256 ${createHash('sha256').update(bytes).digest('hex')}`);
    const sdk = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT;
    const tools = sdk && existsSync(`${sdk}/build-tools`) ? readdirSync(`${sdk}/build-tools`).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).pop() : null;
    const signer = tools ? `${sdk}/build-tools/${tools}/apksigner${process.platform === 'win32' ? '.bat' : ''}` : null;
    if (signer && existsSync(signer)) {
      const v = spawnSync(signer, ['verify', '--print-certs', apk], { encoding: 'utf8', shell: process.platform === 'win32' });
      const dn = (v.stdout.match(/certificate DN: (.*)/) ?? [])[1] ?? 'unknown';
      check('APK signature verifies', v.status === 0, dn);
      console.log(/CN=Android Debug/.test(dn) ? 'Signing: DEBUG key — fine for your own phone, NOT a production release (see docs/release.md).' : `Signing: ${dn}`);
    } else console.log('apksigner not found (set ANDROID_HOME): signing certificate not checked.');
  }
}

// 7. Optional: on an EMULATOR, the Kotlin crypto tests and the release app's backup/restore end to end.
const emu = process.argv.includes('--emulator') ? process.argv[process.argv.indexOf('--emulator') + 1] : null;
if (emu) {
  if (!/^emulator-/.test(emu ?? '')) check('Emulator serial', false, 'only emulators: the end-to-end check clears the app data');
  else {
    gradle('Build debug app + instrumentation tests', ':app:assembleDebug :app:assembleDebugAndroidTest --offline');
    const adb = (...a) => spawnSync('adb', ['-s', emu, ...a], { encoding: 'utf8', env: { ...process.env, MSYS_NO_PATHCONV: '1' } });
    adb('install', '-r', '-t', 'android/app/build/outputs/apk/debug/app-debug.apk');
    adb('install', '-r', '-t', 'android/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk');
    const t = adb('shell', 'am', 'instrument', '-w', '-r', 'com.subbu.localai.test/androidx.test.runner.AndroidJUnitRunner');
    const ok = (t.stdout.match(/OK \((\d+) tests?\)/) ?? [])[1];
    check(`Kotlin crypto tests on ${emu}`, !!ok, ok ? `${ok} tests` : t.stdout.slice(-800));
    if (existsSync(apk)) run(`Release app backup/restore end to end on ${emu}`, 'node', ['scripts/emulator-backup-e2e.mjs', '--serial', emu], { shell: false });
    else check('Release app end to end', false, 'build the release APK first (--build)');
  }
}

// 8. Optional: the reference repository must be unchanged.
const ref = process.argv.includes('--reference') ? process.argv[process.argv.indexOf('--reference') + 1] : null;
if (ref) {
  const s = spawnSync('git', ['-C', ref, 'status', '--porcelain'], { encoding: 'utf8' });
  check('Reference repository unchanged', s.status === 0 && s.stdout.trim() === '', s.stdout.trim().split('\n').slice(0, 5).join('; '));
}

const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
process.exit(failed.length ? 1 : 0);
