// End-to-end test: loads the extension into Chromium, points controlcenter-p2.synxis.com
// at the local mock server, and runs the real download flow.
//
//   node dev-test/e2e.mjs [path/to/chrome]
//
// Needs: openssl, Node 22+ (global WebSocket), root or permission to listen on :443.

import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(here, '../synxis-forecast-downloader');
const CHROME = process.argv[2] || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const HOST = 'controlcenter-p2.synxis.com';
const PORT = 9333;

const work = fs.mkdtempSync(path.join(process.env.TEST_TMP || os.tmpdir(), 'synxis-e2e-'));
const profile = path.join(work, 'profile');
const downloads = path.join(work, 'downloads');
fs.mkdirSync(path.join(profile, 'Default'), { recursive: true });
fs.mkdirSync(downloads);
fs.writeFileSync(
  path.join(profile, 'Default', 'Preferences'),
  JSON.stringify({ download: { default_directory: downloads, prompt_for_download: false } }),
);

const cert = path.join(work, 'cert.pem');
const key = path.join(work, 'key.pem');
execFileSync('openssl', [
  'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-subj', `/CN=${HOST}`,
  '-addext', `subjectAltName=DNS:${HOST}`, '-keyout', key, '-out', cert,
], { stdio: 'ignore' });

const procs = [];
const cleanup = () => procs.forEach((p) => p.kill('SIGKILL'));
process.on('exit', cleanup);

const mockLog = [];
const mock = spawn(process.execPath, [path.join(here, 'mock-synxis/server.mjs'), cert, key, '443']);
procs.push(mock);
mock.stdout.on('data', (d) => mockLog.push(...String(d).trim().split('\n')));
mock.stderr.on('data', (d) => process.stderr.write(d));

const chrome = spawn(CHROME, [
  '--headless=new', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--no-sandbox',
  `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`,
  `--host-resolver-rules=MAP ${HOST} 127.0.0.1`, '--ignore-certificate-errors', '--no-proxy-server',
  `--remote-debugging-port=${PORT}`, '--window-size=1440,900', 'about:blank',
]);
procs.push(chrome);
chrome.stderr.on('data', () => {});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- tiny CDP client ----------
let ws;
let msgId = 0;
const pending = new Map();
async function connect() {
  for (let i = 0; i < 50; i++) {
    try {
      const v = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
      ws = new WebSocket(v.webSocketDebuggerUrl);
      await new Promise((res, rej) => ((ws.onopen = res), (ws.onerror = rej)));
      ws.onmessage = (ev) => {
        const m = JSON.parse(ev.data);
        if (m.id && pending.has(m.id)) {
          const { res, rej } = pending.get(m.id);
          pending.delete(m.id);
          m.error ? rej(new Error(m.error.message)) : res(m.result);
        }
      };
      return;
    } catch (e) {
      await sleep(200);
    }
  }
  throw new Error('Chrome did not start');
}
function send(method, params = {}, sessionId) {
  const id = ++msgId;
  ws.send(JSON.stringify({ id, method, params, sessionId }));
  return new Promise((res, rej) => pending.set(id, { res, rej }));
}
async function evaluate(sessionId, expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
}
async function openPage(url) {
  const { targetId } = await send('Target.createTarget', { url });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Page.enable', {}, sessionId);
  await sleep(800);
  return { targetId, sessionId };
}
const closePage = (p) => send('Target.closeTarget', { targetId: p.targetId });
const pageTargets = async () => (await send('Target.getTargets')).targetInfos.filter((t) => t.type === 'page');

// ---------- helpers ----------
let extId;
let ui; // an extension page used to read/write chrome.storage
const storage = (keys) => evaluate(ui.sessionId, `chrome.storage.local.get(${JSON.stringify(keys)})`);
const setSettings = (patch) =>
  evaluate(
    ui.sessionId,
    `chrome.storage.local.get('settings').then(({settings}) => chrome.storage.local.set({settings: {...(settings||{}), ...${JSON.stringify(patch)}}}))`,
  );
const setCookie = (name, value) =>
  send('Storage.setCookies', { cookies: [{ name, value, domain: HOST, path: '/', secure: true }] });

async function waitForRunEnd(since, timeoutMs = 300000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const { runStatus, lastRun } = await storage(['runStatus', 'lastRun']);
    if (lastRun && lastRun.at > since && !(runStatus && runStatus.running)) return lastRun;
    await sleep(1000);
  }
  console.log(await logsSince(since));
  throw new Error('Run did not finish in time');
}

async function runFromPopup() {
  const since = Date.now();
  const popup = await openPage(`chrome-extension://${extId}/popup.html`);
  await evaluate(popup.sessionId, `document.getElementById('runNow').click()`);
  await sleep(300);
  await closePage(popup);
  return waitForRunEnd(since);
}

const results = [];
function check(name, cond, detail = '') {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

const expectedCsv = (report, range) => {
  const rows = [
    'Report,Range', `${report},${range}`, 'Date,Total Rooms,Rooms Sold,Occupied %,Total Room Revenue,ADR',
    '10/17/2026,52,34,69.39%,"4,339.20",127.62', '10/18/2026,52,8,16.33%,736.99,92.12',
  ];
  return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(rows.join('\r\n') + '\r\n', 'utf16le')]);
};

async function logsSince(t) {
  const { logs = [] } = await storage('logs');
  return logs.filter((l) => l.t >= t).map((l) => `      ${l.level.padEnd(5)} ${l.msg}`).join('\n');
}

// ---------- test ----------
await connect();
for (let i = 0; i < 50 && !extId; i++) {
  const t = (await send('Target.getTargets')).targetInfos.find(
    (x) => x.type === 'service_worker' && x.url.startsWith('chrome-extension://'),
  );
  if (t) extId = new URL(t.url).host;
  else await sleep(200);
}
if (!extId) throw new Error('Extension service worker not found');
console.log(`Extension id: ${extId}\nWork dir: ${work}\n`);
ui = await openPage(`chrome-extension://${extId}/options.html`);

const today = new Date();
const dateKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
const folder = path.join(downloads, 'SynXis Forecast');

// 1. Not logged in -> clear failure
let t0 = Date.now();
let run = await runFromPopup();
check('Not logged in: run fails with a login message', !run.ok && /not logged in/i.test(run.error), run.error);
check('Not logged in: SynXis window closed afterwards', (await pageTargets()).every((p) => !p.url.includes(HOST)));

// 2. Logged in, normal ReportViewer -> CSV saved in folder, bytes untouched
await setCookie('sess', '1');
for (const [mode, file] of [
  ['sys', `Forecast_NextYear_${dateKey}.csv`],
  ['html', `Forecast_NextYear_${dateKey} (1).csv`],
  ['click', `Forecast_NextYear_${dateKey} (2).csv`],
]) {
  await setCookie('rvmode', mode);
  t0 = Date.now();
  run = await runFromPopup();
  const full = path.join(folder, file);
  check(`[${mode}] run succeeds`, run.ok, run.ok ? run.path : run.error);
  check(`[${mode}] saved as ${file}`, fs.existsSync(full));
  check(
    `[${mode}] file is the exact Forecast / Next Year CSV`,
    fs.existsSync(full) && fs.readFileSync(full).equals(expectedCsv('forecast', 'Next Year')),
  );
  check(`[${mode}] SynXis + report windows closed`, (await pageTargets()).every((p) => !p.url.includes(HOST)));
  if (!run.ok) console.log(await logsSince(t0));
}
console.log('\n  Log of last run:\n' + (await logsSince(t0)) + '\n');

// Reports menu that only opens on CSS :hover -> hidden menu links are used
await setCookie('menumode', 'css');
await setCookie('rvmode', 'sys');
t0 = Date.now();
run = await runFromPopup();
check('[css-hover menu] run succeeds', run.ok, run.ok ? run.path : run.error);
check(
  '[css-hover menu] file is the exact Forecast / Next Year CSV',
  run.ok && fs.readFileSync(run.path).equals(expectedCsv('forecast', 'Next Year')),
);
console.log('\n  Log of css-hover run:\n' + (await logsSince(t0)) + '\n');
await setCookie('menumode', 'js');

// 3. Scheduled run through the real alarm, custom folder + overwrite
await setCookie('rvmode', 'sys');
const now = new Date();
const at = new Date(now.getTime() + 60000);
if (at.getHours() < 6) {
  const hhmm = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
  await setSettings({
    scheduleTime: hhmm,
    folder: 'Hotel Reports/Forecast',
    fileNameTemplate: 'Forecast_latest',
    conflictAction: 'overwrite',
  });
  await sleep(1000);
  const { nextRunAt } = await storage('nextRunAt');
  check('Schedule: next run stored for the chosen time', nextRunAt && new Date(nextRunAt).getMinutes() === at.getMinutes(), new Date(nextRunAt).toString());
  console.log(`  waiting for the ${hhmm} alarm…`);
  run = await waitForRunEnd(now.getTime(), 4 * 60000);
  const full = path.join(downloads, 'Hotel Reports', 'Forecast', 'Forecast_latest.csv');
  check('Schedule: alarm started the run by itself', run.trigger === 'scheduled', `trigger=${run.trigger}`);
  check('Schedule: run succeeds', run.ok, run.ok ? run.path : run.error);
  check('Schedule: saved into Hotel Reports/Forecast/Forecast_latest.csv', fs.existsSync(full));
  const { schedState, nextRunAt: next2 } = await storage(['schedState', 'nextRunAt']);
  check('Schedule: today marked done', schedState && schedState.success === true, JSON.stringify(schedState));
  check('Schedule: rescheduled for tomorrow', next2 - nextRunAt >= 23 * 3600e3, new Date(next2).toString());

  // second run with overwrite must replace, not add "(1)"
  fs.writeFileSync(full, 'old');
  run = await runFromPopup();
  check('Overwrite: same file replaced', run.ok && fs.readFileSync(full).equals(expectedCsv('forecast', 'Next Year')));
  check('Overwrite: no "(1)" copy created', fs.readdirSync(path.dirname(full)).length === 1, fs.readdirSync(path.dirname(full)).join(', '));
} else {
  console.log('SKIP  schedule test (local time is past 05:58)');
}

// screenshots of the UI for a visual check
for (const name of ['popup', 'options']) {
  const p = await openPage(`chrome-extension://${extId}/${name}.html`);
  if (name === 'popup') await send('Emulation.setDeviceMetricsOverride', { width: 360, height: 520, deviceScaleFactor: 1, mobile: false }, p.sessionId);
  await sleep(500);
  const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: name === 'options' }, p.sessionId);
  fs.writeFileSync(path.join(work, `${name}.png`), Buffer.from(data, 'base64'));
  await closePage(p);
}
console.log(`\nScreenshots: ${work}/popup.png, ${work}/options.png`);

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
cleanup();
process.exit(failed ? 1 : 0);
