# SynXis Forecast Auto Downloader (Chrome extension)

Two things in one extension:

1. **Forecast download** – downloads the **SynXis Property Hub → Front Office →
   Forecast** report with **Date Range = Next Year** as a **CSV** file into a
   folder you choose: once a day by itself, or when you click
   **Download Forecast now**.
2. **Auto refresh** – after the number of seconds you set without
   mouse/keyboard activity, either refreshes the tab of the website you entered
   or clicks SynXis "Home" twice, and answers the SynXis pop-ups for you. The
   extension icon counts down the seconds left.

**Click the extension icon: Settings open in its pop-up** (no new tab). Nothing
is downloaded by the click; the download starts only from the
**▶ Download Forecast now** button (or right-click the icon →
*Download Forecast now*).

## Forecast download

What it does, step by step, just like you would by hand, and you can watch it
happen (each button gets an orange outline just before it is clicked, and a
banner at the bottom of the page shows the current step):

1. Uses the **SynXis tab you already have open** (it opens a new tab only if no
   SynXis tab is open, and closes that tab again at the end)
2. If **"You do not have a Bank open – Would you like to open a Bank?"** shows
   up, clicks **NO**
3. **Reports** (top menu) → in the menu's list *Reports / Subscriptions /
   SynXis Property Hub (SPH)* clicks the 3rd one, **SynXis Property Hub (SPH)**
   (never the "SynXis Property Hub 4.30.0.0" version text in the page footer)
   → **Forecast**
4. **Date Range** dropdown → **Next Year**
5. **GENERATE REPORT**
6. In the report pop-up: **Export → CSV (comma delimited)**
7. Saves the file as `Downloads\SynXis Forecast\Forecast_NextYear_2026-10-18.csv`
8. Closes the report pop-up. Your SynXis tab stays open on the Forecast page.

### Daily automatic download

Once a day, **any time between 12:00 AM and 11:00 AM**, as soon as

- a SynXis tab is open and logged in, and
- nobody has moved the mouse or typed for **90 seconds** (whole computer),

the download runs by itself. If it fails it tries again after 20 minutes, up to
3 times that day. Window, seconds and tries can be changed in Settings. It keeps
working after Chrome or the computer restarts (see *Keep it working every day*).

## Auto refresh

In Settings → **Auto refresh**: turn it on, enter the website address (for
example `https://controlcenter-p2.synxis.com/CC/default.aspx`), the seconds,
and what should happen. Add more websites with **+ Add website**.

Two kinds, chosen per website:

- **Refresh the page** – the tab is reloaded and stays on the same page.
- **Click "Home" twice (2 s apart)** – the 1st click opens the
  *CRS Dashboard / SPH Dashboard* menu, the 2nd click 2 seconds later goes
  Home. The page is not reloaded; it just shows activity on the screen. (If a
  page has no "Home", it is refreshed instead.)

For both:

- It happens when nobody has moved the mouse or typed for that many seconds,
  and again every that many seconds while nobody is there. Any real mouse
  movement or key press starts the count again.
- The **extension icon shows the seconds left** (e.g. `45`, or `17m` for long
  waits).
- Only the tab of the address you entered is used.
- Never during a Forecast download.
- SynXis pop-ups: **"You do not have a Bank open"** → **NO** (right after an
  auto refresh nobody has touched, or when nobody is using the page, so you can
  still click YES yourself), **"Your session is about to expire"** →
  **KEEP SESSION ACTIVE**.
- **Keep the screen on**: the screen stays on and the computer does not go to
  sleep while Chrome runs.
- Websites other than SynXis ask for Chrome's permission once, when you save.

## Install (one time, about 2 minutes)

1. Copy the **`synxis-forecast-downloader`** folder to your PC
   (for example `C:\Tools\synxis-forecast-downloader`). Don't delete it later,
   because Chrome loads the extension from this folder.
2. In Chrome open **`chrome://extensions`**.
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and select the `synxis-forecast-downloader` folder.
5. Click the puzzle icon in the toolbar and **pin** "SynXis Forecast Auto Downloader".
6. Log in to SynXis in this same Chrome profile (select the right hotel).
7. Click the extension icon → Settings open in the pop-up →
   **▶ Download Forecast now** to test it.

**Updating to a new version:** replace the files in the folder, then click the
reload (↻) button on the extension in `chrome://extensions`.

## Settings

| Setting | Default | Notes |
| --- | --- | --- |
| Daily automatic download | On | Once a day |
| Time window | 12:00 AM – 11:00 AM | Start must be before end |
| Start after no activity for | 90 sec | Whole computer: no mouse/keyboard |
| Tries per day / minutes between tries | 3 / 20 | |
| Download later if the window was missed | Off | Still waits for inactivity |
| Folder (inside Downloads) | `SynXis Forecast` | Any name; `/` for sub-folders, e.g. `Hotel Reports/Forecast` |
| File name | `Forecast_{range}_{date}` | Tokens: `{date}` `{time}` `{range}` `{YYYY}` `{MM}` `{DD}` `{HH}` `{mm}` |
| If file exists | Keep both | Or **Replace** (e.g. file name `Forecast_latest` + Replace = always one up-to-date file) |
| Auto refresh | Off | Website + seconds (at least 15) + *Refresh the page* or *Click "Home" twice* |
| SynXis pop-ups | On | Bank → NO, session → KEEP SESSION ACTIVE |
| Keep the screen on | On | |
| Date Range | Next Year | Any value from the SynXis dropdown |
| Forecast page address (backup) | empty | Open the Forecast report in SynXis, then click **Remember from open SynXis tab** |

### Saving on another drive (e.g. `D:\Reports`)

Chrome only allows extensions to save **inside the Downloads folder**. To save
somewhere else, change Chrome's download location
(**chrome://settings/downloads → Location → Change**, there is a button for it
in Settings). The extension's folder is then created inside that location.

## Keep it working every day, even after a restart

1. Turn on *"Continue running background apps when Google Chrome is closed"* in
   **chrome://settings/system**. Chrome then starts by itself when the computer
   starts and keeps running in the background.
2. Set **chrome://settings/onStartup → "Continue where you left off"** so the
   SynXis tab opens again after a restart.
3. Stay **logged in to SynXis** in this Chrome profile. Auto refresh with
   *KEEP SESSION ACTIVE* helps the session stay alive. If SynXis logs you out,
   the daily download waits until you log in again (it shows in the log).

## Troubleshooting

- **Settings → Activity log** shows every step of every run. A red **!** on the
  extension icon means the last run failed.
- **Copy debug info** (Settings → Activity log) collects what the extension can
  see on the open SynXis tab (menu items, frames, dropdowns, last error, log).
  Keep SynXis open, click it, and send the copied text. It contains no
  passwords.
- Turn on **Leave the report pop-up / new SynXis tab open when a download
  fails** to see exactly where it stopped.
- *"Report window did not open"*: the extension allows pop-ups for SynXis
  automatically. If it still happens, allow pop-ups for
  `controlcenter-p2.synxis.com` in Chrome's site settings.
- *"Could not open the Forecast report page"*: open the Forecast report by hand,
  click **Remember from open SynXis tab** in Settings, and send the debug info.

## Project layout

```
synxis-forecast-downloader/   the extension (load this folder in Chrome)
  manifest.json               permissions, background worker, Settings page
  background.js               daily download, auto refresh, and the step-by-step run
  page-agent.js               code run inside the SynXis pages for the download
  content-autorefresh.js      in-page part of auto refresh and the pop-up answers
  common.js                   settings, schedule, auto-refresh and file-name helpers
  options.*                   the Settings page (also the toolbar icon's pop-up)
dev-test/                     tests (not needed to use the extension)
  common.test.mjs             unit tests:  node --test dev-test/common.test.mjs
  mock-synxis/server.mjs      a fake SynXis site with the same menus, pop-ups and report pop-up
  e2e.mjs                     loads the extension in Chromium against the fake site:
                              node dev-test/e2e.mjs [path-to-chrome]
```
