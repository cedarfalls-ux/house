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

// Clicks "Download Forecast now" on the Settings page.
async function runFromSettings() {
  const since = Date.now();
  await evaluate(ui.sessionId, `document.getElementById('runNow').click()`);
  return waitForRunEnd(since);
}
const setIdle = (state) => evaluate(ui.sessionId, `chrome.storage.local.set({ devIdleOverride: ${JSON.stringify(state)} })`);

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
let run = await runFromSettings();
check('Not logged in: run fails with a login message', !run.ok && /not logged in/i.test(run.error), run.error);
check('Not logged in: the tab it opened is closed again', (await synxisPages()).length === 0);

// 2. Logged in, no SynXis tab open -> opens one tab (not a window), downloads, closes it
await setCookies({ sess: '1', rvmode: 'sys', menumode: 'js', bankpopup: '1' });
t0 = Date.now();
run = await runFromSettings();
let file = path.join(folder, `Forecast_NextYear_${dateKey}.csv`);
check('[no tab open] run succeeds', run.ok, run.ok ? run.path : run.error);
check('[no tab open] exact Forecast / Next Year CSV saved in Downloads/SynXis Forecast', isExpected(file));
check('[no tab open] opened its own tab', (await logsSince(t0)).includes('No SynXis tab was open'));
check('[no tab open] answered NO to the "open a Bank?" pop-up', (await logsSince(t0)).includes('Closed the "open a Bank?" pop-up'));
check('[no tab open] went Reports > SynXis Property Hub (SPH) > Forecast', /Reports menu[\s\S]*SynXis Property Hub \(SPH\)[\s\S]*Clicked: Forecast/.test(await logsSince(t0)));
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
  // Screenshots of the SynXis tab while the first run works, to check what the user sees.
  let shooting = n === 0;
  const shots = (async () => {
    for (let i = 0; shooting; i++) {
      const shot = await send('Page.captureScreenshot', { format: 'png' }, existing.sessionId).catch(() => null);
      if (shot) fs.writeFileSync(path.join(work, `run-${String(i).padStart(2, '0')}.png`), Buffer.from(shot.data, 'base64'));
      await sleep(700);
    }
  })();
  run = await runFromSettings();
  shooting = false;
  await shots;
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
  const runLog = await logsSince(t0);
  check(`[${label}] answered NO to the "open a Bank?" pop-up`, runLog.includes('Closed the "open a Bank?" pop-up'));
  const footerClicked = await evaluate(existing.sessionId, 'window.footerClicked');
  // (A CSS-hover-only menu never opens for scripts; the hidden Forecast link is used there.)
  const sphClicked = label.startsWith('css') || runLog.includes('Clicked: SynXis Property Hub (SPH)');
  check(
    `[${label}] clicked the menu's "SynXis Property Hub (SPH)", never the footer version text, no Home step`,
    sphClicked && footerClicked === false && !runLog.includes('Home'),
    `footerClicked=${footerClicked}`,
  );
  const bannerText = await evaluate(existing.sessionId, `document.getElementById('sfd-banner')?.textContent || ''`);
  check(`[${label}] on-screen banner shows the result`, run.ok ? bannerText.includes('saved') : bannerText.includes('✖'), bannerText);
  if (!run.ok || label.includes('shadow')) console.log(`\n  Log of ${label} run:\n${runLog}\n`);
}

// The toolbar icon has no popup: clicking it opens Settings (downloads start only from the button)
check('Icon click opens Settings, not a download', (await evaluate(ui.sessionId, 'chrome.action.getPopup({})')) === '');

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
run = await runFromSettings();
file = path.join(folder, `Forecast_NextYear_${dateKey} (${++n}).csv`);
check('[no menu] run succeeds using the saved address', run.ok && (await logsSince(t0)).includes('saved Forecast page address'), run.ok ? run.path : run.error);
check('[no menu] exact CSV saved', isExpected(file));
console.log(`\n  Log of no-menu run:\n${await logsSince(t0)}\n`);
await setCookies({ menumode: 'js' });

// 7. Daily download: inside the time window, only after no activity, once a day
await setCookies({ rvmode: 'sys', menumode: 'js' });
await resetExisting();
const pad2 = (x) => String(x).padStart(2, '0');
const nowD = new Date();
if (!(nowD.getHours() === 23 && nowD.getMinutes() > 50)) {
  const end = new Date(Math.min(nowD.getTime() + 3600e3, new Date(nowD).setHours(23, 59, 0, 0)));
  await setSettings({
    windowStart: '00:00',
    windowEnd: `${pad2(end.getHours())}:${pad2(end.getMinutes())}`,
    idleSeconds: 15,
    folder: 'Hotel Reports/Forecast',
    fileNameTemplate: 'Forecast_latest',
    conflictAction: 'overwrite',
  });
  await setIdle('active');
  const before = (await storage('lastRun')).lastRun.at;
  console.log('  someone is "using" the computer for 70 s (no daily download expected)…');
  await sleep(70000);
  check('Daily: does not start while the computer is in use', (await storage('lastRun')).lastRun.at === before);

  const since = Date.now();
  await setIdle('idle'); // nobody touched mouse/keyboard for the set seconds
  run = await waitForRunEnd(since, 4 * 60000);
  const full = path.join(downloads, 'Hotel Reports', 'Forecast', 'Forecast_latest.csv');
  check('Daily: started by itself after inactivity', run.trigger === 'scheduled', `trigger=${run.trigger}`);
  check('Daily: download succeeds into Hotel Reports/Forecast/Forecast_latest.csv', run.ok && isExpected(full), run.ok ? run.path : run.error);
  const { schedState } = await storage('schedState');
  check('Daily: today marked done', schedState && schedState.success === true, JSON.stringify(schedState));
  await setIdle('locked');
  await sleep(8000);
  check('Daily: does not run a second time the same day', (await storage('lastRun')).lastRun.at === run.at);

  // a manual run with "Replace the old file" overwrites instead of adding "(1)"
  fs.writeFileSync(full, 'old');
  run = await runFromSettings();
  check('Overwrite: same file replaced', run.ok && isExpected(full));
  check('Overwrite: no "(1)" copy created', fs.readdirSync(path.dirname(full)).length === 1, fs.readdirSync(path.dirname(full)).join(', '));
} else {
  console.log('SKIP  daily download test (too close to midnight)');
}

// 8. Auto refresh: only the entered address's tab, only after no activity, Bank pop-up -> NO
await setCookies({ bankpopup: '1', sessionpopup: '0' });
await setSettings({
  autoRefreshEnabled: true,
  autoRefreshRules: [{ url: `https://${HOST}/CC/default.aspx`, seconds: 15 }],
  answerPopups: true,
});
await setIdle('idle');
await sleep(1500);
await resetExisting();
const other = await openPage(`https://${HOST}/CC/reports/criteria.aspx?report=forecast`);
const timeOrigin = (p) => evaluate(p.sessionId, 'performance.timeOrigin').catch(() => null);
await send('Target.activateTarget', { targetId: existing.targetId }); // SynXis tab in front, like at the desk
const e1 = await timeOrigin(existing);
const o1 = await timeOrigin(other);
console.log('  moving the mouse on the SynXis tab for 24 s…');
for (let i = 0; i < 8; i++) {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 200 + i * 5, y: 200 }, existing.sessionId);
  await sleep(3000);
}
check('Auto refresh: no refresh while the mouse is moving', (await timeOrigin(existing)) === e1);
check('Auto refresh: Bank pop-up left for the user while they are active', (await evaluate(existing.sessionId, 'window.bankOpen')) === true);
const tR = Date.now();
let e2 = e1;
for (let i = 0; i < 30 && e2 === e1; i++) {
  await sleep(1000);
  e2 = (await timeOrigin(existing)) || e1;
}
check('Auto refresh: refreshed after 15 s without activity', e2 !== e1);
await sleep(4000);
const existingUrl = (await pageTargets()).find((p) => p.targetId === existing.targetId)?.url || '';
check('Auto refresh: stayed on the same page', existingUrl.endsWith('/CC/default.aspx'), existingUrl);
check(
  'Auto refresh: answered NO to the Bank pop-up after the refresh',
  (await evaluate(existing.sessionId, 'window.bankOpen')) === false && (await logsSince(tR)).includes('clicked NO'),
);
check('Auto refresh: another page of the same site (not entered) was not refreshed', (await timeOrigin(other)) === o1);
// SynXis tab behind another tab (its timers run late): the 30-second check still refreshes it
await send('Target.activateTarget', { targetId: other.targetId });
const e3 = await timeOrigin(existing);
let e4 = e3;
for (let i = 0; i < 60 && e4 === e3; i++) {
  await sleep(1000);
  e4 = (await timeOrigin(existing)) || e3;
}
check('Auto refresh: also works while the tab is in the background', e4 !== e3);
await closePage(other);

// "Your session is about to expire" -> KEEP SESSION ACTIVE
await setIdle('active'); // no refreshes during this check
await setCookies({ bankpopup: '0', sessionpopup: '1' });
await resetExisting();
const tS = Date.now();
await sleep(7000);
check(
  'Session pop-up: clicked KEEP SESSION ACTIVE',
  (await evaluate(existing.sessionId, 'window.keptAlive')) === true && (await logsSince(tS)).includes('KEEP SESSION ACTIVE'),
);
await setSettings({ autoRefreshEnabled: false });
await setCookies({ sessionpopup: '0' });
await evaluate(ui.sessionId, `chrome.storage.local.remove('devIdleOverride')`);

// screenshots of the UI for a visual check
for (const name of ['options']) {
  const p = await openPage(`chrome-extension://${extId}/${name}.html`);
  await sleep(800);
  const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: name === 'options' }, p.sessionId);
  fs.writeFileSync(path.join(work, `${name}.png`), Buffer.from(data, 'base64'));
  await closePage(p);
}
console.log(`\nScreenshot: ${work}/options.png`);

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
cleanup();
process.exit(failed ? 1 : 0);
