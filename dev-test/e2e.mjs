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

const synxisPages = async () => (await pageTargets()).filter((p) => p.url.includes(HOST));
const reportPages = async () => (await synxisPages()).filter((p) => /reportviewer/i.test(p.url));
const message = (msg) => evaluate(ui.sessionId, `chrome.runtime.sendMessage(${JSON.stringify(msg)})`);
const setCookies = async (obj) => {
  for (const [k, v] of Object.entries(obj)) await setCookie(k, v);
};
const isExpected = (file) => fs.existsSync(file) && fs.readFileSync(file).equals(expectedCsv('forecast', 'Next Year'));

// 1. Not logged in, no SynXis tab open -> clear failure, the tab it opened is closed again
let t0 = Date.now();
let run = await runFromPopup();
check('Not logged in: run fails with a login message', !run.ok && /not logged in/i.test(run.error), run.error);
check('Not logged in: the tab it opened is closed again', (await synxisPages()).length === 0);

// 2. Logged in, no SynXis tab open -> opens one tab (not a window), downloads, closes it
await setCookies({ sess: '1', rvmode: 'sys', menumode: 'js' });
t0 = Date.now();
run = await runFromPopup();
let file = path.join(folder, `Forecast_NextYear_${dateKey}.csv`);
check('[no tab open] run succeeds', run.ok, run.ok ? run.path : run.error);
check('[no tab open] exact Forecast / Next Year CSV saved in Downloads/SynXis Forecast', isExpected(file));
check('[no tab open] opened its own tab', (await logsSince(t0)).includes('No SynXis tab was open'));
check('[no tab open] its tab and the report pop-up are closed', (await synxisPages()).length === 0);

// 3. SynXis tab already open -> the whole run happens in that tab, which stays open
const existing = await openPage(`https://${HOST}/CC/default.aspx`);
const resetExisting = async () => {
  await send('Page.navigate', { url: `https://${HOST}/CC/default.aspx` }, existing.sessionId);
  await sleep(1500);
};
let n = 0;
for (const [label, cookies] of [
  ['html export', { rvmode: 'html', menumode: 'js' }],
  ['click export', { rvmode: 'click' }],
  ['css-hover menu', { rvmode: 'sys', menumode: 'css' }],
  ['closed shadow-DOM menu', { menumode: 'shadow' }],
]) {
  await setCookies(cookies);
  await resetExisting();
  t0 = Date.now();
  run = await runFromPopup();
  file = path.join(folder, `Forecast_NextYear_${dateKey} (${++n}).csv`);
  const pages = await synxisPages();
  const frameSrc = await evaluate(existing.sessionId, `document.getElementById('content').src`).catch(() => '');
  check(`[${label}] run succeeds`, run.ok, run.ok ? run.path : run.error);
  check(`[${label}] exact CSV saved as ${path.basename(file)}`, isExpected(file));
  check(
    `[${label}] ran inside the already-open tab, which stays open`,
    pages.length === 1 && pages[0].targetId === existing.targetId && frameSrc.includes('criteria.aspx?report=forecast') &&
      (await logsSince(t0)).includes('Using the SynXis tab that is already open'),
    pages.map((p) => p.url).join(', '),
  );
  check(`[${label}] report pop-up closed`, (await reportPages()).length === 0);
  if (!run.ok || label.includes('shadow')) console.log(`\n  Log of ${label} run:\n${await logsSince(t0)}\n`);
}

// 4. "Remember from open SynXis tab" saves the Forecast page address (tab is on Forecast now)
const learned = await message({ type: 'learnForecast' });
check('Remember Forecast page: address saved', learned.ok && learned.url.includes('/CC/reports/criteria.aspx?report=forecast'), JSON.stringify(learned));

// 5. "Copy debug info" sees inside the closed shadow root
await resetExisting();
await sleep(1000);
const info = await message({ type: 'debugInfo' });
const top = info.openTabs?.[0]?.frames?.find((f) => f.frameId === 0);
check(
  'Debug info: lists the open tab, shadow roots and the Reports menu item',
  top && top.shadowRoots >= 1 && top.hits.reports.some((h) => h.shadow) && info.logs.length > 0,
  top ? `shadowRoots=${top.shadowRoots}, reports=${JSON.stringify(top.hits.reports.map((h) => h.path))}` : JSON.stringify(info).slice(0, 300),
);
fs.writeFileSync(path.join(work, 'debug-info.json'), JSON.stringify(info, null, 1));

// 6. No usable menu at all -> falls back to the saved Forecast page address
await setCookies({ menumode: 'none' });
await resetExisting();
t0 = Date.now();
run = await runFromPopup();
file = path.join(folder, `Forecast_NextYear_${dateKey} (${++n}).csv`);
check('[no menu] run succeeds using the saved address', run.ok && (await logsSince(t0)).includes('saved Forecast page address'), run.ok ? run.path : run.error);
check('[no menu] exact CSV saved', isExpected(file));
console.log(`\n  Log of no-menu run:\n${await logsSince(t0)}\n`);
await setCookies({ menumode: 'js' });

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
