/**
 * Injected into the app page (all frames) during debug sessions.
 * Shows a hover outline on interactive elements (buttons, links, inputs, etc.).
 *
 * Scroll/resize updates are rAF-coalesced (raw scroll can fire very fast and was
 * driving CPU/GPU). Starts disabled per frame; listeners attach only when enabled.
 * No CSS transitions
 * on the overlay (avoids extra compositing during frequent reposition).
 */

export function getInteractiveHighlightInitScript(): string {
  return `
(function() {
  var VERSION = 3;
  if (window.__uiplayHighlightV === VERSION) return;
  if (typeof window.__uiplayHighlightTeardown === 'function') {
    try { window.__uiplayHighlightTeardown(); } catch (e) {}
  }

  var INTERACTIVE_SEL =
    'button,select,textarea,input,a[href],area[href],' +
    '[role="button"],[role="link"],[role="tab"],[role="menuitem"],' +
    '[role="checkbox"],[role="radio"],[role="switch"],[role="searchbox"],' +
    '[contenteditable="true"]';

  function retargetInteractive(el) {
    if (!el || el.nodeType !== 1) return null;
    if (el.tagName === 'HTML' || el.tagName === 'BODY') return null;
    var hit = el.closest(INTERACTIVE_SEL);
    if (hit && hit.tagName === 'INPUT' && (hit.type || '').toLowerCase() === 'hidden') return null;
    return hit;
  }

  // Default off: each frame has its own window; __UPLAY_HL_ENABLED_GLOBAL is not inherited
  // from the parent, so "undefined" must mean idle — never attach pointermove/rAF until Node enables.
  var enabled = false;
  var lastTarget = null;
  var box = document.createElement('div');
  box.setAttribute('data-uiplay-highlight', '1');
  box.style.cssText =
    'position:fixed;pointer-events:none;z-index:2147483646;box-sizing:border-box;' +
    'border:2px solid rgba(34,197,94,0.95);border-radius:3px;background:rgba(34,197,94,0.08);' +
    'display:none';
  (document.documentElement || document.body).appendChild(box);

  function positionBox(el) {
    if (!el || !el.isConnected) {
      box.style.display = 'none';
      return;
    }
    var r = el.getBoundingClientRect();
    if (r.width < 1 && r.height < 1) {
      box.style.display = 'none';
      return;
    }
    box.style.display = 'block';
    box.style.left = r.left + 'px';
    box.style.top = r.top + 'px';
    box.style.width = r.width + 'px';
    box.style.height = r.height + 'px';
  }

  function hideBox() {
    lastTarget = null;
    box.style.display = 'none';
  }

  var moveRafPending = false;
  var lastPointerEvent = null;
  function onPointerMove(e) {
    if (!enabled) return;
    lastPointerEvent = e;
    if (moveRafPending) return;
    moveRafPending = true;
    requestAnimationFrame(function() {
      moveRafPending = false;
      if (!enabled) return;
      var ev = lastPointerEvent;
      if (!ev) return;
      var el = document.elementFromPoint(ev.clientX, ev.clientY);
      var t = retargetInteractive(el);
      if (!t) {
        hideBox();
        return;
      }
      lastTarget = t;
      positionBox(t);
    });
  }

  var scrollRafId = 0;
  function onScrollOrResize() {
    if (!enabled || !lastTarget) return;
    if (scrollRafId) return;
    scrollRafId = requestAnimationFrame(function() {
      scrollRafId = 0;
      if (!enabled || !lastTarget) return;
      positionBox(lastTarget);
    });
  }

  var listenersAttached = false;
  var scrollOpts = { capture: true, passive: true };
  function attachListeners() {
    if (listenersAttached) return;
    listenersAttached = true;
    document.addEventListener('pointermove', onPointerMove, true);
    window.addEventListener('scroll', onScrollOrResize, scrollOpts);
    window.addEventListener('resize', onScrollOrResize, scrollOpts);
  }
  function detachListeners() {
    if (!listenersAttached) return;
    listenersAttached = false;
    document.removeEventListener('pointermove', onPointerMove, true);
    window.removeEventListener('scroll', onScrollOrResize, scrollOpts);
    window.removeEventListener('resize', onScrollOrResize, scrollOpts);
  }

  function applyEnabled(e) {
    var next = !!e;
    enabled = next;
    if (!next) {
      if (scrollRafId) {
        cancelAnimationFrame(scrollRafId);
        scrollRafId = 0;
      }
      moveRafPending = false;
      hideBox();
      detachListeners();
    } else {
      attachListeners();
    }
  }

  window.__uiplaySetHighlightEnabled = function(e) {
    applyEnabled(!!e);
  };

  window.__uiplayHighlightV = VERSION;

  if (window.__UPLAY_HL_ENABLED_GLOBAL !== undefined) {
    applyEnabled(!!window.__UPLAY_HL_ENABLED_GLOBAL);
  } else {
    applyEnabled(false);
  }

  window.__uiplayHighlightTeardown = function() {
    applyEnabled(false);
    if (box && box.parentNode) box.parentNode.removeChild(box);
    delete window.__uiplayHighlightTeardown;
    delete window.__uiplaySetHighlightEnabled;
    delete window.__uiplayHighlightV;
  };
})();`;
}
