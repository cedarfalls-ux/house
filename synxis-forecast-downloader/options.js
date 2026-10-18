import {
  DEFAULT_SETTINGS,
  DATE_RANGES,
  getSettings,
  buildTargetPath,
  sanitizeFolder,
  validWindow,
  dailyStatus,
  normalizeSiteUrl,
  originPattern,
  formatDateTime,
  badgeCountdown,
  REFRESH_MODES,
} from './common.js';

const $ = (id) => document.getElementById(id);
// Opened from the toolbar icon: shown inside the icon's pop-up.
if (new URLSearchParams(location.search).has('popup')) document.documentElement.classList.add('popup');
let loadedSettings = { ...DEFAULT_SETTINGS };
const CHECKS = [
  'scheduleEnabled',
  'runAfterWindow',
  'autoRefreshEnabled',
  'answerPopups',
  'keepAwake',
  'notifications',
  'keepWindowOnFailure',
];
const TEXTS = [
  'windowStart',
  'windowEnd',
  'folder',
  'fileNameTemplate',
  'conflictAction',
  'dateRange',
  'startUrl',
  'forecastUrl',
];
const NUMBERS = ['idleSeconds', 'maxAttempts', 'retryMinutes', 'reportTimeoutSec'];
const TRIGGERS = {
  manual: 'manual',
  scheduled: 'daily',
  retry: 'daily retry',
  'after-window': 'daily, after the window',
};

for (const r of DATE_RANGES) $('dateRange').append(new Option(r, r));

// ---------- auto refresh rows ----------

function addRuleRow(rule = { url: '', seconds: 300, mode: 'reload' }) {
  const row = document.createElement('div');
  row.className = 'rule';
  row.innerHTML =
    '<div class="row"><input type="text" class="ruleUrl" placeholder="https://controlcenter-p2.synxis.com/CC/default.aspx" style="flex: 1; max-width: none">' +
    '<button class="btn danger" title="Remove">✕</button></div>' +
    '<div class="row" style="margin-top: 6px">after <input type="number" class="ruleSeconds" min="15" max="86400" title="Seconds of inactivity"> sec without activity:' +
    '<select class="ruleMode" style="width: auto"></select></div>';
  for (const [value, label] of Object.entries(REFRESH_MODES)) row.querySelector('.ruleMode').append(new Option(label, value));
  row.querySelector('.ruleUrl').value = rule.url;
  row.querySelector('.ruleSeconds').value = rule.seconds;
  row.querySelector('.ruleMode').value = rule.mode === 'clickHome' ? 'clickHome' : 'reload';
  row.querySelector('button').addEventListener('click', () => row.remove());
  $('rules').append(row);
}

function readRules() {
  return [...document.querySelectorAll('#rules .rule')]
    .map((row) => ({
      raw: row.querySelector('.ruleUrl').value.trim(),
      seconds: Number(row.querySelector('.ruleSeconds').value),
      mode: row.querySelector('.ruleMode').value,
    }))
    .filter((r) => r.raw);
}

$('addRule').addEventListener('click', () => addRuleRow());

// ---------- form ----------

function readForm() {
  const s = {};
  for (const k of CHECKS) s[k] = $(k).checked;
  for (const k of TEXTS) s[k] = $(k).value.trim();
  for (const k of NUMBERS) s[k] = Number($(k).value);
  s.autoRefreshRules = readRules().map((r) => ({ url: normalizeSiteUrl(r.raw) || r.raw, seconds: r.seconds, mode: r.mode }));
  return s;
}

function fillForm(s) {
  loadedSettings = s;
  for (const k of CHECKS) $(k).checked = !!s[k];
  for (const k of TEXTS) $(k).value = s[k];
  for (const k of NUMBERS) $(k).value = s[k];
  $('rules').replaceChildren();
  for (const rule of s.autoRefreshRules || []) addRuleRow(rule);
  if (!(s.autoRefreshRules || []).length) addRuleRow();
  updatePreview();
}

function updatePreview() {
  const s = { ...DEFAULT_SETTINGS, ...readForm() };
  $('pathPreview').textContent = `Downloads\\${buildTargetPath(s).replace(/\//g, '\\')}`;
}

const isSynxis = (url) => {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && u.hostname.endsWith('synxis.com');
  } catch (e) {
    return false;
  }
};

function validate(s) {
  if (!validWindow(s)) return 'The time window must start before it ends (e.g. 12:00 AM to 11:00 AM).';
  if (!(s.idleSeconds >= 15 && s.idleSeconds <= 3600)) return 'No-activity seconds must be 15–3600.';
  if (!(s.maxAttempts >= 1 && s.maxAttempts <= 10)) return 'Tries per day must be 1–10.';
  if (!(s.retryMinutes >= 5 && s.retryMinutes <= 180)) return 'Minutes between tries must be 5–180.';
  if (/^[a-z]:|^[\\/]{2}/i.test(s.folder)) {
    return 'Enter a folder inside Downloads (e.g. "SynXis Forecast"), not a full path like D:\\Reports. See the note below for another drive.';
  }
  if (!sanitizeFolder(s.folder)) return 'Please enter a folder name.';
  if (!s.fileNameTemplate) return 'Please enter a file name.';
  for (const r of s.autoRefreshRules) {
    if (!normalizeSiteUrl(r.url)) return `Auto refresh: "${r.url}" is not a web address.`;
    if (!(Number.isInteger(r.seconds) && r.seconds >= 15 && r.seconds <= 86400)) {
      return `Auto refresh: seconds for ${r.url} must be a whole number from 15 to 86400.`;
    }
  }
  if (!(s.reportTimeoutSec >= 30 && s.reportTimeoutSec <= 900)) return 'Report timeout must be 30–900 seconds.';
  if (!isSynxis(s.startUrl)) return 'SynXis address must be an https://…synxis.com address.';
  if (s.forecastUrl && !isSynxis(s.forecastUrl)) return 'Forecast page address must be an https://…synxis.com address.';
  return null;
}

function showStatus(text, cls) {
  $('status').className = `small ${cls || ''}`;
  $('status').textContent = text;
}

$('save').addEventListener('click', () => {
  const s = readForm();
  const error = validate(s);
  if (error) return showStatus(error, 'err');
  s.folder = sanitizeFolder(s.folder);
  // Saved right away: Chrome's permission prompt below may close the pop-up.
  const next = { ...loadedSettings, ...s };
  chrome.storage.local.set({ settings: next });
  fillForm(next);
  // Sites other than SynXis need Chrome's permission (asked while the click
  // still counts as the user's action).
  const origins = s.autoRefreshEnabled
    ? [...new Set(s.autoRefreshRules.map((r) => normalizeSiteUrl(r.url)).filter((u) => u && !isSynxis(u)).map(originPattern))]
    : [];
  if (!origins.length) return showStatus('Saved ✔', 'ok');
  chrome.permissions.request({ origins }).then((ok) => {
    showStatus(ok ? 'Saved ✔' : 'Saved, but Chrome permission is needed to refresh those websites.', ok ? 'ok' : 'err');
  });
});

document.addEventListener('input', updatePreview);

// ---------- buttons ----------

$('runNow').addEventListener('click', async () => {
  const res = await chrome.runtime.sendMessage({ type: 'runNow' });
  $('runMsg').className = `small ${res && res.started ? 'ok' : 'err'}`;
  $('runMsg').textContent =
    res && res.started ? 'Download started in your SynXis tab.' : (res && res.reason) || 'Could not start.';
});
$('cancelRun').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'cancelRun' }));
$('showFile').addEventListener('click', async () => {
  const { lastSuccess } = await chrome.storage.local.get('lastSuccess');
  const [item] = lastSuccess ? await chrome.downloads.search({ id: lastSuccess.downloadId }) : [];
  if (item && item.exists !== false) chrome.downloads.show(lastSuccess.downloadId);
  else $('runMsg').textContent = 'No downloaded file to show yet (or it was moved).';
});
$('openDownloads').addEventListener('click', () => chrome.downloads.showDefaultFolder());
$('openDownloadSettings').addEventListener('click', () => chrome.tabs.create({ url: 'chrome://settings/downloads' }));
$('openSystemSettings').addEventListener('click', () => chrome.tabs.create({ url: 'chrome://settings/system' }));
$('openStartupSettings').addEventListener('click', () => chrome.tabs.create({ url: 'chrome://settings/onStartup' }));

$('learnForecast').addEventListener('click', async () => {
  $('learnStatus').textContent = 'Looking…';
  const res = await chrome.runtime.sendMessage({ type: 'learnForecast' });
  $('learnStatus').className = res && res.ok ? 'ok' : 'err';
  $('learnStatus').textContent = res && res.ok ? 'Saved ✔' : (res && res.error) || 'Failed';
  if (res && res.ok) $('forecastUrl').value = res.url;
});

$('copyDebug').addEventListener('click', async () => {
  showStatus('Collecting debug info…');
  const info = await chrome.runtime.sendMessage({ type: 'debugInfo' });
  const text = JSON.stringify(info, null, 1);
  $('debugBox').value = text;
  $('debugBox').classList.remove('hidden');
  try {
    await navigator.clipboard.writeText(text);
    showStatus('Debug info copied – paste it in the chat', 'ok');
  } catch (e) {
    $('debugBox').select();
    showStatus('Select the text in the box below and copy it (Ctrl+C)', 'warn');
  }
});

// ---------- status and log ----------

function logLine(entry) {
  const d = new Date(entry.t);
  const div = document.createElement('div');
  div.className = entry.level === 'error' ? 'err' : entry.level === 'warn' ? 'warn' : '';
  div.textContent = `${d.toLocaleDateString()} ${d.toLocaleTimeString()}  ${entry.msg}`;
  return div;
}

async function renderLogs() {
  const { logs = [] } = await chrome.storage.local.get('logs');
  const box = $('logs');
  box.replaceChildren(...logs.slice().reverse().map(logLine));
  if (!logs.length) box.textContent = 'No activity yet.';
}

$('clearLogs').addEventListener('click', () => chrome.storage.local.set({ logs: [] }));
$('copyLogs').addEventListener('click', async () => {
  const { logs = [] } = await chrome.storage.local.get('logs');
  const text = logs.map((e) => `${new Date(e.t).toLocaleString()} [${e.level}] ${e.msg}`).join('\n');
  await navigator.clipboard.writeText(text);
  showStatus('Log copied', 'ok');
});

async function renderStatus() {
  const s = await getSettings();
  const { runStatus, lastRun, schedState, lastAutoRefresh } = await chrome.storage.local.get([
    'runStatus',
    'lastRun',
    'schedState',
    'lastAutoRefresh',
  ]);
  const running = !!(runStatus && runStatus.running);
  $('statusRunning').classList.toggle('hidden', !running);
  $('statusStep').textContent = running ? runStatus.step || '' : '';
  $('runNow').disabled = running;
  $('cancelRun').classList.toggle('hidden', !running);

  const last = $('statusLast');
  if (!lastRun) {
    last.className = 'muted';
    last.textContent = 'Never';
  } else {
    last.className = lastRun.ok ? 'ok' : 'err';
    const when = `${formatDateTime(lastRun.at)} (${TRIGGERS[lastRun.trigger] || lastRun.trigger})`;
    last.textContent = lastRun.ok ? `✔ ${when}` : `✖ ${when} – ${lastRun.error}`;
  }
  $('statusPath').classList.toggle('hidden', !(lastRun && lastRun.ok));
  $('statusPath').textContent = lastRun && lastRun.ok ? lastRun.path : '';
  $('statusDaily').textContent = dailyStatus(s, schedState);

  const sites = (s.autoRefreshRules || []).length;
  const { countdowns = {} } = await chrome.storage.session.get('countdowns');
  const dues = Object.values(countdowns);
  $('statusRefresh').textContent = s.autoRefreshEnabled
    ? `On for ${sites} website${sites === 1 ? '' : 's'}` +
      (dues.length ? ` · next in ${badgeCountdown(Math.min(...dues) - Date.now())} sec` : '') +
      (lastAutoRefresh ? ` · last ${formatDateTime(lastAutoRefresh.at)}` : '')
    : 'Off';
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.logs) renderLogs();
  if (changes.runStatus || changes.lastRun || changes.schedState || changes.lastAutoRefresh || changes.settings) {
    renderStatus();
  }
});
setInterval(renderStatus, 1000); // countdown and time-of-day dependent texts

getSettings().then(fillForm);
renderLogs();
renderStatus();
