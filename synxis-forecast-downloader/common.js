// Shared settings and helpers used by the background worker, popup and options page.

export const DEFAULT_SETTINGS = {
  startUrl: 'https://controlcenter-p2.synxis.com/CC/default.aspx',
  dateRange: 'Next Year',

  scheduleEnabled: true,
  scheduleTime: '02:00', // must be inside the night window (00:00 - 05:59)
  maxAttempts: 3, // scheduled attempts per day (first try + retries)
  retryMinutes: 20,
  catchUpIfMissed: true, // PC/Chrome was off at night -> run when Chrome is next open

  folder: 'SynXis Forecast', // sub-folder inside Chrome's Downloads folder
  fileNameTemplate: 'Forecast_{range}_{date}',
  conflictAction: 'uniquify', // 'uniquify' | 'overwrite'

  notifications: true,
  keepWindowOnFailure: false,
  keepSessionAlive: false,
  reportTimeoutSec: 180,
};

// Night window in which the scheduled run is allowed: [00:00, 06:00)
export const WINDOW_END_HOUR = 6;

// Options exactly as they appear in the SynXis "Date Range" dropdown.
export const DATE_RANGES = [
  'Today',
  'Tomorrow',
  'Date-to-Month-End',
  'Date-to-Year-End',
  'Next 3 Days',
  'Next 7 Days',
  'Next 2 Weeks',
  'Next Month',
  'Next 3 Months',
  'Next 6 Months',
  'Next Year',
];

export async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...(settings || {}) };
}

export async function saveSettings(patch) {
  const current = await getSettings();
  const next = { ...current, ...patch };
  await chrome.storage.local.set({ settings: next });
  return next;
}

const pad = (n) => String(n).padStart(2, '0');

export function localDateKey(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function parseTime(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return { h, min };
}

export function isNightTime(hhmm) {
  const t = parseTime(hhmm);
  return !!t && t.h < WINDOW_END_HOUR;
}

// Today's scheduled time as a Date (local time).
export function scheduledTimeOn(settings, day) {
  const t = parseTime(settings.scheduleTime) || parseTime(DEFAULT_SETTINGS.scheduleTime);
  const d = new Date(day);
  d.setHours(t.h, t.min, 0, 0);
  return d;
}

// Decides whether the scheduled download should start now: at the set time, as a
// retry after a failure, or (optionally) as a catch-up when the night run was
// missed. Returns the trigger name, or null when nothing is due.
export function dueTrigger(settings, schedState, now = new Date()) {
  if (!settings.scheduleEnabled) return null;
  if (now.getTime() < scheduledTimeOn(settings, now).getTime() - 60000) return null;
  const st =
    schedState && schedState.date === localDateKey(now) ? schedState : { attempts: 0, success: false };
  if (st.success || st.attempts >= settings.maxAttempts) return null;
  if (st.lastAttemptAt && now.getTime() - st.lastAttemptAt < settings.retryMinutes * 60000) return null;
  if (now.getHours() >= WINDOW_END_HOUR) return settings.catchUpIfMissed ? 'catch-up' : null;
  return st.attempts ? 'retry' : 'scheduled';
}

export function nextScheduledRun(settings, now = new Date()) {
  const d = scheduledTimeOn(settings, now);
  if (d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1);
  return d;
}

// Folder path relative to the Downloads folder. Keeps "/" for nested folders,
// strips characters Windows does not allow and anything that could escape Downloads.
export function sanitizeFolder(folder) {
  return String(folder || '')
    .replace(/\\/g, '/')
    .split('/')
    .map((part) => part.replace(/[<>:"|?*\x00-\x1f]/g, '').trim().replace(/[. ]+$/, ''))
    .filter((part) => part && part !== '.' && part !== '..')
    .join('/');
}

export function sanitizeFileName(name) {
  return String(name || '')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')
    .trim()
    .replace(/[. ]+$/, '');
}

export function buildFileName(template, range, date = new Date()) {
  const tokens = {
    date: localDateKey(date),
    time: `${pad(date.getHours())}${pad(date.getMinutes())}`,
    range: String(range || '').replace(/[^A-Za-z0-9]+/g, ''),
    YYYY: String(date.getFullYear()),
    MM: pad(date.getMonth() + 1),
    DD: pad(date.getDate()),
    HH: pad(date.getHours()),
    mm: pad(date.getMinutes()),
  };
  const raw = String(template || DEFAULT_SETTINGS.fileNameTemplate).replace(
    /\{(\w+)\}/g,
    (all, key) => (key in tokens ? tokens[key] : all),
  );
  const base = sanitizeFileName(raw.replace(/\.csv$/i, '')) || `Forecast_${tokens.date}`;
  return `${base}.csv`;
}

// Path handed to chrome.downloads (always relative to the Downloads folder).
export function buildTargetPath(settings, date = new Date()) {
  const folder = sanitizeFolder(settings.folder);
  const file = buildFileName(settings.fileNameTemplate, settings.dateRange, date);
  return folder ? `${folder}/${file}` : file;
}

export function formatDateTime(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}
