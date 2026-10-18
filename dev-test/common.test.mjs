// Unit tests for the schedule and file-name helpers:  node --test dev-test/common.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_SETTINGS,
  dueTrigger,
  nextScheduledRun,
  buildTargetPath,
  sanitizeFolder,
  isNightTime,
} from '../synxis-forecast-downloader/common.js';

const s = (patch = {}) => ({ ...DEFAULT_SETTINGS, scheduleTime: '02:00', ...patch });
const at = (h, m = 0, day = 18) => new Date(2026, 9, day, h, m);
const key = '2026-10-18';

test('nothing is due before the scheduled time', () => {
  assert.equal(dueTrigger(s(), undefined, at(1, 30)), null);
});

test('scheduled run starts at the set time', () => {
  assert.equal(dueTrigger(s(), undefined, at(2, 0)), 'scheduled');
  assert.equal(dueTrigger(s(), { date: '2026-10-17', attempts: 3, success: true }, at(2, 5)), 'scheduled');
});

test('turned off -> never due', () => {
  assert.equal(dueTrigger(s({ scheduleEnabled: false }), undefined, at(2, 0)), null);
});

test('done for today -> not due again', () => {
  assert.equal(dueTrigger(s(), { date: key, attempts: 1, success: true }, at(3, 0)), null);
});

test('failed run retries after the wait, up to the limit', () => {
  const failedAt = at(2, 0).getTime();
  assert.equal(dueTrigger(s(), { date: key, attempts: 1, lastAttemptAt: failedAt }, at(2, 10)), null);
  assert.equal(dueTrigger(s(), { date: key, attempts: 1, lastAttemptAt: failedAt }, at(2, 20)), 'retry');
  assert.equal(dueTrigger(s(), { date: key, attempts: 3, lastAttemptAt: failedAt }, at(4, 0)), null);
});

test('missed night run -> catch-up during the day only if enabled', () => {
  assert.equal(dueTrigger(s(), undefined, at(9, 15)), 'catch-up');
  assert.equal(dueTrigger(s({ catchUpIfMissed: false }), undefined, at(9, 15)), null);
});

test('next run is today if the time is still ahead, else tomorrow', () => {
  assert.deepEqual(nextScheduledRun(s(), at(1, 0)), at(2, 0));
  assert.deepEqual(nextScheduledRun(s(), at(2, 0)), at(2, 0, 19));
  assert.deepEqual(nextScheduledRun(s(), at(14, 0)), at(2, 0, 19));
});

test('only 00:00-05:59 counts as night', () => {
  assert.ok(isNightTime('00:00'));
  assert.ok(isNightTime('05:59'));
  assert.ok(!isNightTime('06:00'));
  assert.ok(!isNightTime('23:30'));
  assert.ok(!isNightTime('bad'));
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
