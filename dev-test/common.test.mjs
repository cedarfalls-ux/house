// Unit tests for the schedule, auto refresh and file-name helpers:  node --test dev-test/common.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_SETTINGS,
  dueTrigger,
  dailyStatus,
  inWindow,
  validWindow,
  normalizeSiteUrl,
  ruleMatches,
  findRule,
  originPattern,
  buildTargetPath,
  sanitizeFolder,
} from '../synxis-forecast-downloader/common.js';

const s = (patch = {}) => ({ ...DEFAULT_SETTINGS, ...patch });
const at = (h, m = 0, day = 18) => new Date(2026, 9, day, h, m);
const key = '2026-10-18';

test('default window is 12:00 AM to 11:00 AM', () => {
  assert.ok(inWindow(s(), at(0, 0)));
  assert.ok(inWindow(s(), at(10, 59)));
  assert.ok(!inWindow(s(), at(11, 0)));
  assert.ok(!inWindow(s(), at(23, 30)));
  assert.ok(validWindow(s()));
  assert.ok(!validWindow(s({ windowStart: '11:00', windowEnd: '09:00' })));
});

test('due any time inside the window, once a day', () => {
  assert.equal(dueTrigger(s(), undefined, at(0, 5)), 'scheduled');
  assert.equal(dueTrigger(s(), undefined, at(10, 30)), 'scheduled');
  assert.equal(dueTrigger(s(), { date: key, attempts: 1, success: true }, at(9, 0)), null);
  // yesterday's success does not count for today
  assert.equal(dueTrigger(s(), { date: '2026-10-17', attempts: 1, success: true }, at(1, 0)), 'scheduled');
});

test('outside the window only when "run after the window" is on', () => {
  assert.equal(dueTrigger(s(), undefined, at(14, 0)), null);
  assert.equal(dueTrigger(s({ runAfterWindow: true }), undefined, at(14, 0)), 'after-window');
  assert.equal(dueTrigger(s({ windowStart: '02:00' }), undefined, at(1, 0)), null);
});

test('turned off or bad window -> never due', () => {
  assert.equal(dueTrigger(s({ scheduleEnabled: false }), undefined, at(2, 0)), null);
  assert.equal(dueTrigger(s({ windowStart: '10:00', windowEnd: '10:00' }), undefined, at(10, 0)), null);
});

test('failed run retries after the wait, up to the limit', () => {
  const failedAt = at(2, 0).getTime();
  assert.equal(dueTrigger(s(), { date: key, attempts: 1, lastAttemptAt: failedAt }, at(2, 10)), null);
  assert.equal(dueTrigger(s(), { date: key, attempts: 1, lastAttemptAt: failedAt }, at(2, 20)), 'retry');
  assert.equal(dueTrigger(s(), { date: key, attempts: 3, lastAttemptAt: failedAt }, at(4, 0)), null);
});

test('status line for the Settings page', () => {
  assert.match(dailyStatus(s(), undefined, at(3, 0)), /^Waiting now/);
  assert.match(dailyStatus(s(), { date: key, attempts: 1, success: true }, at(3, 0)), /^✔ Done for today/);
  assert.match(dailyStatus(s(), undefined, at(15, 0)), /^Next: tomorrow/);
  assert.match(dailyStatus(s({ scheduleEnabled: false }), undefined, at(3, 0)), /^Turned off/);
  assert.match(dailyStatus(s(), { date: key, attempts: 3 }, at(5, 0)), /^Stopped for today/);
});

test('site addresses are normalized', () => {
  assert.equal(
    normalizeSiteUrl('controlcenter-p2.synxis.com/CC/default.aspx'),
    'https://controlcenter-p2.synxis.com/CC/default.aspx',
  );
  assert.equal(normalizeSiteUrl('https://example.com/page#top'), 'https://example.com/page');
  assert.equal(normalizeSiteUrl('   '), null);
  assert.equal(originPattern('https://example.com/a/b?c=1'), 'https://example.com/*');
});

test('only the tab of the entered address is refreshed', () => {
  const rule = { url: 'https://controlcenter-p2.synxis.com/CC/default.aspx', seconds: 60 };
  assert.ok(ruleMatches(rule, 'https://controlcenter-p2.synxis.com/CC/default.aspx'));
  assert.ok(ruleMatches(rule, 'https://controlcenter-p2.synxis.com/CC/Default.aspx?x=1#y'));
  assert.ok(!ruleMatches(rule, 'https://controlcenter-p2.synxis.com/CC/reports/ReportViewerRun.aspx'));
  assert.ok(!ruleMatches(rule, 'https://other.synxis.com/CC/default.aspx'));
  const site = { url: 'example.com', seconds: 30 };
  assert.ok(ruleMatches(site, 'https://example.com/any/page'));
  assert.equal(findRule(s({ autoRefreshRules: [{ url: 'example.com', seconds: 5 }] }), 'https://example.com/'), null);
});

test('file path uses folder, template tokens and .csv', () => {
  const d = at(2, 5);
  assert.equal(buildTargetPath(s(), d), 'SynXis Forecast/Forecast_NextYear_2026-10-18.csv');
  assert.equal(
    buildTargetPath(s({ folder: 'Reports\\Daily', fileNameTemplate: '{MM}-{DD}-{YYYY}_{time}' }), d),
    'Reports/Daily/10-18-2026_0205.csv',
  );
  assert.equal(buildTargetPath(s({ fileNameTemplate: 'Forecast_latest.csv' }), d), 'SynXis Forecast/Forecast_latest.csv');
});

test('folder cannot escape Downloads or use bad characters', () => {
  assert.equal(sanitizeFolder('../../Windows/Sys*tem'), 'Windows/System');
  assert.equal(sanitizeFolder('C:\\Reports\\'), 'C/Reports');
  assert.equal(sanitizeFolder('  /Hotel Reports/ Forecast. /'), 'Hotel Reports/Forecast');
});
