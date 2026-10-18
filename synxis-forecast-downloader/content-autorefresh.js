// Runs in the tabs of the auto-refresh sites and in SynXis tabs (all frames).
//  - Auto refresh (top frame): after N seconds without mouse/keyboard input the
//    tab is reloaded, or "Home" is clicked twice 2 s apart (the background also
//    checks the whole computer was idle). The seconds left go to the icon badge.
//  - SynXis pop-ups: "You do not have a Bank open" -> NO (right after an auto
//    refresh, or when nobody is using the page), "Your session is about to
//    expire" -> KEEP SESSION ACTIVE.
(() => {
  if (window.__sfdContent) return;
  window.__sfdContent = true;

  const isTop = window.top === window;
  const BANNER_ID = 'sfd-banner';
  let config = { refreshSeconds: null, guard: false, answerBankUntil: 0 };
  let timer = null;
  const loadedAt = Date.now();
  let lastActivity = loadedAt; // last real mouse/keyboard input
  let lastAction = 0; // last time this script clicked "Home"
  let lastSentDue = 0;
  let lastForward = 0;
  let lastPointer = '';
  const lastAnswer = {};

  const send = async (msg) => {
    try {
      return await chrome.runtime.sendMessage(msg);
    } catch (e) {
      return null; // extension was reloaded or updated
    }
  };
  const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---------- auto refresh ----------

  const dueAt = () => Math.max(lastActivity, lastAction) + config.refreshSeconds * 1000;

  // Tell the background when the next refresh is due (shown on the icon).
  function reportCountdown() {
    if (!isTop) return;
    const due = config.refreshSeconds ? dueAt() : null;
    if (due === lastSentDue || (due && lastSentDue && Math.abs(due - lastSentDue) < 1000)) return;
    lastSentDue = due;
    send({ type: 'countdown', dueAt: due });
  }

  function arm(ms) {
    clearTimeout(timer);
    timer = null;
    if (isTop && config.refreshSeconds) timer = setTimeout(fire, Math.max(0, ms));
    reportCountdown();
  }

  async function fire() {
    const waitMs = dueAt() - Date.now();
    if (waitMs > 0) return arm(waitMs);
    const res = await send({ type: 'refreshDue' });
    if (!res) return;
    if (res.action === 'clickHome') {
      if (!(await clickHomeTwice())) send({ type: 'reloadMe' }); // no "Home" on this page
      return arm(config.refreshSeconds * 1000);
    }
    if (res.retryMs) arm(res.retryMs);
  }

  function onActivity(e) {
    if (!e.isTrusted) return; // only real mouse/keyboard input, not scripted clicks
    if (e.type === 'mousemove') {
      // Chrome also sends mousemove when the page changes under a resting cursor;
      // only count it when the pointer really moved.
      const pos = `${e.screenX},${e.screenY}`;
      if (pos === lastPointer) return;
      lastPointer = pos;
    }
    lastActivity = Date.now();
    if (isTop) {
      if (!timer && config.refreshSeconds) arm(config.refreshSeconds * 1000);
      reportCountdown();
    } else if (Date.now() - lastForward > 1000) {
      lastForward = Date.now();
      send({ type: 'activity' }); // tell the top frame of this tab
    }
  }

  for (const type of ['mousemove', 'mousedown', 'keydown', 'wheel', 'touchstart']) {
    window.addEventListener(type, onActivity, { capture: true, passive: true });
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg) return;
    if (msg.type === 'activity') {
      lastActivity = Date.now();
      if (!timer && config.refreshSeconds) arm(config.refreshSeconds * 1000);
      reportCountdown();
    } else if (msg.type === 'idleFor' && isTop) {
      // Asked by the background every 30 s (timers in background tabs run late).
      sendResponse({ ms: Date.now() - Math.max(lastActivity, lastAction) });
    } else if (msg.type === 'clickHome' && isTop) {
      clickHomeTwice().then((ok) => {
        arm(config.refreshSeconds * 1000);
        sendResponse({ ok });
      });
      return true;
    }
  });

  async function loadConfig() {
    const c = await send({ type: 'tabConfig' });
    if (!c) return;
    config = c;
    arm(config.refreshSeconds ? dueAt() - Date.now() : 0);
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.settings) loadConfig();
  });

  // ---------- "Home" clicks (keeps SynXis active without reloading) ----------

  // The top-navigation "Home" item: visible, exact text, highest on the page.
  function findHome() {
    const found = [];
    for (const t of textNodes()) {
      const el = t.parentElement;
      if (el && norm(t.nodeValue) === 'home' && !el.closest('h1,h2,h3,h4,h5,h6') && isVisible(el)) found.push(el);
    }
    found.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
    let el = found[0];
    for (let n = el, i = 0; n && i < 4; n = parentOf(n), i++) {
      if (n.matches && n.matches('a,button,[role="button"],[role="menuitem"],[role="tab"],[onclick]')) return n;
    }
    return el || null;
  }

  function clickElement(el) {
    const r = el.getBoundingClientRect();
    const init = { bubbles: true, composed: true, cancelable: true, view: window, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
    for (const type of ['pointerover', 'mouseover', 'pointerdown', 'mousedown', 'pointerup', 'mouseup']) {
      el.dispatchEvent(new (type.startsWith('pointer') && window.PointerEvent ? PointerEvent : MouseEvent)(type, init));
    }
    el.click();
  }

  let clicking = false;
  async function clickHomeTwice() {
    if (clicking || Date.now() - lastAction < 5000) return true; // already done just now
    const home = findHome();
    if (!home) return false;
    clicking = true;
    try {
      clickElement(home); // 1st click opens the CRS / SPH Dashboard menu
      await sleepMs(2000);
      clickElement(findHome() || home); // 2nd click goes to Home
      lastAction = Date.now();
      return true;
    } finally {
      clicking = false;
    }
  }

  // ---------- SynXis pop-ups ----------

  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const parentOf = (n) => n.parentElement || (n.parentNode && n.parentNode.host) || null;
  const shadowOf = (el) => {
    try {
      if (chrome.dom && chrome.dom.openOrClosedShadowRoot) return chrome.dom.openOrClosedShadowRoot(el);
    } catch (e) {
      /* not a shadow host */
    }
    return el.shadowRoot || null;
  };

  function isVisible(el) {
    if (!el || !el.isConnected || !el.getClientRects().length) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    for (let n = el; n && n.nodeType === 1; n = parentOf(n)) {
      const cs = getComputedStyle(n);
      if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0) return false;
    }
    return true;
  }

  // Text nodes of the document and of every shadow root.
  function* textNodes() {
    const roots = [document];
    for (let i = 0; i < roots.length; i++) {
      const walker = document.createTreeWalker(roots[i], NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        if (n.nodeType === 3) yield n;
        else {
          if (n.id === BANNER_ID) continue;
          const sr = shadowOf(n);
          if (sr) roots.push(sr);
        }
      }
    }
  }

  function findMessage(pred) {
    for (const t of textNodes()) {
      const el = t.parentElement;
      if (el && pred(norm(t.nodeValue)) && isVisible(el)) return el;
    }
    return null;
  }

  function clickButtonNear(msgEl, label) {
    const want = norm(label);
    for (let n = parentOf(msgEl), i = 0; n && i < 10; n = parentOf(n), i++) {
      const root = n.querySelectorAll ? n : null;
      if (!root) continue;
      const btn = [...root.querySelectorAll('button,a,[role="button"],input[type="button"],input[type="submit"]')].find(
        (b) => norm(b.tagName === 'INPUT' ? b.value : b.textContent) === want && isVisible(b),
      );
      if (btn) {
        for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup']) {
          btn.dispatchEvent(new MouseEvent(type, { bubbles: true, composed: true, cancelable: true, view: window }));
        }
        btn.click();
        return true;
      }
    }
    return false;
  }

  function answer(kind, msgEl, label) {
    if (Date.now() - (lastAnswer[kind] || 0) < 3000) return;
    if (clickButtonNear(msgEl, label)) {
      lastAnswer[kind] = Date.now();
      send({ type: 'popupAnswered', kind });
    }
  }

  function guard() {
    if (!config.guard || !document.body) return;
    const bank = findMessage((t) => t.includes('do not have a bank open') || t.includes('like to open a bank'));
    // Answer for the user only right after an auto refresh that nobody has touched since,
    // or when nobody is using the page, so someone at the desk can still choose YES.
    const afterRefresh = Date.now() < config.answerBankUntil && lastActivity === loadedAt;
    if (bank && (afterRefresh || Date.now() - lastActivity > 30000)) answer('bank', bank, 'NO');
    const session = findMessage((t) => t.includes('session is about to expire'));
    if (session) answer('session', session, 'KEEP SESSION ACTIVE');
  }

  let guardQueued = false;
  const queueGuard = () => {
    if (guardQueued) return;
    guardQueued = true;
    setTimeout(() => {
      guardQueued = false;
      guard();
    }, 1500);
  };
  new MutationObserver(queueGuard).observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['style', 'class', 'hidden'],
  });
  setInterval(guard, 4000); // also catches dialogs inside shadow roots

  loadConfig().then(queueGuard);
})();
