#!/usr/bin/env node
/**
 * M9: end-to-end check of encrypted backup and restore in the RELEASE app on an Android EMULATOR, through the real UI:
 * the bundled JavaScript (src/backup/), the React Native bridge, AiCryptoModule/BackupCrypto, and Android's own save
 * and open pickers (DocumentsUI). Steps:
 *   1. install the release APK and clear the app's data (a fresh app);
 *   2. open Agents (creates the three default agents), then Data → Backup and restore → create a backup with a
 *      password and save it with the system save picker;
 *   3. pull the saved backup to verification/runs/ (for the TypeScript/Node cross-check: E2E_BACKUP=… npx jest
 *      __tests__/cryptoVectors);
 *   4. clear the app's data again (a "new phone"), restore: wrong password first (must be refused), then the right
 *      one, merge → the agents come back.
 * Usage: node scripts/emulator-backup-e2e.mjs --serial emulator-5554 [--apk path]
 * It refuses a physical phone unless --allow-device is given, because it CLEARS THE APP'S DATA.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';

const arg = name => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; };
const serial = arg('--serial');
if (!serial) { console.error('--serial is required (e.g. emulator-5554)'); process.exit(2); }
if (!serial.startsWith('emulator-') && !process.argv.includes('--allow-device')) { console.error('Refusing: this clears app data; use an emulator.'); process.exit(2); }
const apk = arg('--apk') ?? 'android/app/build/outputs/apk/release/app-release.apk';
const PKG = 'com.subbu.localai';
const PASSWORD = 'correct horse battery';
const adb = (...a) => execFileSync('adb', ['-s', serial, ...a], { encoding: 'utf8', maxBuffer: 64 << 20 });
const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const steps = [];
const step = (name, ok, detail = '') => { steps.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`); if (!ok) finish(1); };

function nodes() {
  adb('shell', 'uiautomator', 'dump', '/sdcard/ui.xml');
  const xml = adb('exec-out', 'cat', '/sdcard/ui.xml');
  return [...xml.matchAll(/<node [^>]*>/g)].map(m => {
    // uiautomator quotes an attribute with ' when its value contains a ".
    const a = k => { const r = m[0].match(new RegExp(` ${k}=(?:"([^"]*)"|'([^']*)')`)); return (r?.[1] ?? r?.[2] ?? '').replace(/&apos;/g, "'"); };
    const [x1, y1, x2, y2] = a('bounds').match(/\d+/g)?.map(Number) ?? [0, 0, 0, 0];
    return { text: a('text').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#10;/g, '\n'), desc: a('content-desc'), pkg: a('package'), x: (x1 + x2) / 2, y: (y1 + y2) / 2, h: y2 - y1 };
  });
}
const screenText = () => nodes().map(n => n.text || n.desc).filter(Boolean).join(' | ');
function waitFor(pred, ms = 20000, scroll = false) {
  const end = Date.now() + ms;
  for (let i = 0; Date.now() < end; i++) {
    const hit = nodes().find(pred);
    if (hit && hit.h > 0) return hit;
    if (scroll && i % 2 === 1) adb('shell', 'input', 'swipe', '540', '1600', '540', '700', '300');
    sleep(700);
  }
  return null;
}
const byDesc = d => n => n.desc === d;
const byText = re => n => re.test(n.text);
function tap(pred, what, ms, scroll = true) {
  const n = waitFor(pred, ms, scroll);
  if (!n) step(`find "${what}"`, false, screenText().slice(0, 600));
  adb('shell', 'input', 'tap', String(Math.round(n.x)), String(Math.round(n.y)));
  sleep(600);
}
function type(desc, text) {
  tap(byDesc(desc), desc);
  adb('shell', 'input', 'text', text.replace(/ /g, '%s'));
  adb('shell', 'input', 'keyevent', '111'); // hide the keyboard (ESCAPE)
  sleep(400);
}
function launch() {
  adb('shell', 'am', 'start', '-W', '-n', `${PKG}/.MainActivity`);
  step('app starts', !!waitFor(byDesc('Privacy and data'), 30000));
}
function finish(code) {
  const dir = 'verification/runs';
  mkdirSync(dir, { recursive: true });
  const file = `${dir}/${new Date().toISOString().replace(/[:.]/g, '-')}-backup-e2e.json`;
  const model = adb('shell', 'getprop', 'ro.product.model').trim(), release = adb('shell', 'getprop', 'ro.build.version.release').trim();
  writeFileSync(file, JSON.stringify({ serial, model, android: release, apk, steps }, null, 2));
  console.log(`\n${steps.filter(s => s.ok).length}/${steps.length} steps passed on ${model} (Android ${release}); log: ${file}`);
  process.exit(code);
}

// 1. A fresh release app.
adb('install', '-r', apk);
adb('shell', 'pm', 'clear', PKG);
adb('shell', 'rm', '-f', '/sdcard/Download/e2e-backup.laibackup');
launch();

// 2. Default agents, then a backup saved through the system save picker.
tap(byDesc('Agents'), 'Agents');
step('default agents created', !!waitFor(byText(/Document assistant/)));
adb('shell', 'input', 'keyevent', '4');
tap(byDesc('Privacy and data'), 'Privacy and data');
tap(byDesc('Backup and restore'), 'Backup and restore');
type('Backup password', PASSWORD);
type('Repeat backup password', PASSWORD);
let t0 = Date.now();
tap(byDesc('Create backup'), 'Create backup');
const saveButton = waitFor(n => /documentsui/.test(n.pkg) && /^save$/i.test(n.text), 60000, false);
step('system save picker opened', !!saveButton, `after ${Date.now() - t0} ms (key derivation + writing + verification)`);
const nameField = waitFor(n => /documentsui/.test(n.pkg) && /\.laibackup$/.test(n.text), 5000, false);
if (nameField) { adb('shell', 'input', 'tap', String(Math.round(nameField.x)), String(Math.round(nameField.y))); adb('shell', 'input', 'keyevent', 'KEYCODE_MOVE_END'); for (let i = 0; i < 40; i++) adb('shell', 'input', 'keyevent', '67'); adb('shell', 'input', 'text', 'e2e-backup.laibackup'); adb('shell', 'input', 'keyevent', '111'); }
tap(n => /documentsui/.test(n.pkg) && /^save$/i.test(n.text), 'Save', 10000, false);
const saved = waitFor(byText(/^Saved "/), 60000, true);
step('backup saved and verified by the app', !!saved, saved?.text.slice(0, 160));

// 3. The file the picker created, for the laptop-side cross-check.
const found = adb('shell', 'ls', '/sdcard/Download/').split(/\r?\n/).filter(f => f.endsWith('.laibackup'));
step('backup file present in Downloads', found.length > 0, found.join(', '));
mkdirSync('verification/runs', { recursive: true });
const local = `verification/runs/e2e-backup-${Date.now()}.laibackup`;
adb('pull', `/sdcard/Download/${found[0]}`, local);
const head = adb('exec-out', 'head', '-c', '16', `/sdcard/Download/${found[0]}`);
step('saved file starts with the format magic', head.startsWith('LOCALAI-BACKUP/1'), local);

// 4. A "new phone": clear the app, restore with a wrong and then the right password.
adb('shell', 'pm', 'clear', PKG);
launch();
tap(byDesc('Privacy and data'), 'Privacy and data');
tap(byDesc('Backup and restore'), 'Backup and restore');
tap(byDesc('Restore tab'), 'Restore tab');
tap(byDesc('Choose backup file'), 'Choose backup file');
tap(n => /documentsui/.test(n.pkg) && n.text === found[0], `pick ${found[0]}`, 30000, true);
type('Restore password', 'wrong password!!');
t0 = Date.now();
tap(byDesc('Check backup'), 'Check backup');
const refused = waitFor(byText(/^Wrong password, or the file was changed or damaged/), 60000, true);
step('wrong password refused, nothing restored', !!refused, `${Date.now() - t0} ms`);
type('Restore password', PASSWORD);
t0 = Date.now();
tap(byDesc('Check backup'), 'Check backup');
step('backup authenticated and checked', !!waitFor(byText(/Authenticated and checked/), 60000, true), `${Date.now() - t0} ms`);
tap(byDesc('Restore selected'), 'Restore selected');
const finished = waitFor(byText(/^Restore finished\./), 60000, true);
step('restore finished', !!finished);
const agents = waitFor(byText(/^Agents \(merge\): added 3/), 5000, true);
step('three agents restored into the fresh app', !!agents, agents?.text);
finish(0);
