# SynXis Forecast Auto Downloader (Chrome extension)

Downloads the **SynXis Property Hub → Front Office → Forecast** report with
**Date Range = Next Year** as a **CSV** file, automatically every night between
12 AM and 6 AM, or whenever you click **Download Forecast now**. The file goes
into a folder you choose.

What it does, step by step, just like you would by hand:

1. Opens `https://controlcenter-p2.synxis.com/CC/default.aspx` in a new window
2. **Reports** → **SynXis Property Hub (SPH)** → **Forecast**
3. **Date Range** dropdown → **Next Year**
4. **GENERATE REPORT**
5. In the report pop-up: **Export → CSV (comma delimited)**
6. Saves the file as `Downloads\SynXis Forecast\Forecast_NextYear_2026-10-18.csv`
7. Closes the report pop-up and the SynXis window

## Install (one time, about 2 minutes)

1. Copy the **`synxis-forecast-downloader`** folder to your PC
   (for example `C:\Tools\synxis-forecast-downloader`). Don't delete it later,
   because Chrome loads the extension from this folder.
2. In Chrome open **`chrome://extensions`**.
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and select the `synxis-forecast-downloader` folder.
5. Click the puzzle icon in the toolbar and **pin** "SynXis Forecast Auto Downloader".
6. Log in to SynXis in this same Chrome profile (select the right hotel).
7. Click the extension icon → **Download Forecast now** to test it. The window
   opens, does everything by itself, and closes. The popup shows where the file
   was saved.

## Settings (extension icon → Settings)

| Setting | Default | Notes |
| --- | --- | --- |
| Automatic daily download | On | |
| Time | 2:00 AM | Any time from 12:00 AM to 5:59 AM |
| Tries per night / minutes between tries | 3 / 20 | Retries if the site is slow or a run fails |
| Catch up if missed | On | If the PC/Chrome was off at night, it downloads when Chrome is open again that day |
| Folder (inside Downloads) | `SynXis Forecast` | Use `/` for sub-folders, e.g. `Hotel Reports/Forecast` |
| File name | `Forecast_{range}_{date}` | Tokens: `{date}` `{time}` `{range}` `{YYYY}` `{MM}` `{DD}` `{HH}` `{mm}` |
| If file exists | Keep both | Or **Replace** (e.g. file name `Forecast_latest` + Replace = always one up-to-date file) |
| Date Range | Next Year | Any value from the SynXis dropdown |

### Saving on another drive (e.g. `D:\Reports`)

Chrome only allows extensions to save **inside the Downloads folder**. To save
somewhere else, change Chrome's download location
(**chrome://settings/downloads → Location → Change**, there is a button for it
in Settings). The extension's folder is then created inside that location.

## For the night run to work

1. **The PC must be on and not asleep** at the scheduled time
   (Windows Settings → System → Power → Sleep: *Never* while plugged in).
2. **Chrome must be running.** Turn on *"Continue running background apps when
   Google Chrome is closed"* in **chrome://settings/system**. Chrome then keeps
   running in the background (system tray) even when all windows are closed.
3. **You must be logged in to SynXis** in this Chrome profile. If the session
   has expired, the run stops with *"SynXis is not logged in"* and you get a
   notification. Optionally turn on **Keep the SynXis login active** in
   Settings (it opens the SynXis home page in the background every 10 minutes).
   This helps, but can't beat a hard session time limit set by SynXis.

## Troubleshooting

- **Settings → Activity log** shows every step of every run (Copy button to
  share it). A red **!** on the extension icon means the last run failed.
- Turn on **Leave the SynXis window open when a run fails** to see exactly where
  it stopped.
- *"Report window did not open"*: the extension allows pop-ups for SynXis
  automatically. If it still happens, allow pop-ups for
  `controlcenter-p2.synxis.com` in Chrome's site settings.
- *"Could not open the Forecast report page"*: SynXis changed its menu. Send the
  activity log.
- If Chrome asks *where to save* for this report, turn off *"Ask where to save
  each file before downloading"* in chrome://settings/downloads (normally the
  extension saves without asking).

## Project layout

```
synxis-forecast-downloader/   the extension (load this folder in Chrome)
  manifest.json               permissions, background worker, popup, settings page
  background.js               schedule, retries, and the step-by-step run
  page-agent.js               code that runs inside the SynXis pages (clicks, dropdown, CSV export)
  common.js                   settings, schedule and file-name helpers
  popup.*  options.*          the popup and the Settings page
dev-test/                     tests (not needed to use the extension)
  common.test.mjs             unit tests:  node --test dev-test/common.test.mjs
  mock-synxis/server.mjs      a fake SynXis site with the same menus and report pop-up
  e2e.mjs                     loads the extension in Chromium against the fake site:
                              node dev-test/e2e.mjs [path-to-chrome]
```
