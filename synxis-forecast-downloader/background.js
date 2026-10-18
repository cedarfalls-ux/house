import { getSettings, saveSettings, buildTargetPath, localDateKey, nextScheduledRun, dueTrigger } from './common.js';
import { pageAgent, mainWorldViewerInfo } from './page-agent.js';

const ALARM_DAILY = 'daily-run';
const ALARM_WATCHDOG = 'watchdog';
const ALARM_STARTUP = 'startup-check';
const ALARM_KEEPALIVE = 'keep-alive';

const OVERALL_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_LOGS = 300;

let currentRun = null; // Promise of the run in progress
let currentCtx = null;

class LoginRequiredError extends Error {
  constructor(detail) {
    super(
      'SynXis is not logged in' +
        (detail ? ` (${detail})` : '') +
        '. Open SynXis in this Chrome profile, log in, and leave it logged in.',
    );
    this.name = 'LoginRequiredError';
  }
}

// ---------------------------------------------------------------- logging

let logChain = Promise.resolve();
function log(level, msg) {
  (level === 'error' ? console.error : console.log)('[SynXis Forecast]', msg);
  logChain = logChain
    .then(async () => {
      const { logs = [] } = await chrome.storage.local.get('logs');
      logs.push({ t: Date.now(), level, msg });
      if (logs.length > MAX_LOGS) logs.splice(0, logs.length - MAX_LOGS);
      await chrome.storage.local.set({ logs });
    })
    .catch(() => {});
  return logChain;
}

async function setRunStatus(patch) {
  const { runStatus = {} } = await chrome.storage.local.get('runStatus');
  await chrome.storage.local.set({ runStatus: { ...runStatus, ...patch } });
}

async function step(ctx, text) {
  checkAbort(ctx);
  ctx.stepNo = (ctx.stepNo || 0) + 1;
  log('info', text);
  await setRunStatus({ step: text });
  ctx.bannerText = `Step ${ctx.stepNo}: ${text}…`;
  await showBanner(ctx, ctx.bannerText);
}

// Status banner on the SynXis page(s) so the user can follow along.
async function showBanner(ctx, text, state = 'run', hideAfterMs = 0) {
  const tabIds = [ctx.mainTabId, ...(ctx.reportTabIds || [])].filter(Boolean);
  for (const tabId of tabIds) {
    await chrome.scripting
      .executeScript({ target: { tabId, frameIds: [0] }, func: pageAgent, args: ['banner', { text, state, hideAfterMs }] })
      .catch(() => {});
  }
}

function setBadge(text, color) {
  chrome.action.setBadgeText({ text }).catch(() => {});
  if (color) chrome.action.setBadgeBackgroundColor({ color }).catch(() => {});
}

function notify(title, message) {
  getSettings().then((s) => {
    if (!s.notifications) return;
    chrome.notifications
      .create({ type: 'basic', iconUrl: 'icons/icon128.png', title, message, priority: 1 })
      .catch(() => {});
  });
}

// ---------------------------------------------------------------- small utils

function checkAbort(ctx) {
  if (ctx && ctx.aborted) throw new Error(ctx.aborted);
}

async function sleep(ctx, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    checkAbort(ctx);
    await new Promise((r) => setTimeout(r, Math.min(500, end - Date.now())));
  }
  checkAbort(ctx);
}

async function runAgent(tabId, cmd, args = {}, frameIds) {
  const target = frameIds ? { tabId, frameIds } : { tabId, allFrames: true };
  const results = await chrome.scripting.executeScript({ target, func: pageAgent, args: [cmd, args] });
  return results.filter((r) => r && r.result).map((r) => ({ frameId: r.frameId, ...r.result }));
}

// Same as runAgent but never throws (frames come and go while pages load).
async function safeAgent(tabId, cmd, args) {
  try {
    return await runAgent(tabId, cmd, args);
  } catch (e) {
    if (/No tab with id|tab was closed/i.test(String(e && e.message))) throw new Error('The SynXis window was closed');
    return [];
  }
}

async function viewerInfo(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: mainWorldViewerInfo,
      world: 'MAIN',
    });
    return results.filter((r) => r && r.result && r.result.found).map((r) => ({ frameId: r.frameId, ...r.result }));
  } catch (e) {
    return [];
  }
}

async function waitForTabComplete(ctx, tabId, timeoutMs) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    checkAbort(ctx);
    let tab;
    try {
      tab = await chrome.tabs.get(tabId);
    } catch (e) {
      throw new Error('The SynXis window was closed');
    }
    if (tab.status === 'complete') return tab;
    await sleep(ctx, 500);
  }
  log('warn', 'Page is still loading, continuing anyway');
  return chrome.tabs.get(tabId);
}

async function assertOnSite(ctx, tabId) {
  const tab = await chrome.tabs.get(tabId).catch(() => {
    throw new Error('The SynXis window was closed');
  });
  const url = tab.url || tab.pendingUrl;
  // No URL means Chrome hid it from us: the tab is on a non-SynXis site (SSO login page).
  if (!url) throw new LoginRequiredError('redirected away from SynXis');
  const u = new URL(url);
  if (!u.hostname.endsWith('synxis.com')) throw new LoginRequiredError(`redirected to ${u.hostname}`);
  if (/login|logon|signin|sign-in|logout/i.test(u.pathname)) throw new LoginRequiredError('login page shown');
}

// ---------------------------------------------------------------- run flow

async function allowPopupsFor(origin) {
  const primaryPattern = `${origin}/*`;
  for (const type of ['popups', 'automaticDownloads']) {
    try {
      await chrome.contentSettings[type].set({ primaryPattern, setting: 'allow' });
    } catch (e) {
      log('warn', `Could not allow ${type} for ${origin}: ${e.message}`);
    }
  }
}

// Uses the SynXis tab the user already has open; opens one only if there is none.
async function findSynxisTab(origin) {
  const tabs = await chrome.tabs.query({ url: `${origin}/*` });
  const candidates = [];
  for (const t of tabs) {
    if (/reportviewer/i.test(t.url || '')) continue;
    const win = await chrome.windows.get(t.windowId).catch(() => null);
    if (win && win.type === 'normal') candidates.push({ t, win });
  }
  const score = ({ t, win }) => (t.active && win.focused ? 4e15 : 0) + (t.active ? 2e15 : 0) + (t.lastAccessed || 0);
  candidates.sort((a, b) => score(b) - score(a));
  return candidates.length ? candidates[0] : null;
}

async function prepareTab(ctx) {
  const found = await findSynxisTab(ctx.origin);
  if (found) {
    const { t: tab, win } = found;
    ctx.mainTabId = tab.id;
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows
      .update(win.id, win.state === 'minimized' ? { state: 'normal', focused: true } : { focused: true })
      .catch(() => {});
    log('info', 'Using the SynXis tab that is already open');
    await waitForTabComplete(ctx, tab.id, 30000);
    return;
  }

  ctx.freshPage = true;
  const win = await chrome.windows.getLastFocused({ windowTypes: ['normal'] }).catch(() => null);
  if (win) {
    const tab = await chrome.tabs.create({ windowId: win.id, url: ctx.settings.startUrl, active: true });
    await chrome.windows.update(win.id, { focused: true }).catch(() => {});
    ctx.mainTabId = tab.id;
    ctx.createdTabId = tab.id;
  } else {
    // Chrome is running in the background with no window open.
    const w = await chrome.windows.create({
      url: ctx.settings.startUrl,
      type: 'normal',
      focused: true,
      width: 1440,
      height: 900,
    });
    ctx.mainTabId = w.tabs[0].id;
    ctx.createdWindowId = w.id;
  }
  log('info', 'No SynXis tab was open, opened a new one');
  await waitForTabComplete(ctx, ctx.mainTabId, 60000);
}

async function navigate(ctx, url) {
  await chrome.tabs.update(ctx.mainTabId, { url });
  await sleep(ctx, 1000);
  await waitForTabComplete(ctx, ctx.mainTabId, 60000);
  await assertOnSite(ctx, ctx.mainTabId);
}

async function actIn(ctx, frame, args) {
  try {
    const [res] = await runAgent(ctx.mainTabId, 'act', args, [frame.frameId]);
    // No answer usually means the click/selection reloaded the page.
    return res || { ok: false, reloaded: true, error: 'the page reloaded' };
  } catch (e) {
    return { ok: false, reloaded: true, error: e.message };
  }
}

// Looks at every frame of the SynXis tab. Stops on a login page and answers NO
// to the "You do not have a Bank open" pop-up whenever it shows up.
async function scanTab(ctx, opts = {}) {
  const tabId = ctx.mainTabId;
  await assertOnSite(ctx, tabId);
  if (ctx.bannerText) {
    // Put the status banner back after a page reload.
    await chrome.scripting
      .executeScript({ target: { tabId, frameIds: [0] }, func: pageAgent, args: ['banner', { text: ctx.bannerText }] })
      .catch(() => {});
  }
  const args = { range: ctx.settings.dateRange, ...opts };
  let frames = await safeAgent(tabId, 'scan', args);
  if (frames.some((f) => f.loginForm)) throw new LoginRequiredError('login form shown');
  const bank = frames.find((f) => f.bankPopup);
  if (bank) {
    const res = await actIn(ctx, bank, { action: 'dismissBank' });
    log(res.ok ? 'info' : 'warn', res.ok ? 'Closed the "open a Bank?" pop-up (clicked NO)' : res.error);
    await sleep(ctx, 1500);
    frames = await safeAgent(tabId, 'scan', args);
  }
  return frames;
}

// The Forecast page: a visible Date Range dropdown and a Generate Report button.
const isCriteria = (frames) => frames.some((f) => f.rangeSelect) && frames.some((f) => f.generateBtn);

async function waitForCriteria(ctx, timeoutMs) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (isCriteria(await scanTab(ctx))) return true;
    await sleep(ctx, 1000);
  }
  return false;
}

// Home > SPH Dashboard, which makes the Reports menu open on the SPH reports.
async function openSphDashboard(ctx) {
  const start = Date.now();
  let homeTries = 0;
  let idle = 0;
  while (Date.now() - start < 30000) {
    const frames = await scanTab(ctx);
    if (isCriteria(frames)) return 'criteria';
    const dash = frames.find((f) => f.sphDashboard);
    if (dash) {
      const res = await actIn(ctx, dash, { action: 'clickSphDashboard' });
      if (res.ok || res.reloaded) {
        log('info', 'Clicked: SPH Dashboard');
        await sleep(ctx, 1500);
        await waitForTabComplete(ctx, ctx.mainTabId, 60000);
        await sleep(ctx, 1500);
        return 'done';
      }
    }
    const home = frames.find((f) => f.homeNav);
    if (home && homeTries < 3) {
      const click = homeTries % 2 === 1; // hover first, then click
      const res = await actIn(ctx, home, { action: 'openHome', click });
      if (res.ok) log('info', `Clicked: Home menu (${click ? 'click' : 'hover'})`);
      homeTries++;
      await sleep(ctx, 1500);
      continue;
    }
    if (++idle >= 3) break;
    await sleep(ctx, 1500);
  }
  log('warn', '"SPH Dashboard" was not found under Home, continuing with Reports');
  return 'skipped';
}

// Clicks through Reports > SynXis Property Hub (SPH) > Forecast on the current
// page. Returns true once the Forecast page is showing.
async function tryMenu(ctx, maxMs) {
  const start = Date.now();
  const counts = { reports: 0, sph: 0, forecast: 0 };
  let allowHidden = false;
  let idle = 0;

  while (Date.now() - start < maxMs) {
    checkAbort(ctx);
    const frames = await scanTab(ctx, { allowHidden });
    if (isCriteria(frames)) return true;

    const pick = (key) => frames.find((f) => f[key]);
    let acted = null;
    if (pick('forecastStrong')) {
      acted = { frame: pick('forecastStrong'), action: 'clickForecast', strongOnly: true, label: 'Forecast' };
    } else if (pick('sphLink') && counts.sph < 3) {
      acted = { frame: pick('sphLink'), action: 'clickSPH', label: 'SynXis Property Hub (SPH)' };
      counts.sph++;
    } else if (pick('forecastWeak') && counts.forecast < 3) {
      acted = { frame: pick('forecastWeak'), action: 'clickForecast', label: 'Forecast' };
      counts.forecast++;
    } else if (pick('reportsNav') && counts.reports < 4) {
      const click = counts.reports % 2 === 1; // hover first, then click
      acted = { frame: pick('reportsNav'), action: 'openReports', click, label: `Reports menu (${click ? 'click' : 'hover'})` };
      counts.reports++;
    }

    if (!acted) {
      idle++;
      if (idle >= 3 && !allowHidden) {
        allowHidden = true;
        counts.sph = 0;
        counts.forecast = 0;
        log('warn', 'Menu items are not visible, trying the hidden menu links');
      } else if (allowHidden && idle >= 7 && Date.now() - start > 20000) {
        return false; // nothing left to click on this page
      }
      await sleep(ctx, 1500);
      continue;
    }
    idle = 0;

    const res = await actIn(ctx, acted.frame, {
      action: acted.action,
      click: acted.click,
      strongOnly: acted.strongOnly,
      allowHidden,
    });
    if (res.ok || res.reloaded) log('info', `Clicked: ${acted.label}`);
    else log('warn', `Could not click ${acted.label}: ${res.error}`);

    if (acted.action === 'clickForecast') {
      // Give the report page time to load before trying anything else.
      if (await waitForCriteria(ctx, 15000)) return true;
    } else {
      await sleep(ctx, 1200);
    }
  }
  return false;
}

async function openForecastCriteria(ctx) {
  if (isCriteria(await scanTab(ctx))) {
    log('info', 'The Forecast report page is already open');
    return;
  }
  if (ctx.settings.openSphDashboard) {
    await step(ctx, 'Home > SPH Dashboard');
    if ((await openSphDashboard(ctx)) === 'criteria') return;
  }
  await step(ctx, 'Reports > SynXis Property Hub (SPH) > Forecast');
  if (await tryMenu(ctx, 60000)) return;
  if (!ctx.freshPage) {
    log('warn', 'Reports menu not found on the current page, opening the SynXis home page');
    await navigate(ctx, ctx.settings.startUrl);
    if (await tryMenu(ctx, 60000)) return;
  }
  if (ctx.settings.forecastUrl) {
    log('info', 'Opening the saved Forecast page address');
    await navigate(ctx, ctx.settings.forecastUrl);
    if (await waitForCriteria(ctx, 30000)) return;
  }
  throw new Error(
    'Could not open the Forecast report page (Reports > SynXis Property Hub > Forecast not found). ' +
      'In Settings use "Copy debug info" and send it, or save the Forecast page address.',
  );
}

async function selectDateRange(ctx) {
  const range = ctx.settings.dateRange;
  for (let i = 0; i < 5; i++) {
    const frames = await scanTab(ctx);
    const crit = frames.find((f) => f.rangeSelect && f.rangeLabelled) || frames.find((f) => f.rangeSelect);
    if (!crit) {
      await sleep(ctx, 1500);
      continue;
    }
    if ((crit.rangeSelected || '').toLowerCase() === range.toLowerCase()) {
      log('info', `Date Range is set to "${crit.rangeSelected}"`);
      await sleep(ctx, 800);
      return;
    }
    const res = await actIn(ctx, crit, { action: 'selectRange', range });
    if (!res.ok && !res.reloaded) throw new Error(`${res.error}. Available: ${(crit.rangeOptions || []).join(', ')}`);
    await sleep(ctx, 2500); // a post-back may reload the page; the next loop checks the value
  }
  throw new Error(`Could not set Date Range to "${range}"`);
}

async function generateReport(ctx) {
  const tabId = ctx.mainTabId;
  let gen = null;
  const end = Date.now() + 20000;
  while (!gen && Date.now() < end) {
    gen = (await scanTab(ctx)).find((f) => f.generateBtn);
    if (!gen) await sleep(ctx, 1000);
  }
  if (!gen) throw new Error('"Generate Report" button not found on the Forecast page');

  const before = new Set((await chrome.tabs.query({})).map((t) => t.id));
  const res = await actIn(ctx, gen, { action: 'clickGenerate' });
  if (!res.ok && !res.reloaded) throw new Error(res.error);
  log('info', 'Clicked: Generate Report');

  const deadline = Date.now() + 60000;
  for (let i = 0; Date.now() < deadline; i++) {
    await sleep(ctx, 1000);
    const tabs = await chrome.tabs.query({});
    const popup = tabs.find(
      (t) =>
        !before.has(t.id) &&
        (t.openerTabId === tabId || /synxis\.com\/.*reportviewer/i.test(t.url || t.pendingUrl || '')),
    );
    if (popup) {
      ctx.reportTabIds.add(popup.id);
      return popup.id;
    }
    const main = await chrome.tabs.get(tabId);
    if (/reportviewer/i.test(main.url || '')) return tabId;
    if (i % 3 === 2 && (await safeAgent(tabId, 'reportScan')).some((f) => f.reportTitle)) return tabId;
  }
  throw new Error('The report window did not open (check that pop-ups are allowed for SynXis)');
}

async function waitForReport(ctx, tabId) {
  await waitForTabComplete(ctx, tabId, 90000);
  const deadline = Date.now() + ctx.settings.reportTimeoutSec * 1000;
  let stable = 0;
  while (Date.now() < deadline) {
    checkAbort(ctx);
    const viewers = await viewerInfo(tabId);
    const scans = await safeAgent(tabId, 'reportScan');
    const v = viewers[0];

    const err = scans.find((f) => f.errorText);
    if (err) throw new Error(`Report error: ${err.errorText}`);
    if (scans.some((f) => f.loginForm)) throw new LoginRequiredError('login form shown in report window');

    if (v && v.loading === false && v.exportUrlBase) {
      return { frameId: v.frameId, frameUrl: v.frameUrl, exportUrlBase: v.exportUrlBase };
    }
    const ready = scans.find(
      (f) => (f.reportTitle || (v && v.loading === false && f.csvLink)) && !f.loadingVisible,
    );
    if (ready && (!v || v.loading !== true)) {
      if (++stable >= 2) {
        const withUrl = scans.find((f) => f.exportUrlFromHtml);
        return {
          frameId: v ? v.frameId : (withUrl || ready).frameId,
          frameUrl: v ? v.frameUrl : (withUrl || ready).url,
          exportUrlBase: (v && v.exportUrlBase) || (withUrl && withUrl.exportUrlFromHtml) || null,
          csvFrameId: (scans.find((f) => f.csvLink) || {}).frameId,
        };
      }
    } else {
      stable = 0;
    }
    await sleep(ctx, 1500);
  }
  throw new Error(`Report did not finish loading within ${ctx.settings.reportTimeoutSec} seconds`);
}

async function waitForDownload(ctx, id, timeoutMs = 120000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const [item] = await chrome.downloads.search({ id });
    if (!item) throw new Error('Download disappeared');
    if (item.state === 'complete') return item;
    if (item.state === 'interrupted') throw new Error(`Download failed: ${item.error || 'interrupted'}`);
    await sleep(ctx, 500);
  }
  throw new Error('Download did not finish in time');
}

function csvExportUrl(base, frameUrl) {
  const full = /Format=$/i.test(base) ? `${base}CSV` : `${base}${base.includes('?') ? '&' : '?'}Format=CSV`;
  return new URL(full, frameUrl).href;
}

// Last resort: click "CSV (comma delimited)" like a user would and rename the
// file Chrome downloads into the chosen folder.
async function exportByClick(ctx, tabId, frameId, target) {
  let downloadId = null;
  const listener = (item, suggest) => {
    const url = `${item.finalUrl || ''} ${item.url || ''}`;
    if (downloadId == null && /synxis\.com/i.test(url) && !item.byExtensionId) {
      downloadId = item.id;
      suggest({
        filename: target,
        conflictAction: ctx.settings.conflictAction === 'overwrite' ? 'overwrite' : 'uniquify',
      });
    } else {
      suggest();
    }
  };
  chrome.downloads.onDeterminingFilename.addListener(listener);
  try {
    const [res] = await runAgent(tabId, 'clickCsv', {}, frameId != null ? [frameId] : undefined);
    if (!res || !res.ok) throw new Error((res && res.error) || 'CSV export link not found');
    const end = Date.now() + 60000;
    while (downloadId == null && Date.now() < end) {
      await chrome.downloads.search({ limit: 1 }); // keeps the worker awake
      await sleep(ctx, 500);
    }
    if (downloadId == null) throw new Error('CSV download did not start');
    return await waitForDownload(ctx, downloadId);
  } finally {
    chrome.downloads.onDeterminingFilename.removeListener(listener);
  }
}

async function exportCsv(ctx, tabId, viewer) {
  const target = buildTargetPath(ctx.settings, new Date());
  const conflictAction = ctx.settings.conflictAction === 'overwrite' ? 'overwrite' : 'uniquify';

  if (viewer.exportUrlBase) {
    const url = csvExportUrl(viewer.exportUrlBase, viewer.frameUrl);
    const [res] = await runAgent(tabId, 'fetchExport', { url }, [viewer.frameId]);
    if (res && res.ok) {
      log('info', `CSV received: ${res.lines} lines, ${res.size} bytes (${res.encoding})`);
      const id = await chrome.downloads.download({
        url: `data:text/csv;base64,${res.b64}`,
        filename: target,
        conflictAction,
        saveAs: false,
      });
      const item = await waitForDownload(ctx, id);
      return { path: item.filename, downloadId: id, lines: res.lines };
    }
    const why = res ? res.error : 'no answer from report window';
    if (res && /web page instead/.test(why)) throw new LoginRequiredError('export returned a web page');
    log('warn', `Direct CSV export failed (${why}), trying Chrome download`);
    try {
      const id = await chrome.downloads.download({ url, filename: target, conflictAction, saveAs: false });
      const item = await waitForDownload(ctx, id);
      return { path: item.filename, downloadId: id };
    } catch (e) {
      log('warn', `Chrome download failed (${e.message}), trying the CSV menu item`);
    }
  } else {
    log('warn', 'Export address not found, using the CSV menu item');
  }
  const item = await exportByClick(ctx, tabId, viewer.csvFrameId, target);
  return { path: item.filename, downloadId: item.id };
}

async function doRun(ctx) {
  const { settings } = ctx;
  await allowPopupsFor(ctx.origin);

  log('info', 'Opening SynXis Control Center');
  await prepareTab(ctx);
  await assertOnSite(ctx, ctx.mainTabId);

  await openForecastCriteria(ctx);

  await step(ctx, `Date Range > ${settings.dateRange}`);
  await selectDateRange(ctx);

  await step(ctx, 'Generate Report');
  const reportTabId = await generateReport(ctx);

  await step(ctx, 'Waiting for the report to load');
  const viewer = await waitForReport(ctx, reportTabId);

  await step(ctx, 'Export > CSV (comma delimited)');
  await chrome.scripting
    .executeScript({ target: { tabId: reportTabId, allFrames: true }, func: pageAgent, args: ['act', { action: 'showExport' }] })
    .catch(() => {});
  return exportCsv(ctx, reportTabId, viewer);
}

async function recordAttempt(update) {
  const today = localDateKey();
  const { schedState = {} } = await chrome.storage.local.get('schedState');
  const st = schedState.date === today ? schedState : { date: today, attempts: 0, success: false };
  await chrome.storage.local.set({ schedState: { ...st, ...update(st) } });
}

async function runFlow(trigger) {
  const settings = await getSettings();
  const ctx = {
    trigger,
    settings,
    origin: new URL(settings.startUrl).origin,
    reportTabIds: new Set(),
    startedAt: Date.now(),
    aborted: null,
  };
  currentCtx = ctx;
  const scheduled = trigger !== 'manual';
  if (scheduled) await recordAttempt((st) => ({ attempts: st.attempts + 1, lastAttemptAt: Date.now() }));

  await chrome.storage.local.set({
    runStatus: { running: true, trigger, startedAt: ctx.startedAt, step: 'Starting' },
  });
  setBadge('RUN', '#0f7c8c');
  log('info', `Run started (${trigger}), Date Range: ${settings.dateRange}`);

  const timer = setTimeout(() => (ctx.aborted = 'Run took too long and was stopped'), OVERALL_TIMEOUT_MS);
  let failed = false;
  try {
    const saved = await doRun(ctx);
    const lastRun = { ok: true, at: Date.now(), trigger, ...saved };
    await chrome.storage.local.set({ lastRun, lastSuccess: lastRun });
    if (scheduled) await recordAttempt(() => ({ success: true }));
    log('info', `Saved: ${saved.path}`);
    await showBanner({ mainTabId: ctx.mainTabId }, `✔ Forecast CSV saved: ${saved.path}`, 'ok', 12000);
    setBadge('', null);
    notify('Forecast report downloaded', saved.path);
  } catch (err) {
    failed = true;
    const message = (err && err.message) || String(err);
    await chrome.storage.local.set({ lastRun: { ok: false, at: Date.now(), trigger, error: message } });
    log('error', `Run failed: ${message}`);
    await showBanner(ctx, `✖ ${message}`, 'err', 30000);
    setBadge('!', '#d93025');
    notify('Forecast download failed', message);
    const tabs = await collectDiagnostic([ctx.mainTabId, ...ctx.reportTabIds].filter(Boolean));
    await chrome.storage.local.set({ lastDiagnostic: { at: Date.now(), error: message, tabs } });
  } finally {
    clearTimeout(timer);
    // Close only what this run opened: the report pop-up and a tab/window it created.
    if (!(failed && settings.keepWindowOnFailure)) {
      for (const id of ctx.reportTabIds) if (id !== ctx.mainTabId) await chrome.tabs.remove(id).catch(() => {});
      if (ctx.createdWindowId) await chrome.windows.remove(ctx.createdWindowId).catch(() => {});
      else if (ctx.createdTabId) await chrome.tabs.remove(ctx.createdTabId).catch(() => {});
    }
    currentCtx = null;
    await setRunStatus({ running: false, step: failed ? 'Failed' : 'Done', finishedAt: Date.now() });
  }
}

function startRun(trigger) {
  if (currentRun) return { started: false, reason: 'A download is already running.' };
  currentRun = runFlow(trigger).finally(() => {
    currentRun = null;
  });
  return { started: true };
}

// ---------------------------------------------------------------- troubleshooting

async function collectDiagnostic(tabIds) {
  const out = [];
  for (const tabId of tabIds) {
    try {
      const tab = await chrome.tabs.get(tabId);
      const res = await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        func: pageAgent,
        args: ['diagnose', {}],
      });
      out.push({ tabUrl: tab.url, frames: res.map((r) => ({ frameId: r.frameId, ...r.result })) });
    } catch (e) {
      out.push({ tabId, error: e.message });
    }
  }
  return out;
}

async function debugInfo() {
  const s = await getSettings();
  const tabs = await chrome.tabs.query({ url: `${new URL(s.startUrl).origin}/*` });
  const { logs = [], lastDiagnostic, lastRun } = await chrome.storage.local.get(['logs', 'lastDiagnostic', 'lastRun']);
  return {
    at: new Date().toString(),
    version: chrome.runtime.getManifest().version,
    userAgent: navigator.userAgent,
    settings: s,
    lastRun,
    openTabs: await collectDiagnostic(tabs.map((t) => t.id)),
    lastDiagnostic,
    logs: logs.slice(-80).map((l) => `${new Date(l.t).toLocaleString()} [${l.level}] ${l.msg}`),
  };
}

// Remembers the address of the Forecast page the user has open, as a backup
// for when the menu cannot be clicked.
async function learnForecastUrl() {
  const s = await getSettings();
  const tabs = await chrome.tabs.query({ url: `${new URL(s.startUrl).origin}/*` });
  for (const t of tabs) {
    const frames = await runAgent(t.id, 'scan', { range: s.dateRange }).catch(() => []);
    if (!isCriteria(frames)) continue;
    const crit = frames.find((f) => f.rangeSelect && f.rangeLabelled) || frames.find((f) => f.rangeSelect);
    const strip = (u) => u.split('#')[0];
    if (strip(crit.url) === strip(s.startUrl) && !crit.url.includes('#')) {
      return {
        ok: false,
        error: 'This Forecast page has the same address as the SynXis home page, so it cannot be opened directly. The menu will be used.',
      };
    }
    await saveSettings({ forecastUrl: crit.url });
    log('info', `Saved Forecast page address: ${crit.url}`);
    return { ok: true, url: crit.url };
  }
  return { ok: false, error: 'Open the Forecast report page in SynXis first (the page with the Date Range dropdown).' };
}

// ---------------------------------------------------------------- schedule

async function ensureAlarms() {
  const s = await getSettings();
  await chrome.alarms.clear(ALARM_DAILY);
  if (s.scheduleEnabled) {
    const next = nextScheduledRun(s);
    await chrome.alarms.create(ALARM_DAILY, { when: next.getTime() });
    if (!(await chrome.alarms.get(ALARM_WATCHDOG))) {
      await chrome.alarms.create(ALARM_WATCHDOG, { periodInMinutes: 5 });
    }
    await chrome.storage.local.set({ nextRunAt: next.getTime() });
  } else {
    await chrome.alarms.clear(ALARM_WATCHDOG);
    await chrome.storage.local.set({ nextRunAt: null });
  }
  if (s.keepSessionAlive) {
    if (!(await chrome.alarms.get(ALARM_KEEPALIVE))) {
      await chrome.alarms.create(ALARM_KEEPALIVE, { periodInMinutes: 10 });
    }
  } else {
    await chrome.alarms.clear(ALARM_KEEPALIVE);
  }
}

async function checkDue(source) {
  if (currentRun) return;
  const s = await getSettings();
  const { schedState } = await chrome.storage.local.get('schedState');
  const trigger = dueTrigger(s, schedState);
  if (!trigger) return;
  log('info', `Scheduled run is due (${source})`);
  startRun(trigger);
}

async function keepSessionAlive() {
  const s = await getSettings();
  if (!s.keepSessionAlive || currentRun) return;
  try {
    const res = await fetch(s.startUrl, { credentials: 'include', cache: 'no-store' });
    const u = new URL(res.url);
    const loggedOut =
      u.origin !== new URL(s.startUrl).origin || /login|logon|signin|sign-in/i.test(u.pathname);
    await chrome.storage.local.set({ keepAlive: { at: Date.now(), ok: res.ok && !loggedOut } });
    if (loggedOut) log('warn', 'Keep-alive: SynXis looks logged out. Please log in again.');
  } catch (e) {
    await chrome.storage.local.set({ keepAlive: { at: Date.now(), ok: false } });
  }
}

// ---------------------------------------------------------------- events

chrome.runtime.onInstalled.addListener(async () => {
  const s = await getSettings();
  await allowPopupsFor(new URL(s.startUrl).origin);
  await ensureAlarms();
});

chrome.runtime.onStartup.addListener(async () => {
  await ensureAlarms();
  // Give Chrome and the network a minute before a catch-up run.
  await chrome.alarms.create(ALARM_STARTUP, { when: Date.now() + 60000 });
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === ALARM_DAILY) {
    await checkDue('daily alarm');
    await ensureAlarms();
  } else if (alarm.name === ALARM_WATCHDOG) {
    await checkDue('watchdog');
  } else if (alarm.name === ALARM_STARTUP) {
    await checkDue('Chrome started');
  } else if (alarm.name === ALARM_KEEPALIVE) {
    await keepSessionAlive();
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.settings) return;
  ensureAlarms();
  const s = changes.settings.newValue;
  if (s && s.startUrl) allowPopupsFor(new URL(s.startUrl).origin);
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return false;
  if (msg.type === 'runNow') {
    sendResponse(startRun('manual'));
  } else if (msg.type === 'cancelRun') {
    if (currentCtx) currentCtx.aborted = 'Cancelled by user';
    sendResponse({ ok: !!currentCtx });
  } else if (msg.type === 'debugInfo') {
    debugInfo().then(sendResponse, (e) => sendResponse({ error: e.message }));
    return true;
  } else if (msg.type === 'learnForecast') {
    learnForecastUrl().then(sendResponse, (e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  return false;
});

// A fresh service worker means any run that was in progress is gone.
chrome.storage.local.get('runStatus').then(({ runStatus }) => {
  if (runStatus && runStatus.running && !currentRun) {
    chrome.storage.local.set({ runStatus: { ...runStatus, running: false, step: 'Interrupted' } });
  }
});
ensureAlarms();
