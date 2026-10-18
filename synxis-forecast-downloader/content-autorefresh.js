// Runs in the tabs of the auto-refresh sites and in SynXis tabs (all frames).
//  - Auto refresh (top frame): after N seconds without mouse/keyboard input the
//    background reloads this tab (it also checks the whole computer was idle).
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
  let lastActivity = Date.now();
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

  // ---------- auto refresh ----------

  function arm(ms) {
    clearTimeout(timer);
    timer = null;
    if (isTop && config.refreshSeconds) timer = setTimeout(fire, ms);
  }

  async function fire() {
    const waitMs = config.refreshSeconds * 1000 - (Date.now() - lastActivity);
    if (waitMs > 0) return arm(waitMs);
    const res = await send({ type: 'refreshDue' });
    if (res && res.retryMs) arm(res.retryMs);
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
    } else if (Date.now() - lastForward > 2000) {
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
    } else if (msg.type === 'idleFor' && isTop) {
      // Asked by the background every 30 s (timers in background tabs run late).
      sendResponse({ ms: Date.now() - lastActivity });
    }
  });

  async function loadConfig() {
    const c = await send({ type: 'tabConfig' });
    if (!c) return;
    config = c;
    arm((config.refreshSeconds || 0) * 1000);
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.settings) loadConfig();
  });

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
    // Only answer for the user right after an auto refresh or when nobody is using the page,
    // so someone working at the desk can still choose YES.
    if (bank && (Date.now() < config.answerBankUntil || Date.now() - lastActivity > 30000)) answer('bank', bank, 'NO');
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
