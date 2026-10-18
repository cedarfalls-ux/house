import {
  DEFAULT_SETTINGS,
  DATE_RANGES,
  getSettings,
  saveSettings,
  buildTargetPath,
  sanitizeFolder,
  isNightTime,
  nextScheduledRun,
  formatDateTime,
} from './common.js';

const $ = (id) => document.getElementById(id);
const CHECKS = [
  'scheduleEnabled',
  'catchUpIfMissed',
  'oneClick',
  'notifications',
  'keepSessionAlive',
  'keepWindowOnFailure',
];
const TEXTS = ['scheduleTime', 'folder', 'fileNameTemplate', 'conflictAction', 'dateRange', 'startUrl', 'forecastUrl'];
const NUMBERS = ['maxAttempts', 'retryMinutes', 'reportTimeoutSec'];

for (const r of DATE_RANGES) $('dateRange').append(new Option(r, r));

function readForm() {
  const s = {};
  for (const k of CHECKS) s[k] = $(k).checked;
  for (const k of TEXTS) s[k] = $(k).value.trim();
  for (const k of NUMBERS) s[k] = Number($(k).value);
  return s;
}

function fillForm(s) {
  for (const k of CHECKS) $(k).checked = !!s[k];
  for (const k of TEXTS) $(k).value = s[k];
  for (const k of NUMBERS) $(k).value = s[k];
  updatePreview();
}

function updatePreview() {
  const s = { ...DEFAULT_SETTINGS, ...readForm() };
  $('pathPreview').textContent = `Downloads\\${buildTargetPath(s).replace(/\//g, '\\')}`;
  $('nextRunText').textContent =
    s.scheduleEnabled && isNightTime(s.scheduleTime) ? `Next run: ${formatDateTime(nextScheduledRun(s).getTime())}` : '';
}

function validate(s) {
  if (!isNightTime(s.scheduleTime)) return 'Time must be between 12:00 AM and 5:59 AM.';
  if (/^[a-z]:|^[\\/]{2}/i.test(s.folder)) {
    return 'Enter a folder inside Downloads (e.g. "SynXis Forecast"), not a full path like D:\\Reports. See the note below for another drive.';
  }
  if (!sanitizeFolder(s.folder)) return 'Please enter a folder name.';
  if (!s.fileNameTemplate) return 'Please enter a file name.';
  if (!(s.maxAttempts >= 1 && s.maxAttempts <= 10)) return 'Tries per night must be 1–10.';
  if (!(s.retryMinutes >= 5 && s.retryMinutes <= 180)) return 'Minutes between tries must be 5–180.';
  if (!(s.reportTimeoutSec >= 30 && s.reportTimeoutSec <= 900)) return 'Report timeout must be 30–900 seconds.';
  const isSynxis = (url) => {
    try {
      const u = new URL(url);
      return u.protocol === 'https:' && u.hostname.endsWith('synxis.com');
    } catch (e) {
      return false;
    }
  };
  if (!isSynxis(s.startUrl)) return 'SynXis address must be an https://…synxis.com address.';
  if (s.forecastUrl && !isSynxis(s.forecastUrl)) return 'Forecast page address must be an https://…synxis.com address.';
  return null;
}

function showStatus(text, cls) {
  $('status').className = `small ${cls || ''}`;
  $('status').textContent = text;
}

$('save').addEventListener('click', async () => {
  const s = readForm();
  const error = validate(s);
  if (error) return showStatus(error, 'err');
  s.folder = sanitizeFolder(s.folder);
  await saveSettings(s);
  fillForm(await getSettings());
  showStatus('Saved ✔', 'ok');
});

$('runNow').addEventListener('click', async () => {
  const res = await chrome.runtime.sendMessage({ type: 'runNow' });
  showStatus(res && res.started ? 'Download started – watch the log below.' : (res && res.reason) || '', res && res.started ? 'ok' : 'err');
});

document.querySelectorAll('input, select').forEach((el) => el.addEventListener('input', updatePreview));

$('openDownloadSettings').addEventListener('click', () => chrome.tabs.create({ url: 'chrome://settings/downloads' }));
$('openSystemSettings').addEventListener('click', () => chrome.tabs.create({ url: 'chrome://settings/system' }));
$('openDownloads').addEventListener('click', () => chrome.downloads.showDefaultFolder());

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

$('clearLogs').addEventListener('click', async () => {
  await chrome.storage.local.set({ logs: [] });
});
$('copyLogs').addEventListener('click', async () => {
  const { logs = [] } = await chrome.storage.local.get('logs');
  const text = logs.map((e) => `${new Date(e.t).toLocaleString()} [${e.level}] ${e.msg}`).join('\n');
  await navigator.clipboard.writeText(text);
  showStatus('Log copied', 'ok');
});

const TRIGGERS = { manual: 'manual', scheduled: 'scheduled', retry: 'scheduled retry', 'catch-up': 'catch-up' };

async function renderStatus() {
  const s = await getSettings();
  const { runStatus, lastRun, nextRunAt } = await chrome.storage.local.get(['runStatus', 'lastRun', 'nextRunAt']);
  const running = !!(runStatus && runStatus.running);
  $('statusRunning').classList.toggle('hidden', !running);
  $('statusStep').textContent = running ? runStatus.step || '' : '';
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
  $('statusNext').textContent = s.scheduleEnabled ? formatDateTime(nextRunAt) : 'turned off';
}

$('cancelRun').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'cancelRun' }));

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.logs) renderLogs();
  if (changes.runStatus || changes.lastRun || changes.nextRunAt || changes.settings) renderStatus();
});

getSettings().then(fillForm);
renderLogs();
renderStatus();
