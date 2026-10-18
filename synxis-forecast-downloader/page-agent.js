// Functions injected into SynXis pages with chrome.scripting.executeScript.
// Each exported function is serialized on its own, so everything it needs must
// live inside the function body (no imports, no outer helpers).

/**
 * Runs in the content-script (isolated) world of one frame.
 * @param {string} cmd  scan | act | reportScan | fetchExport | clickCsv | diagnose
 * @param {object} args command arguments
 */
export function pageAgent(cmd, args) {
  args = args || {};
  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'OPTION', 'SELECT', 'TITLE', 'svg', 'SVG', 'path']);
  const CLICKABLE =
    'a,button,[role="button"],[role="menuitem"],[role="tab"],[role="link"],[role="option"],[role="treeitem"],[onclick],input[type="button"],input[type="submit"],summary';

  // Modern SynXis (Aven) screens are built from web components, so menus can sit
  // inside shadow roots. Content scripts may open closed ones via chrome.dom.
  function shadowOf(el) {
    try {
      if (typeof chrome !== 'undefined' && chrome.dom && chrome.dom.openOrClosedShadowRoot) {
        return chrome.dom.openOrClosedShadowRoot(el);
      }
    } catch (e) {
      /* not a shadow host */
    }
    return el.shadowRoot || null;
  }
  const parentOf = (n) => n.parentElement || (n.parentNode && n.parentNode.host) || null;
  const BANNER_ID = 'sfd-banner';
  const inShadow = (el) => el.getRootNode() !== document;

  // Every element of the frame, including those inside shadow roots.
  let allCache = null;
  let shadowRoots = 0;
  function allElements() {
    if (allCache) return allCache;
    allCache = [];
    const stack = [document.body || document.documentElement];
    while (stack.length) {
      for (const el of stack.pop().querySelectorAll('*')) {
        if (el.id === BANNER_ID || (el.parentElement && el.parentElement.id === BANNER_ID)) continue;
        allCache.push(el);
        const root = shadowOf(el);
        if (root) {
          shadowRoots++;
          stack.push(root);
        }
      }
    }
    return allCache;
  }
  const deepQueryAll = (selector) => allElements().filter((el) => el.matches(selector));
  function deepContains(ancestor, node) {
    for (let n = node; n; n = parentOf(n)) if (n === ancestor) return true;
    return false;
  }

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    if (!el.getClientRects().length) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    if (r.right < -1000 || r.bottom < -1000) return false;
    for (let n = el; n && n.nodeType === 1; n = parentOf(n)) {
      const cs = getComputedStyle(n);
      if (cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse') return false;
      if (parseFloat(cs.opacity) === 0) return false;
    }
    return true;
  }

  // Elements with short text, normalized once per call.
  let cache = null;
  function textElements() {
    if (cache) return cache;
    cache = [];
    for (const el of allElements()) {
      if (SKIP.has(el.tagName)) continue;
      let raw;
      if (el.tagName === 'INPUT') {
        raw = el.type === 'button' || el.type === 'submit' ? el.value : '';
      } else {
        raw = el.textContent;
        if (!norm(raw) && el.matches(CLICKABLE)) raw = el.getAttribute('aria-label') || el.title || '';
      }
      if (!raw || raw.length > 150) continue;
      const t = norm(raw);
      if (t) cache.push({ el, t });
    }
    return cache;
  }

  // Deepest elements whose text satisfies pred (skips wrappers around a match).
  function findText(pred, { visibleOnly = true } = {}) {
    const matched = textElements().filter((x) => pred(x.t, x.el));
    const set = new Set(matched.map((x) => x.el));
    return matched
      .filter((x) => ![...x.el.children].some((c) => set.has(c)))
      .map((x) => x.el)
      .filter((el) => !visibleOnly || isVisible(el));
  }

  function clickTarget(el) {
    let n = el;
    for (let i = 0; i < 4 && n; i++, n = parentOf(n)) {
      if (n.matches && n.matches(CLICKABLE)) return n;
    }
    // Text rendered by a web component: click the real link/button inside it.
    const root = shadowOf(el);
    return (root && root.querySelector(CLICKABLE)) || el;
  }

  const inHeading = (el) => !!el.closest('h1,h2,h3,h4,h5,h6');
  const inBreadcrumb = (el) =>
    !!el.closest('[class*="breadcrumb" i],[id*="breadcrumb" i],[aria-label*="breadcrumb" i]');

  function fire(el, type) {
    const r = el.getBoundingClientRect();
    const init = {
      bubbles: !type.endsWith('enter'),
      composed: true, // let the event leave shadow roots, like a real mouse event
      cancelable: true,
      view: window,
      clientX: r.left + r.width / 2,
      clientY: r.top + r.height / 2,
      button: 0,
    };
    const Ctor = type.startsWith('pointer') && typeof PointerEvent === 'function' ? PointerEvent : MouseEvent;
    el.dispatchEvent(new Ctor(type, init));
  }
  function hover(el) {
    for (const t of ['pointerover', 'mouseover', 'pointermove', 'mousemove']) fire(el, t);
    // A real pointer "enters" every ancestor too; hover menus often listen there.
    for (let n = el, i = 0; n && i < 6; n = parentOf(n), i++) {
      fire(n, 'pointerenter');
      fire(n, 'mouseenter');
    }
  }
  function click(el) {
    hover(el);
    fire(el, 'pointerdown');
    fire(el, 'mousedown');
    try {
      el.focus({ preventScroll: true });
    } catch (e) {
      /* not focusable */
    }
    fire(el, 'pointerup');
    fire(el, 'mouseup');
    el.click();
  }

  // ----- what the user sees on screen -----

  const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

  // Orange outline on the element, a short pause so the user can follow, then the click.
  async function showAndClick(el, { hoverOnly = false, pause = 700 } = {}) {
    const before = [el.style.outline, el.style.outlineOffset];
    if (isVisible(el)) {
      const r = el.getBoundingClientRect();
      if (r.top < 0 || r.bottom > innerHeight) el.scrollIntoView({ block: 'center' });
      el.style.outline = '3px solid #ff6a00';
      el.style.outlineOffset = '2px';
      await sleepMs(pause);
    }
    if (hoverOnly) hover(el);
    else click(el);
    setTimeout(() => {
      el.style.outline = before[0];
      el.style.outlineOffset = before[1];
    }, 1200);
  }

  // Status banner at the bottom of the page (ignored by every search above).
  function banner() {
    let box = document.getElementById(BANNER_ID);
    clearTimeout(window.__sfdBannerTimer);
    if (args.state === 'remove') {
      if (box) box.remove();
      return { ok: true };
    }
    if (!box) {
      box = document.createElement('div');
      box.id = BANNER_ID;
      box.setAttribute(
        'style',
        'position:fixed;z-index:2147483647;left:50%;bottom:24px;transform:translateX(-50%);max-width:80vw;' +
          'padding:12px 20px;border-radius:10px;font:600 15px/1.4 "Segoe UI",system-ui,sans-serif;color:#fff;' +
          'box-shadow:0 6px 24px rgba(0,0,0,.35);pointer-events:none;white-space:pre-wrap',
      );
      (document.body || document.documentElement).appendChild(box);
    }
    box.style.background = args.state === 'ok' ? '#188038' : args.state === 'err' ? '#d93025' : '#0f7c8c';
    box.textContent = `Forecast Downloader: ${args.text}`;
    if (args.hideAfterMs) window.__sfdBannerTimer = setTimeout(() => box.remove(), args.hideAfterMs);
    return { ok: true };
  }

  // ----- Control Center navigation -----

  function hasLoginForm() {
    return deepQueryAll('input[type="password"]').some(isVisible);
  }

  // "You do not have a Bank open. Would you like to open a Bank?"  ->  its NO button
  function bankPopupNo() {
    const msg = findText((t) => t.includes('do not have a bank open') || t.includes('like to open a bank'))[0];
    if (!msg) return null;
    const noButtons = findText((t) => t === 'no');
    for (let n = parentOf(msg), i = 0; n && i < 10; n = parentOf(n), i++) {
      const no = noButtons.find((b) => deepContains(n, b));
      if (no) return clickTarget(no);
    }
    return null;
  }

  function dateRangeLabelled(sel) {
    for (let n = parentOf(sel), i = 0; n && i < 4; n = parentOf(n), i++) {
      const t = norm(n.textContent.replace(sel.textContent, ''));
      if (t.length > 400) break;
      if (t.includes('date range')) return true;
    }
    return false;
  }

  // The Forecast page's Date Range dropdown: on screen and offering the wanted range.
  // (Hidden dropdowns elsewhere, e.g. on the dashboard, may also offer "Next Year".)
  function rangeSelect(range) {
    const want = norm(range);
    const selects = deepQueryAll('select').filter(
      (s) => isVisible(s) && [...s.options].some((o) => norm(o.text) === want),
    );
    return selects.find(dateRangeLabelled) || selects[0] || null;
  }

  const usable = (el) => !inHeading(el) && !inBreadcrumb(el);
  const byTop = (els) => els.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);

  // Top navigation item ("Home", "Reports"): the highest one on the page.
  function topNav(word, visibleOnly) {
    return byTop(findText((t) => t === word, { visibleOnly }).filter(usable));
  }

  function sphDashboardLinks() {
    return findText(
      (t) => t.length < 60 && t.includes('dashboard') && (/\bsph\b/.test(t) || t.includes('property hub')),
    ).filter(usable);
  }

  function forecastLinks(visibleOnly) {
    const els = findText((t) => t === 'forecast', { visibleOnly }).filter(usable);
    // "Strong" = the Forecast link sitting in the SPH Front Office list, next to
    // "Forecast By Market Segment" / "Forecast By Rate Plan". The shared parent must
    // not hold another "Forecast" link, so a Forecast in a different menu section
    // never borrows these neighbours.
    const neighbours = findText((t) => t === 'forecast by rate plan' || t === 'forecast by market segment', {
      visibleOnly,
    });
    const strong = els.filter((el) => {
      let n = parentOf(el);
      for (let i = 0; i < 6 && n; i++, n = parentOf(n)) {
        if (els.some((other) => other !== el && deepContains(n, other))) return false;
        if (neighbours.some((x) => deepContains(n, x))) return true;
      }
      return false;
    });
    return { strong, weak: els };
  }

  function sphLinks(visibleOnly) {
    return findText((t) => t.startsWith('synxis property hub') && t.length < 60, { visibleOnly }).filter(usable);
  }

  function generateButtons() {
    return findText((t) => t === 'generate report' || t === 'generate');
  }

  function scan() {
    const hidden = !!args.allowHidden;
    const sel = rangeSelect(args.range);
    const fc = forecastLinks(!hidden);
    return {
      url: location.href,
      loginForm: hasLoginForm(),
      bankPopup: !!bankPopupNo(),
      rangeSelect: !!sel,
      rangeLabelled: !!sel && dateRangeLabelled(sel),
      rangeSelected: sel && sel.selectedIndex >= 0 ? sel.options[sel.selectedIndex].text.trim() : null,
      rangeOptions: sel ? [...sel.options].map((o) => o.text.trim()) : null,
      generateBtn: generateButtons().length > 0,
      homeNav: topNav('home', true).length > 0,
      sphDashboard: sphDashboardLinks().length > 0,
      forecastStrong: fc.strong.length > 0,
      forecastWeak: fc.weak.length > 0,
      sphLink: sphLinks(!hidden).length > 0,
      reportsNav: topNav('reports', !hidden).length > 0,
    };
  }

  async function act() {
    const hidden = !!args.allowHidden;
    const run = async (el, missing, opts) => {
      if (!el) return { ok: false, error: `${missing} not found` };
      await showAndClick(el, opts);
      return { ok: true };
    };
    switch (args.action) {
      case 'dismissBank':
        return run(bankPopupNo(), '"NO" button of the Bank pop-up', { pause: 500 });
      case 'openHome': {
        const el = topNav('home', true)[0];
        return run(el && clickTarget(el), 'Home menu', { hoverOnly: !args.click });
      }
      case 'clickSphDashboard': {
        const el = sphDashboardLinks()[0];
        return run(el && clickTarget(el), 'SPH Dashboard');
      }
      case 'openReports': {
        const el = topNav('reports', !hidden)[0];
        return run(el && clickTarget(el), 'Reports menu', { hoverOnly: !args.click });
      }
      case 'clickSPH': {
        const el = sphLinks(!hidden)[0];
        return run(el && clickTarget(el), 'SynXis Property Hub (SPH)');
      }
      case 'clickForecast': {
        const fc = forecastLinks(!hidden);
        const el = (args.strongOnly ? fc.strong : fc.strong.concat(fc.weak))[0];
        return run(el && clickTarget(el), 'Forecast link');
      }
      case 'clickGenerate': {
        const el = generateButtons()[0];
        return run(el && clickTarget(el), 'Generate Report button', { pause: 900 });
      }
      case 'selectRange': {
        const sel = rangeSelect(args.range);
        if (!sel) return { ok: false, error: 'Date Range dropdown not found' };
        const opt = [...sel.options].find((o) => norm(o.text) === norm(args.range));
        if (!opt) return { ok: false, error: `"${args.range}" is not in the Date Range dropdown` };
        const before = sel.style.outline;
        sel.style.outline = '3px solid #ff6a00';
        try {
          sel.focus();
        } catch (e) {
          /* ignore */
        }
        await sleepMs(700);
        const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
        setter.call(sel, opt.value);
        sel.selectedIndex = opt.index;
        opt.selected = true;
        sel.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        // No waiting here: the change may reload the page (post-back) right away.
        setTimeout(() => {
          sel.style.outline = before;
        }, 800);
        return { ok: true };
      }
      case 'showExport': {
        // Purely visual: open the report's Export menu and point at "CSV".
        const btn = deepQueryAll('[title="Export" i],[alt="Export" i],[aria-label="Export" i]').find(isVisible);
        if (btn) await showAndClick(clickTarget(btn), { pause: 600 });
        await sleepMs(400);
        const csv = findText((t) => t.startsWith('csv (comma delimited)'))[0];
        if (csv) {
          const before = csv.style.outline;
          csv.style.outline = '3px solid #ff6a00';
          await sleepMs(1200);
          csv.style.outline = before;
        }
        return { ok: true, menu: !!btn, csv: !!csv };
      }
      default:
        return { ok: false, error: `Unknown action ${args.action}` };
    }
  }

  // ----- Report viewer window -----

  function exportUrlFromHtml() {
    const m = /"ExportUrlBase"\s*:\s*"((?:[^"\\]|\\.)+)"/.exec(document.documentElement.innerHTML);
    if (!m) return null;
    try {
      return JSON.parse(`"${m[1]}"`);
    } catch (e) {
      return null;
    }
  }

  function csvLink() {
    const byHandler = deepQueryAll('[onclick]').find((el) =>
      /exportReport\(\s*['"]CSV['"]\s*\)/i.test(el.getAttribute('onclick') || ''),
    );
    if (byHandler) return byHandler;
    return findText((t) => t.startsWith('csv (comma delimited)') || t === 'csv', { visibleOnly: false })[0] || null;
  }

  function reportScan() {
    const own = document.getElementById(BANNER_ID);
    const raw = document.body ? document.body.innerText.slice(0, 30000) : '';
    const text = norm(own ? raw.replace(own.innerText, '') : raw);
    const loading = findText((t) => t === 'loading...' || t === 'loading', { visibleOnly: true }).length > 0;
    const err = /(an error (has )?occurred[^.]*report processing[^.]*\.?|report processing error[^.]*)/.exec(text);
    return {
      url: location.href,
      loginForm: hasLoginForm(),
      isReportViewer:
        /reportviewer/i.test(location.href) || !!document.querySelector('[id*="ReportViewer" i],[class*="ReportViewer" i]'),
      reportTitle: text.includes('forecast report'),
      loadingVisible: loading,
      csvLink: !!csvLink(),
      exportUrlFromHtml: exportUrlFromHtml(),
      errorText: err ? err[0].slice(0, 200) : null,
    };
  }

  async function fetchExport() {
    let res;
    try {
      res = await fetch(args.url, { credentials: 'include', cache: 'no-store' });
    } catch (e) {
      return { ok: false, error: `Download request failed: ${e && e.message ? e.message : e}` };
    }
    if (!res.ok) return { ok: false, error: `Server answered HTTP ${res.status}` };
    const contentType = res.headers.get('content-type') || '';
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (!bytes.length) return { ok: false, error: 'Server returned an empty file' };

    let encoding = 'utf-8';
    if (bytes[0] === 0xff && bytes[1] === 0xfe) encoding = 'utf-16le';
    else if (bytes[0] === 0xfe && bytes[1] === 0xff) encoding = 'utf-16be';
    const text = new TextDecoder(encoding).decode(bytes).replace(/^﻿/, '');
    const head = text.trimStart().slice(0, 300);
    if (/text\/html/i.test(contentType) || /^<(!doctype|html|head|body|\?xml)/i.test(head)) {
      return {
        ok: false,
        error: 'Server returned a web page instead of the CSV (session may have expired)',
        preview: head.slice(0, 150),
      };
    }

    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return {
      ok: true,
      b64: btoa(bin),
      size: bytes.length,
      encoding,
      contentType,
      lines: text.split(/\r\n|\n|\r/).filter((l) => l.trim()).length,
      preview: head.slice(0, 120),
    };
  }

  // Summary of what the extension can see in this frame, for troubleshooting.
  function describe(el) {
    const parts = [];
    for (let n = el, i = 0; n && n.tagName && i < 6; n = parentOf(n), i++) {
      let p = n.tagName.toLowerCase();
      if (n.id) p += `#${n.id}`;
      const cls = typeof n.className === 'string' ? n.className.trim().split(/\s+/).slice(0, 3).join('.') : '';
      if (cls) p += `.${cls}`;
      if (n.getAttribute('role')) p += `[role=${n.getAttribute('role')}]`;
      parts.push(p);
    }
    return parts.join(' < ');
  }

  function diagnose() {
    const keys = {
      reports: (t) => t === 'reports',
      sph: (t) => t.startsWith('synxis property hub'),
      forecast: (t) => t === 'forecast',
      forecastBy: (t) => t.startsWith('forecast by'),
      generate: (t) => t === 'generate report' || t === 'generate',
      dateRange: (t) => t.startsWith('date range'),
    };
    const hits = {};
    for (const [key, pred] of Object.entries(keys)) {
      hits[key] = findText(pred, { visibleOnly: false })
        .slice(0, 6)
        .map((el) => ({
          visible: isVisible(el),
          shadow: inShadow(el),
          path: describe(el),
          clicks: describe(clickTarget(el)).split(' < ')[0],
          html: el.outerHTML.replace(/\s+/g, ' ').slice(0, 240),
        }));
    }
    const clickables = allElements()
      .filter((el) => el.matches(CLICKABLE) && !el.closest('table') && isVisible(el)) // menus, not guest lists
      .map((el) => norm(el.textContent || el.getAttribute('aria-label') || el.title).slice(0, 40))
      .filter(Boolean);
    return {
      url: location.href,
      title: document.title,
      readyState: document.readyState,
      elements: allElements().length,
      shadowRoots,
      closedShadowApi: !!(typeof chrome !== 'undefined' && chrome.dom && chrome.dom.openOrClosedShadowRoot),
      frames: deepQueryAll('iframe,frame')
        .map((f) => f.src || f.getAttribute('src') || '(no src)')
        .slice(0, 15),
      selects: deepQueryAll('select')
        .slice(0, 10)
        .map((s) => ({
          id: s.id || s.name || '',
          visible: isVisible(s),
          options: [...s.options].slice(0, 15).map((o) => o.text.trim()),
        })),
      loginForm: hasLoginForm(),
      hits,
      clickables: [...new Set(clickables)].slice(0, 80),
    };
  }

  switch (cmd) {
    case 'banner':
      return banner();
    case 'diagnose':
      return diagnose();
    case 'scan':
      return scan();
    case 'act':
      return act();
    case 'reportScan':
      return reportScan();
    case 'fetchExport':
      return fetchExport();
    case 'clickCsv': {
      const el = csvLink();
      if (!el) return { ok: false, error: 'CSV export link not found' };
      el.click();
      return { ok: true };
    }
    default:
      return { error: `Unknown command ${cmd}` };
  }
}

/**
 * Runs in the page's MAIN world so it can reach the ASP.NET ReportViewer client
 * object and read the export URL it uses for "Export > CSV".
 */
export function mainWorldViewerInfo() {
  const out = { found: false, frameUrl: location.href };
  try {
    const app = window.Sys && window.Sys.Application;
    if (app && typeof app.getComponents === 'function') {
      for (const c of app.getComponents()) {
        if (!c || typeof c.exportReport !== 'function') continue;
        out.found = true;
        try {
          if (typeof c.get_isLoading === 'function') out.loading = !!c.get_isLoading();
        } catch (e) {
          /* older viewer */
        }
        try {
          const iv = typeof c._getInternalViewer === 'function' ? c._getInternalViewer() : null;
          if (iv && typeof iv.ExportUrlBase === 'string') out.exportUrlBase = iv.ExportUrlBase;
        } catch (e) {
          /* older viewer */
        }
        break;
      }
    }
  } catch (e) {
    out.error = String((e && e.message) || e);
  }
  return out;
}
