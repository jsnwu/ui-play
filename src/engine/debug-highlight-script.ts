/**
 * Injected into the app page (all frames) during debug sessions.
 * Shows a hover outline on interactive elements (buttons, links, inputs, etc.).
 */

export function getInteractiveHighlightInitScript(): string {
  return `
(function() {
  var VERSION = 1;
  if (window.__uiplayHighlightV === VERSION) return;
  window.__uiplayHighlightV = VERSION;

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

  var enabled = true;
  var lastTarget = null;
  var box = document.createElement('div');
  box.setAttribute('data-uiplay-highlight', '1');
  box.style.cssText =
    'position:fixed;pointer-events:none;z-index:2147483646;box-sizing:border-box;' +
    'border:2px solid rgba(34,197,94,0.95);border-radius:3px;background:rgba(34,197,94,0.08);' +
    'display:none;transition:left 40ms ease-out,top 40ms ease-out,width 40ms ease-out,height 40ms ease-out';
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

  var rafPending = false;
  var lastEvent = null;
  function onPointerMove(e) {
    lastEvent = e;
    if (!enabled) return;
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(function() {
      rafPending = false;
      if (!enabled) return;
      var ev = lastEvent;
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

  function onScrollOrResize() {
    if (!enabled || !lastTarget) return;
    positionBox(lastTarget);
  }

  document.addEventListener('pointermove', onPointerMove, true);
  window.addEventListener('scroll', onScrollOrResize, true);
  window.addEventListener('resize', onScrollOrResize, true);

  function applyEnabled(e) {
    enabled = e;
    if (!e) hideBox();
  }

  window.__uiplaySetHighlightEnabled = function(e) {
    applyEnabled(!!e);
  };

  function syncFromNode() {
    if (window.__UPLAY_HL_ENABLED_GLOBAL !== undefined) {
      applyEnabled(!!window.__UPLAY_HL_ENABLED_GLOBAL);
    }
  }
  syncFromNode();
})();`;
}
