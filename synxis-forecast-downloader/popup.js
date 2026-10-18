import { getSettings, sanitizeFolder, formatDateTime } from './common.js';

const $ = (id) => document.getElementById(id);

const TRIGGERS = {
  manual: 'manual',
  scheduled: 'scheduled',
  retry: 'scheduled retry',
  'catch-up': 'catch-up',
};

async function render() {
  const settings = await getSettings();
  const { runStatus, lastRun, lastSuccess, nextRunAt, keepAlive } = await chrome.storage.local.get([
    'runStatus',
    'lastRun',
    'lastSuccess',
    'nextRunAt',
    'keepAlive',
  ]);

  const running = !!(runStatus && runStatus.running);
  $('idleBox').classList.toggle('hidden', running);
  $('runningBox').classList.toggle('hidden', !running);
  $('runStep').textContent = running ? runStatus.step || '' : '';
  $('rangeNote').textContent = `Forecast · Date Range: ${settings.dateRange} · CSV`;

  const last = $('lastRun');
  if (!lastRun) {
    last.className = 'muted';
    last.textContent = 'Never';
  } else if (lastRun.ok) {
    last.className = '';
    last.innerHTML = '';
    const line = document.createElement('div');
    line.className = 'ok';
    line.textContent = `✔ ${formatDateTime(lastRun.at)} (${TRIGGERS[lastRun.trigger] || lastRun.trigger})`;
    const path = document.createElement('div');
    path.className = 'path';
    path.style.marginTop = '4px';
    path.textContent = lastRun.path;
    last.append(line, path);
  } else {
    last.className = '';
    last.innerHTML = '';
    const line = document.createElement('div');
    line.className = 'err';
    line.textContent = `✖ ${formatDateTime(lastRun.at)} (${TRIGGERS[lastRun.trigger] || lastRun.trigger})`;
    const why = document.createElement('div');
    why.className = 'small';
    why.textContent = lastRun.error;
    last.append(line, why);
    if (lastSuccess) {
      const prev = document.createElement('div');
      prev.className = 'small muted';
      prev.textContent = `Last successful: ${formatDateTime(lastSuccess.at)}`;
      last.append(prev);
    }
  }

  $('nextRun').textContent = settings.scheduleEnabled
    ? formatDateTime(nextRunAt)
    : 'Automatic run is turned off (see Settings)';

  const folder = sanitizeFolder(settings.folder);
  $('folder').textContent = `Downloads${folder ? '\\' + folder.replace(/\//g, '\\') : ''}`;

  $('sessionBlock').classList.toggle('hidden', !settings.keepSessionAlive || !keepAlive);
  if (keepAlive) {
    $('session').className = keepAlive.ok ? 'ok' : 'err';
    $('session').textContent = `${keepAlive.ok ? 'Logged in' : 'Looks logged out'} · checked ${formatDateTime(keepAlive.at)}`;
  }

  $('showFile').disabled = !(lastSuccess && lastSuccess.downloadId);
}

$('runNow').addEventListener('click', async () => {
  $('msg').textContent = '';
  const res = await chrome.runtime.sendMessage({ type: 'runNow' });
  if (res && !res.started) $('msg').textContent = res.reason;
});

$('cancelRun').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'cancelRun' }));
$('openSettings').addEventListener('click', () => chrome.runtime.openOptionsPage());
$('openFolder').addEventListener('click', () => chrome.downloads.showDefaultFolder());
$('showFile').addEventListener('click', async () => {
  const { lastSuccess } = await chrome.storage.local.get('lastSuccess');
  if (!lastSuccess) return;
  const [item] = await chrome.downloads.search({ id: lastSuccess.downloadId });
  if (item && item.exists !== false) chrome.downloads.show(lastSuccess.downloadId);
  else $('msg').textContent = 'That file was moved or deleted.';
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local') render();
});
render();
