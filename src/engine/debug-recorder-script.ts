/**
 * In-page recording script injected into the app during debug "Record".
 *
 * Element hints follow priorities similar to Playwright's selector generator
 * (see Microsoft Playwright `selectorGenerator.ts` / `roleUtils.ts`, Apache-2.0):
 * test id → role+accessible name → label/placeholder → title/text fallbacks.
 */

export function getDebugRecorderScript(): string {
  return `
(function() {
  var RECORDER_VERSION = 5;
  if (window.__uiplayRecorderV === RECORDER_VERSION) return;
  if (typeof window.__uiplayRecorderTeardown === 'function') {
    try { window.__uiplayRecorderTeardown(); } catch (e) {}
  }
  window.__uiplayRecorderV = RECORDER_VERSION;
  window.__inIframe = (window !== window.top);
  var actions = [];

  function cssEscapeId(id) {
    if (window.CSS && CSS.escape) return CSS.escape(id);
    return id.replace(/[^a-zA-Z0-9_-]/g, function(c) {
      return '\\\\' + c.charCodeAt(0).toString(16) + ' ';
    });
  }

  function trimFlat(s, max) {
    s = (s || '').replace(/\\s+/g, ' ').trim();
    if (!s) return '';
    if (s.length <= (max || 80)) return s;
    var cut = s.substring(0, max);
    var m = cut.match(/^(.*)\\s\\S*$/);
    return (m ? m[1] : cut).trim() || cut;
  }

  function innerTextLike(el) {
    return (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
  }

  var VALID_EXPLICIT_ROLES = {
    button:1, link:1, textbox:1, checkbox:1, radio:1, combobox:1, listbox:1,
    menuitem:1, tab:1, option:1, row:1, cell:1, gridcell:1, columnheader:1, rowheader:1,
    searchbox:1, img:1, heading:1, dialog:1, switch:1, slider:1, progressbar:1
  };

  function getExplicitRole(el) {
    var r = (el.getAttribute('role') || '').trim().split(/\\s+/)[0].toLowerCase();
    return VALID_EXPLICIT_ROLES[r] ? r : null;
  }

  var INPUT_TYPE_ROLE = {
    button:'button', submit:'button', reset:'button', image:'button',
    checkbox:'checkbox', radio:'radio',
    email:'textbox', password:'textbox', tel:'textbox', text:'textbox', url:'textbox',
    number:'spinbutton', range:'slider', search:'searchbox', hidden:null, file:'button'
  };

  function getImplicitRole(el) {
    var tag = el.tagName;
    if (tag === 'BUTTON') return 'button';
    if (tag === 'A') return 'link';
    if (tag === 'TEXTAREA') return 'textbox';
    if (tag === 'SELECT') return (el.multiple || el.size > 1) ? 'listbox' : 'combobox';
    if (tag === 'INPUT') {
      var t = (el.type || 'text').toLowerCase();
      if (t === 'hidden') return null;
      return INPUT_TYPE_ROLE[t] || 'textbox';
    }
    if (tag === 'OPTION') return 'option';
    if (tag === 'LI' && el.closest('[role="menu"],[role="listbox"],[role="tablist"]')) return 'option';
    if (tag === 'TR') return 'row';
    if (tag === 'TD') return 'cell';
    if (tag === 'TH') return 'columnheader';
    if (tag === 'IMG') return 'img';
    if (/^H[1-6]$/.test(tag)) return 'heading';
    return null;
  }

  function getAriaRole(el) {
    var ex = getExplicitRole(el);
    if (ex === 'presentation' || ex === 'none') return getImplicitRole(el);
    if (ex) return ex;
    return getImplicitRole(el);
  }

  function getAccessibleName(el) {
    var al = el.getAttribute('aria-label');
    if (al) return trimFlat(al, 80);

    var lb = el.getAttribute('aria-labelledby');
    if (lb) {
      var root = el.getRootNode ? el.getRootNode() : el.ownerDocument;
      var parts = [];
      lb.split(/\\s+/).forEach(function(id) {
        if (!id) return;
        try {
          var n = root.getElementById ? root.getElementById(id) : null;
          if (!n && root.querySelector) n = root.querySelector('#' + cssEscapeId(id));
          if (n) parts.push(innerTextLike(n));
        } catch (e) {}
      });
      var joined = trimFlat(parts.join(' '), 80);
      if (joined) return joined;
    }

    if (el.labels && el.labels.length) {
      var lt = [];
      for (var i = 0; i < el.labels.length; i++) lt.push(innerTextLike(el.labels[i]));
      var lj = trimFlat(lt.join(' '), 80);
      if (lj) return lj;
    }

    var ph = el.getAttribute && el.getAttribute('placeholder');
    if (ph) return trimFlat(ph, 80);

    var title = el.getAttribute('title');
    if (title) return trimFlat(title, 80);

    if (el.tagName === 'IMG' && el.getAttribute('alt'))
      return trimFlat(el.getAttribute('alt'), 80);

    if (el.tagName === 'INPUT') {
      var ty = (el.type || '').toLowerCase();
      if ((ty === 'submit' || ty === 'reset' || ty === 'button' || ty === 'image') && el.value)
        return trimFlat(el.value, 80);
    }

    if (el.tagName === 'BUTTON' || el.tagName === 'A' || el.tagName === 'LABEL')
      return trimFlat(innerTextLike(el), 80);

    return '';
  }

  function roleToSuffix(role, el) {
    if (!role) {
      if (el.tagName === 'A') return 'link';
      if (el.tagName === 'SELECT') return 'dropdown';
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') return 'field';
      return 'button';
    }
    if (role === 'link') return 'link';
    if (role === 'button' || role === 'menuitem') return 'button';
    if (role === 'textbox' || role === 'searchbox') return 'field';
    if (role === 'combobox' || role === 'listbox') return 'dropdown';
    if (role === 'checkbox') return 'checkbox';
    if (role === 'radio') return 'radio';
    if (role === 'tab') return 'tab';
    if (role === 'option') return 'option';
    if (role === 'row') return 'table row';
    if (role === 'cell' || role === 'gridcell') return 'table row';
    if (role === 'columnheader' || role === 'rowheader') return 'table row';
    if (role === 'heading') return 'heading';
    if (role === 'img') return 'image';
    return 'button';
  }

  /** Prefer stable test id / id locators (Playwright codegen order: testId before CSS nth). */
  function stableLocatorString(el) {
    if (!el || !el.getAttribute) return '';
    var tid = el.getAttribute('data-testid') || el.getAttribute('data-test-id') || el.getAttribute('data-test');
    if (tid) {
      var attr = el.hasAttribute('data-testid') ? 'data-testid' :
        el.hasAttribute('data-test-id') ? 'data-test-id' : 'data-test';
      return '[' + attr + '=' + JSON.stringify(tid) + ']';
    }
    var id = el.getAttribute('id');
    if (id && /^[a-zA-Z][a-zA-Z0-9_-]*$/.test(id) && id.length < 64) {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))
        return '#' + id;
    }
    return '';
  }

  /** CSS path fallback when no stable id (for debugging only; not passed as step locator by default). */
  function cssFallbackSelector(el) {
    if (el.id && el.id.length < 80) return '#' + cssEscapeId(el.id);
    var path = [];
    for (var n = el; n && n.nodeType === 1 && n.tagName !== 'BODY' && n.tagName !== 'HTML'; n = n.parentNode) {
      var idx = 1;
      var p = n.parentNode;
      if (p) {
        var ch = p.children;
        for (var i = 0; i < ch.length; i++) {
          if (ch[i] === n) break;
          if (ch[i].tagName === n.tagName) idx++;
        }
      }
      path.unshift(n.tagName.toLowerCase() + ':nth-of-type(' + idx + ')');
    }
    return path.join(' > ');
  }

  function buildCodegenStyleHint(el) {
    var role = getAriaRole(el);
    var name = getAccessibleName(el);
    var loc = stableLocatorString(el);
    var suffix = roleToSuffix(role, el);

    var hint;
    if (name) {
      hint = name + ' ' + suffix;
    } else if (el.tagName === 'SELECT') {
      hint = (el.getAttribute('name') || 'dropdown') + ' dropdown';
    } else if (role === 'textbox' || role === 'searchbox' || el.tagName === 'TEXTAREA') {
      hint = (el.getAttribute('name') || 'text') + ' field';
    } else {
      hint = (el.tagName || 'element').toLowerCase() + ' ' + suffix;
    }

    return { hint: trimFlat(hint, 120), locator: loc, selector: loc || cssFallbackSelector(el) };
  }

  function retargetInteractive(target) {
    if (!target) return null;
    var el = target.nodeType === 3 ? target.parentElement : target;
    if (!el || el.tagName === 'HTML' || el.tagName === 'BODY') return null;
    var sel = 'button,select,textarea,input,a[href],area[href],[role="button"],[role="link"],[role="tab"],[role="menuitem"],[role="checkbox"],[role="radio"],[role="switch"],[contenteditable="true"]';
    var hit = el.closest(sel);
    if (!hit && el.closest) {
      hit = el.closest('a');
    }
    if (hit) {
      if (hit.tagName === 'INPUT' && hit.type === 'hidden') return el;
      return hit;
    }
    return el;
  }

  /**
   * Use composedPath so clicks inside open shadow roots still resolve to inner button/input;
   * e.target alone can be retargeted to the host and miss closest("button").
   */
  function retargetInteractiveFromEvent(e) {
    var path = typeof e.composedPath === 'function' ? e.composedPath() : null;
    if (path && path.length) {
      for (var i = 0; i < path.length; i++) {
        var node = path[i];
        if (!node || node.nodeType !== 1) continue;
        if (node.tagName === 'HTML' || node.tagName === 'BODY') continue;
        var t = node.nodeType === 3 ? node.parentElement : node;
        if (!t) continue;
        var hit = retargetInteractive(t);
        if (hit && hit.tagName !== 'HTML' && hit.tagName !== 'BODY') return hit;
      }
    }
    return retargetInteractive(e.target);
  }

  var DBL_CLICK_MS = 400;
  var ABSORB_EXTRA_CLICK_MS = 350;
  /** Dedupe click after pointerdown (same target) so navigation does not lose the only record. */
  var CLICK_AFTER_POINTER_DEDUP_MS = 120;
  var lastPointerClickDedupe = { sel: '', t: 0 };

  function pushClickLikeRecord(e, now, source) {
    var raw = retargetInteractiveFromEvent(e);
    if (!raw) return;
    var t = raw;
    if (t.tagName === 'HTML' || t.tagName === 'BODY') return;
    var desc = buildCodegenStyleHint(t);
    var sel = desc.selector;
    var hint = desc.hint;
    var loc = desc.locator || '';
    if (source === 'click' && lastPointerClickDedupe.sel === sel &&
        (now - lastPointerClickDedupe.t) < CLICK_AFTER_POINTER_DEDUP_MS) {
      lastPointerClickDedupe = { sel: '', t: 0 };
      return;
    }
    var last = actions[actions.length - 1];
    if (last && last.action === 'dblclick' && last.selector === sel && (now - (last.timestamp || 0)) < ABSORB_EXTRA_CLICK_MS) return;
    if (last && last.action === 'click' && last.selector === sel && (now - (last.timestamp || 0)) < DBL_CLICK_MS) {
      actions.pop();
      actions.push({
        action: 'dblclick',
        selector: sel,
        elementHint: hint,
        locator: loc || undefined,
        timestamp: now
      });
      if (source === 'pointerdown') lastPointerClickDedupe = { sel: sel, t: now };
      else lastPointerClickDedupe = { sel: '', t: 0 };
      return;
    }
    actions.push({
      action: 'click',
      selector: sel,
      elementHint: hint,
      locator: loc || undefined,
      timestamp: now
    });
    if (source === 'pointerdown') lastPointerClickDedupe = { sel: sel, t: now };
    else lastPointerClickDedupe = { sel: '', t: 0 };
  }

  function onWindowPointerDown(e) {
    if (e.button !== 0) return;
    pushClickLikeRecord(e, Date.now(), 'pointerdown');
  }

  function onWindowClick(e) {
    pushClickLikeRecord(e, Date.now(), 'click');
  }

  // pointerdown runs synchronously before navigation unloads the document; click may not fire.
  window.addEventListener('pointerdown', onWindowPointerDown, true);
  // Capture on window so we run before document-level handlers (sites that
  // stopImmediatePropagation on document can still leave window uncancelled).
  window.addEventListener('click', onWindowClick, true);

  function onDocumentInput(e) {
    var t = e.target;
    if (!t || (t.tagName !== 'INPUT' && t.tagName !== 'TEXTAREA')) return;
    if (t.type === 'hidden' || t.type === 'checkbox' || t.type === 'radio' || t.type === 'file') return;
    var now = Date.now();
    var desc = buildCodegenStyleHint(t);
    var sel = desc.selector;
    var hint = desc.hint;
    var loc = desc.locator || '';
    var last = actions[actions.length - 1];
    if (last && last.action === 'fill' && last.selector === sel) {
      last.timestamp = now;
      last.value = t.value;
      if (loc) last.locator = loc;
      last.elementHint = hint;
    } else {
      actions.push({
        action: 'fill',
        selector: sel,
        elementHint: hint,
        locator: loc || undefined,
        value: t.value,
        timestamp: now
      });
    }
  }

  document.addEventListener('input', onDocumentInput, true);

  function onDocumentChange(e) {
    var t = e.target;
    if (!t || t.tagName !== 'SELECT') return;
    var desc = buildCodegenStyleHint(t);
    actions.push({
      action: 'select',
      selector: desc.selector,
      elementHint: desc.hint,
      locator: desc.locator || undefined,
      value: t.value,
      timestamp: Date.now()
    });
  }

  document.addEventListener('change', onDocumentChange, true);

  window.__uiplayRecorderTeardown = function() {
    window.removeEventListener('pointerdown', onWindowPointerDown, true);
    window.removeEventListener('click', onWindowClick, true);
    document.removeEventListener('input', onDocumentInput, true);
    document.removeEventListener('change', onDocumentChange, true);
    delete window.__uiplayRecorderTeardown;
    delete window.__uiplayRecorderV;
  };

  window.__recordedActions = actions;
  window.__getRecordedActions = function() { return JSON.parse(JSON.stringify(actions)); };
})();`;
}
