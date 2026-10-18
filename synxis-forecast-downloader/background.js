import { getSettings, buildTargetPath, localDateKey, nextScheduledRun, dueTrigger } from './common.js';
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
  log('info', text);
  await setRunStatus({ step: text });
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

async function openForecastCriteria(ctx) {
  const tabId = ctx.mainTabId;
  const range = ctx.settings.dateRange;
  const deadline = Date.now() + 120000;
  const counts = { reports: 0, sph: 0, forecast: 0 };
  let allowHidden = false;
  let idle = 0;

  while (Date.now() < deadline) {
    checkAbort(ctx);
    await assertOnSite(ctx, tabId);
    const frames = await safeAgent(tabId, 'scan', { range, allowHidden });
    if (frames.some((f) => f.loginForm)) throw new LoginRequiredError('login form shown');
    if (frames.some((f) => f.rangeSelect)) return;

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
      }
      await sleep(ctx, 1500);
      continue;
    }
    idle = 0;

    let res;
    try {
      [res] = await runAgent(
        tabId,
        'act',
        { action: acted.action, click: acted.click, strongOnly: acted.strongOnly, allowHidden },
        [acted.frame.frameId],
      );
    } catch (e) {
      res = { ok: false, error: e.message };
    }
    if (res && res.ok) log('info', `Clicked: ${acted.label}`);
    else log('warn', `Could not click ${acted.label}: ${res ? res.error : 'frame not ready'}`);

    if (acted.action === 'clickForecast') {
      // Give the report page time to load before trying anything else.
      const end = Date.now() + 15000;
      while (Date.now() < end) {
        await sleep(ctx, 1000);
        const f = await safeAgent(tabId, 'scan', { range });
        if (f.some((x) => x.rangeSelect)) return;
      }
    } else {
      await sleep(ctx, 1500);
    }
  }
  throw new Error('Could not open the Forecast report page (Reports > SynXis Property Hub > Forecast not found)');
}

async function selectDateRange(ctx) {
  const tabId = ctx.mainTabId;
  const range = ctx.settings.dateRange;
  for (let i = 0; i < 5; i++) {
    const frames = await safeAgent(tabId, 'scan', { range });
    const crit = frames.find((f) => f.rangeSelect);
    if (!crit) {
      await sleep(ctx, 1500);
      continue;
    }
    if ((crit.rangeSelected || '').toLowerCase() === range.toLowerCase()) {
      log('info', `Date Range is set to "${crit.rangeSelected}"`);
      return;
    }
    const [res] = await runAgent(tabId, 'act', { action: 'selectRange', range }, [crit.frameId]);
    if (res && !res.ok) throw new Error(`${res.error}. Available: ${(crit.rangeOptions || []).join(', ')}`);
    await sleep(ctx, 2500); // a post-back may reload the page
  }
  throw new Error(`Could not set Date Range to "${range}"`);
}

async function generateReport(ctx) {
  const tabId = ctx.mainTabId;
  let gen = null;
  const end = Date.now() + 20000;
  while (!gen && Date.now() < end) {
    gen = (await safeAgent(tabId, 'scan', { range: ctx.settings.dateRange })).find((f) => f.generateBtn);
    if (!gen) await sleep(ctx, 1000);
  }
  if (!gen) throw new Error('"Generate Report" button not found');

  const before = new Set((await chrome.tabs.query({})).map((t) => t.id));
  const [res] = await runAgent(tabId, 'act', { action: 'clickGenerate' }, [gen.frameId]);
  if (res && !res.ok) throw new Error(res.error);
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
      if (popup.windowId !== ctx.mainWindowId) ctx.windowIds.add(popup.windowId);
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

  await step(ctx, 'Opening SynXis Control Center');
  const win = await chrome.windows.create({
    url: settings.startUrl,
    type: 'normal',
    focused: true,
    width: 1440,
    height: 900,
  });
  ctx.mainWindowId = win.id;
  ctx.windowIds.add(win.id);
  ctx.mainTabId = win.tabs[0].id;
  await waitForTabComplete(ctx, ctx.mainTabId, 60000);
  await assertOnSite(ctx, ctx.mainTabId);

  await step(ctx, 'Opening Reports > SynXis Property Hub (SPH) > Forecast');
  await openForecastCriteria(ctx);

  await step(ctx, `Selecting Date Range "${settings.dateRange}"`);
  await selectDateRange(ctx);

  await step(ctx, 'Generating report');
  const reportTabId = await generateReport(ctx);

  await step(ctx, 'Waiting for the report to load');
  const viewer = await waitForReport(ctx, reportTabId);

  await step(ctx, 'Downloading CSV');
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
    windowIds: new Set(),
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
    setBadge('', null);
    notify('Forecast report downloaded', saved.path);
  } catch (err) {
    failed = true;
    const message = (err && err.message) || String(err);
    await chrome.storage.local.set({ lastRun: { ok: false, at: Date.now(), trigger, error: message } });
    log('error', `Run failed: ${message}`);
    setBadge('!', '#d93025');
    notify('Forecast download failed', message);
  } finally {
    clearTimeout(timer);
    if (!(failed && settings.keepWindowOnFailure)) {
      for (const id of ctx.windowIds) await chrome.windows.remove(id).catch(() => {});
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
