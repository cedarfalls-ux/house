# SynXis Forecast Auto Downloader (Chrome extension)

Downloads the **SynXis Property Hub → Front Office → Forecast** report with
**Date Range = Next Year** as a **CSV** file, automatically every night between
12 AM and 6 AM, or whenever you click **Download Forecast now**. The file goes
into a folder you choose.

What it does, step by step, just like you would by hand, and you can watch it
happen (each button gets an orange outline just before it is clicked, and a
banner at the bottom of the page shows the current step):

1. Uses the **SynXis tab you already have open** (it opens a new tab only if no
   SynXis tab is open, and closes that tab again at the end)
2. If **"You do not have a Bank open – Would you like to open a Bank?"** shows
   up (it can appear after every refresh), clicks **NO**
3. **Home** → **SPH Dashboard**
4. **Reports** → **SynXis Property Hub (SPH)** → **Forecast**
5. **Date Range** dropdown → **Next Year**
6. **GENERATE REPORT**
7. In the report pop-up: **Export → CSV (comma delimited)**
8. Saves the file as `Downloads\SynXis Forecast\Forecast_NextYear_2026-10-18.csv`
9. Closes the report pop-up. Your SynXis tab stays open on the Forecast page.

It only treats a page as the Forecast page when it shows **both** the Date Range
dropdown and the Generate Report button (the dashboard has other dropdowns that
also offer "Next Year").

If the Reports menu can't be clicked on the current page, it reloads the SynXis
home page and tries again, and after that opens the saved **Forecast page
address** (see Settings → Report) if you saved one.

## Install (one time, about 2 minutes)

1. Copy the **`synxis-forecast-downloader`** folder to your PC
   (for example `C:\Tools\synxis-forecast-downloader`). Don't delete it later,
   because Chrome loads the extension from this folder.
2. In Chrome open **`chrome://extensions`**.
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and select the `synxis-forecast-downloader` folder.
5. Click the puzzle icon in the toolbar and **pin** "SynXis Forecast Auto Downloader".
6. Log in to SynXis in this same Chrome profile (select the right hotel).
7. Click the extension icon → **Download Forecast now** to test it. Your SynXis
   tab does everything by itself; the report pop-up opens and closes. The popup
   shows where the file was saved.

**Updating to a new version:** replace the files in the folder, then click the
reload (↻) button on the extension in `chrome://extensions`.

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
| Home > SPH Dashboard first | On | Turn off if your SynXis has no SPH Dashboard under Home |
| Forecast page address (backup) | empty | Open the Forecast report in SynXis, then click **Remember from open SynXis tab** |

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

- **Settings → Activity log** shows every step of every run. A red **!** on the
  extension icon means the last run failed.
- **Copy debug info** (Settings → Activity log) collects what the extension can
  see on the open SynXis tab (menu items, frames, dropdowns, last error, log).
  Keep SynXis open, click it, and send the copied text. It contains no
  passwords.
- Turn on **Leave the report pop-up / new SynXis tab open when a run fails** to
  see exactly where it stopped.
- *"Report window did not open"*: the extension allows pop-ups for SynXis
  automatically. If it still happens, allow pop-ups for
  `controlcenter-p2.synxis.com` in Chrome's site settings.
- *"Could not open the Forecast report page"*: open the Forecast report by hand,
  click **Remember from open SynXis tab** in Settings, and send the debug info.
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
