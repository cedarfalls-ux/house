// Shared settings and helpers used by the background worker and the Settings page.

export const DEFAULT_SETTINGS = {
  startUrl: 'https://controlcenter-p2.synxis.com/CC/default.aspx',
  forecastUrl: '', // optional backup: address of the Forecast page itself
  dateRange: 'Next Year',

  // Daily automatic download: once a day inside the window, as soon as SynXis is
  // open and logged in and nobody has touched mouse/keyboard for idleSeconds.
  scheduleEnabled: true,
  windowStart: '00:00',
  windowEnd: '11:00',
  idleSeconds: 90,
  maxAttempts: 3, // automatic attempts per day (first try + retries)
  retryMinutes: 20,
  runAfterWindow: false, // if it didn't happen inside the window, still try later that day

  folder: 'SynXis Forecast', // sub-folder inside Chrome's Downloads folder
  fileNameTemplate: 'Forecast_{range}_{date}',
  conflictAction: 'uniquify', // 'uniquify' | 'overwrite'

  // Auto refresh: reload the tab of each site after its seconds of inactivity.
  autoRefreshEnabled: false,
  autoRefreshRules: [{ url: 'https://controlcenter-p2.synxis.com/CC/default.aspx', seconds: 300 }],
  answerPopups: true, // SynXis: Bank pop-up -> NO, session about to expire -> KEEP SESSION ACTIVE
  keepAwake: true, // keep the screen on / computer awake

  notifications: true,
  keepWindowOnFailure: false,
  reportTimeoutSec: 180,
};

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

const minutesOf = (hhmm) => {
  const t = parseTime(hhmm);
  return t ? t.h * 60 + t.min : null;
};

// Is "now" inside the daily window [windowStart, windowEnd)?
export function inWindow(settings, now = new Date()) {
  const start = minutesOf(settings.windowStart);
  const end = minutesOf(settings.windowEnd);
  const cur = now.getHours() * 60 + now.getMinutes();
  return start != null && end != null && cur >= start && cur < end;
}

export function validWindow(settings) {
  const start = minutesOf(settings.windowStart);
  const end = minutesOf(settings.windowEnd);
  return start != null && end != null && start < end;
}

// Decides whether the daily download may start now (the caller still checks that
// SynXis is open and the user is inactive). Returns the trigger name or null.
export function dueTrigger(settings, schedState, now = new Date()) {
  if (!settings.scheduleEnabled || !validWindow(settings)) return null;
  const st =
    schedState && schedState.date === localDateKey(now) ? schedState : { attempts: 0, success: false };
  if (st.success || st.attempts >= settings.maxAttempts) return null;
  if (st.lastAttemptAt && now.getTime() - st.lastAttemptAt < settings.retryMinutes * 60000) return null;
  if (inWindow(settings, now)) return st.attempts ? 'retry' : 'scheduled';
  const afterWindow = now.getHours() * 60 + now.getMinutes() >= minutesOf(settings.windowEnd);
  return afterWindow && settings.runAfterWindow ? 'after-window' : null;
}

// One line for the Settings page: what the daily download is doing today.
export function dailyStatus(settings, schedState, now = new Date()) {
  if (!settings.scheduleEnabled) return 'Turned off';
  if (!validWindow(settings)) return 'The time window is not valid';
  const win = `${formatTime(settings.windowStart)} – ${formatTime(settings.windowEnd)}`;
  const when = `when SynXis is open and nobody has used mouse/keyboard for ${settings.idleSeconds} sec`;
  const st =
    schedState && schedState.date === localDateKey(now) ? schedState : { attempts: 0, success: false };
  if (st.success) return `✔ Done for today. Next: tomorrow ${win}`;
  if (st.attempts >= settings.maxAttempts) {
    return `Stopped for today after ${st.attempts} failed tries. Next: tomorrow ${win}`;
  }
  const retryAt = st.lastAttemptAt ? st.lastAttemptAt + settings.retryMinutes * 60000 : 0;
  if (retryAt > now.getTime()) {
    const t = new Date(retryAt);
    return `Last try failed; tries again after ${formatTime(`${t.getHours()}:${pad(t.getMinutes())}`)} ${when}`;
  }
  if (inWindow(settings, now)) return `Waiting now (${win}): starts ${when}`;
  const cur = now.getHours() * 60 + now.getMinutes();
  if (cur < minutesOf(settings.windowStart)) return `Today ${win}, ${when}`;
  return settings.runAfterWindow ? `Missed the window: starts ${when}` : `Next: tomorrow ${win}`;
}

export function formatTime(hhmm) {
  const t = parseTime(hhmm);
  if (!t) return hhmm;
  return new Date(2000, 0, 1, t.h, t.min).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

// ---- auto refresh ----

// "controlcenter-p2.synxis.com/CC/default.aspx" -> "https://controlcenter-p2.synxis.com/CC/default.aspx"
export function normalizeSiteUrl(raw) {
  let s = String(raw || '').trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  try {
    const u = new URL(s);
    u.hash = '';
    return u.href;
  } catch (e) {
    return null;
  }
}

// A tab matches a rule when it is on the same site and its address starts with
// the rule's address (query/hash ignored), so only that page's tab is refreshed.
export function ruleMatches(rule, tabUrl) {
  const site = normalizeSiteUrl(rule && rule.url);
  if (!site || !tabUrl) return false;
  try {
    const r = new URL(site);
    const t = new URL(tabUrl);
    const strip = (p) => p.replace(/\/+$/, '').toLowerCase();
    return r.origin === t.origin && strip(t.pathname).startsWith(strip(r.pathname));
  } catch (e) {
    return false;
  }
}

export function findRule(settings, tabUrl) {
  return (settings.autoRefreshRules || []).find((r) => r.seconds >= 15 && ruleMatches(r, tabUrl)) || null;
}

// Match pattern for chrome.scripting/permissions, e.g. "https://example.com/*"
export function originPattern(url) {
  return `${new URL(url).origin}/*`;
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
