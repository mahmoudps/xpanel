import { SHELL_MOTION_CLIENT_SCRIPT } from './shell-motion.ts'

/** Shared shell presentation only: no session, transport, or business operations. */
export const MOBILE_NAVIGATION_CLIENT_FUNCTIONS = /* js */ String.raw`
  function isVisibleElement(element) {
    if (!element || !element.isConnected || element.closest('[hidden], [inert]') || !element.getClientRects().length) return false;
    if (typeof element.checkVisibility === 'function') {
      if (!element.checkVisibility()) return false;
    } else {
      var parent = element.parentElement;
      while (parent) {
        var closedDetails = parent.closest('details:not([open])');
        if (!closedDetails) break;
        var summary = closedDetails.querySelector(':scope > summary');
        if (!summary || !summary.contains(element)) return false;
        parent = closedDetails.parentElement;
      }
    }
    var visibility = window.getComputedStyle(element).visibility;
    return visibility !== 'hidden' && visibility !== 'collapse';
  }

  function focusableElements(element) {
    return Array.prototype.filter.call(element.querySelectorAll(focusableSelector), function (target) {
      return target.tabIndex >= 0 && isVisibleElement(target);
    });
  }

  function focusOverlay(overlay) {
    var targets = focusableElements(overlay.element);
    var preferred = null;
    if (overlay.kind === 'mobile-nav') {
      preferred = targets.find(function (target) { return target.tagName.toLowerCase() === 'a'; });
    } else if (overlay.kind === 'cmdk') {
      preferred = targets.find(function (target) { return target.tagName.toLowerCase() === 'input'; });
    }
    (preferred || targets[0] || overlay.element).focus({ preventScroll: true });
  }

  function toolbarFocusReturn(target) {
    if (window.innerWidth >= 960 || !target || !target.closest) return target;
    var details = target.closest('details[data-xp-toolbar-options]');
    if (!details) return target;
    return details.querySelector(':scope > summary') || target;
  }

  function responsiveFocusTarget() {
    var focused = document.activeElement;
    // CSS can blur a newly hidden control before the resize listener runs.
    if (focused === document.body && lastFocusedElement && !isVisibleElement(lastFocusedElement)) return lastFocusedElement;
    return focused;
  }

  function focusVisibleTarget(target) {
    if (!target || !target.matches(focusableSelector) || !isVisibleElement(target)) return false;
    target.focus({ preventScroll: true });
    return document.activeElement === target;
  }

  function restoreVisibleFocus(target) {
    if (focusVisibleTarget(toolbarFocusReturn(target))) return;
    var toolbar = target && target.closest ? target.closest('details[data-xp-toolbar-options]') : null;
    if (toolbar) {
      var toolbarTargets = focusableElements(toolbar);
      if (focusVisibleTarget(toolbarTargets[0])) return;
    }
    var sidebar = document.querySelector('[data-xp-sidebar]');
    if (window.innerWidth < 960) {
      if (focusVisibleTarget(document.querySelector('[data-action="toggle-mobile-nav"]'))) return;
    } else if (sidebar) {
      if (focusVisibleTarget(sidebar.querySelector('[aria-current="page"]'))) return;
    }
    focusVisibleTarget(document.getElementById('main-content'));
  }

  function closeToolbarOptions() {
    if (window.innerWidth >= 960) return;
    var toolbars = document.querySelectorAll('details[data-xp-toolbar-options]');
    for (var i = 0; i < toolbars.length; i++) toolbars[i].open = false;
  }

  function syncResponsiveToolbar() {
    var mobile = window.innerWidth < 960;
    if (toolbarMobileMode === mobile) return;
    toolbarMobileMode = mobile;
    var toolbars = document.querySelectorAll('details[data-xp-toolbar-options]');
    for (var i = 0; i < toolbars.length; i++) {
      var toolbar = toolbars[i];
      var focused = responsiveFocusTarget();
      var summary = toolbar.querySelector(':scope > summary');
      toolbar.open = !mobile;
      toolbar.dataset.mobileReady = 'true';
      if (mobile && summary && focused !== summary && toolbar.contains(focused)) focusVisibleTarget(summary);
      else if (!mobile && focused === summary) restoreVisibleFocus(summary);
    }
  }

  function closeFocusedToolbar(target) {
    if (window.innerWidth >= 960 || !target || !target.closest) return false;
    var toolbar = target.closest('details[data-xp-toolbar-options]');
    if (!toolbar || !toolbar.open) return false;
    toolbar.open = false;
    var summary = toolbar.querySelector(':scope > summary');
    if (summary) summary.focus({ preventScroll: true });
    return true;
  }

  function setMobileNavigationState(open) {
    var sidebar = document.querySelector('[data-xp-sidebar]');
    var shell = sidebar && sidebar.parentElement;
    var backdrop = document.querySelector('[data-xp-nav-backdrop]');
    var toggles = document.querySelectorAll('[data-action="toggle-mobile-nav"]');
    if (shell) {
      if (open) shell.dataset.mobileNav = 'open';
      else delete shell.dataset.mobileNav;
    }
    if (backdrop) backdrop.hidden = !open;
    for (var i = 0; i < toggles.length; i++) {
      toggles[i].setAttribute('aria-expanded', open ? 'true' : 'false');
    }
  }

  function finishOverlayClose(overlay, restoreFocus) {
    if (activeOverlay !== overlay) return;
    activeOverlay = null;
    if (overlay.motion) { overlay.motion.destroy(); overlay.motion = null; }
    if (overlay.kind === 'mobile-nav') {
      setMobileNavigationState(false);
      if (overlay.role === null) overlay.element.removeAttribute('role');
      else overlay.element.setAttribute('role', overlay.role);
      if (overlay.ariaModal === null) overlay.element.removeAttribute('aria-modal');
      else overlay.element.setAttribute('aria-modal', overlay.ariaModal);
    } else {
      overlay.element.hidden = true;
      if (overlay.kind === 'cmdk' && commandPalette) commandPalette.input.setAttribute('aria-expanded', 'false');
    }
    if (overlay.tabIndex === null) overlay.element.removeAttribute('tabindex');
    for (var i = 0; i < overlay.inertElements.length; i++) {
      var previous = overlay.inertElements[i];
      if (previous.value === null) previous.element.removeAttribute('inert');
      else previous.element.setAttribute('inert', previous.value);
    }
    document.body.style.overflow = overlay.bodyOverflow;
    document.documentElement.style.overflow = overlay.documentOverflow;
    if (restoreFocus) {
      restoreVisibleFocus(overlay.returnFocus);
      // Preserve the document after the lock and focus restoration have settled.
      // Do not override navigation or a deliberate history/hash change.
      if (!overlay.skipDocumentRestore && window.location.href === overlay.documentHref &&
          (window.scrollX !== overlay.documentX || window.scrollY !== overlay.documentY)) {
        window.scrollTo({ left: overlay.documentX, top: overlay.documentY, behavior: 'instant' });
      }
    }
  }

  function closeActiveOverlay(restoreFocus, immediate, skipDocumentRestore) {
    if (!activeOverlay) return;
    var overlay = activeOverlay;
    if (overlay.closing) {
      overlay.skipDocumentRestore = overlay.skipDocumentRestore || Boolean(skipDocumentRestore);
      overlay.restoreFocusAfterClose = overlay.restoreFocusAfterClose || restoreFocus;
      if (immediate) finishOverlayClose(overlay, overlay.restoreFocusAfterClose);
      return;
    }
    overlay.skipDocumentRestore = Boolean(skipDocumentRestore);
    if (overlay.motion && !immediate) {
      overlay.closing = true;
      overlay.restoreFocusAfterClose = restoreFocus;
      overlay.motion.close(function () { finishOverlayClose(overlay, overlay.restoreFocusAfterClose); });
    } else finishOverlayClose(overlay, restoreFocus);
  }

  function openOverlay(element, kind, trigger) {
    if (!element) return;
    if (activeOverlay && activeOverlay.element === element) {
      if (activeOverlay.closing && activeOverlay.motion) {
        activeOverlay.closing = false;
        activeOverlay.restoreFocusAfterClose = false;
        activeOverlay.skipDocumentRestore = false;
        activeOverlay.motion.open();
        focusOverlay(activeOverlay);
      }
      return;
    }
    lastKeyPrefix = null;
    clearTimeout(lastKeyPrefixTimer);
    var returnFocus = trigger || document.activeElement;
    var documentOrigin = activeOverlay && activeOverlay.documentHref === window.location.href ? activeOverlay : null;
    if (activeOverlay) {
      if (activeOverlay.element.contains(returnFocus)) returnFocus = activeOverlay.returnFocus;
      closeActiveOverlay(false, true);
    }
    returnFocus = toolbarFocusReturn(returnFocus);
    closeToolbarOptions();
    var overlay = {
      element: element,
      kind: kind,
      returnFocus: returnFocus,
      role: element.getAttribute('role'),
      ariaModal: element.getAttribute('aria-modal'),
      tabIndex: element.getAttribute('tabindex'),
      inertElements: [],
      bodyOverflow: document.body.style.overflow,
      documentOverflow: document.documentElement.style.overflow,
      documentHref: documentOrigin ? documentOrigin.documentHref : window.location.href,
      documentX: documentOrigin ? documentOrigin.documentX : window.scrollX,
      documentY: documentOrigin ? documentOrigin.documentY : window.scrollY,
      skipDocumentRestore: false
    };
    if (kind === 'mobile-nav') {
      setMobileNavigationState(true);
      element.setAttribute('role', 'dialog');
      element.setAttribute('aria-modal', 'true');
    } else {
      element.hidden = false;
    }
    if (overlay.tabIndex === null) element.setAttribute('tabindex', '-1');
    // Inert siblings at each level keep the active sheet usable even inside the shell.
    var current = element;
    while (current.parentElement) {
      var siblings = current.parentElement.children;
      for (var i = 0; i < siblings.length; i++) {
        var sibling = siblings[i];
        if (sibling === current || (kind === 'mobile-nav' && sibling.hasAttribute('data-xp-nav-backdrop'))) continue;
        overlay.inertElements.push({ element: sibling, value: sibling.getAttribute('inert') });
        sibling.setAttribute('inert', '');
      }
      current = current.parentElement;
      if (current === document.body) break;
    }
    document.body.style.overflow = 'hidden';
    document.documentElement.style.overflow = 'hidden';
    activeOverlay = overlay;
    overlay.closing = false;
    overlay.motion = createShellMotionController(element, kind);
    if (overlay.motion) overlay.motion.open();
    focusOverlay(overlay);
  }

  function toggleMobileNavigation(trigger) {
    if (window.innerWidth >= 960) return;
    if (activeOverlay && activeOverlay.kind === 'mobile-nav' && !activeOverlay.closing) {
      closeActiveOverlay(true);
      return;
    }
    openOverlay(document.querySelector('[data-xp-sidebar]'), 'mobile-nav', trigger);
  }

  function trapOverlayFocus(event) {
    var overlay = activeOverlay;
    var targets = focusableElements(overlay.element);
    var first = targets[0];
    var last = targets[targets.length - 1];
    var focused = document.activeElement;
    if (!first) {
      event.preventDefault();
      overlay.element.focus({ preventScroll: true });
    } else if (event.shiftKey && (focused === first || focused === overlay.element || !overlay.element.contains(focused))) {
      event.preventDefault();
      last.focus({ preventScroll: true });
    } else if (!event.shiftKey && (focused === last || !overlay.element.contains(focused))) {
      event.preventDefault();
      first.focus({ preventScroll: true });
    }
  }

  function bindOverlayFocus() {
    syncResponsiveToolbar();
    document.addEventListener('focusin', function (event) {
      lastFocusedElement = event.target;
      if (activeOverlay && !activeOverlay.element.contains(event.target)) focusOverlay(activeOverlay);
    });
    document.addEventListener('focusout', function (event) {
      if (!event.relatedTarget && isVisibleElement(event.target)) lastFocusedElement = null;
    });
    window.addEventListener('resize', function () {
      syncResponsiveToolbar();
      if (window.innerWidth >= 960) {
        if (activeOverlay && activeOverlay.kind === 'mobile-nav') {
          var focused = responsiveFocusTarget();
          closeActiveOverlay(false, true);
          if (!isVisibleElement(focused)) restoreVisibleFocus(focused);
        }
        setMobileNavigationState(false);
      }
    });
  }

  function bindMobileNavigation() {
    var sidebar = document.querySelector('[data-xp-sidebar]');
    var shell = sidebar && sidebar.parentElement || document.body;
    if (!shell || shell.__xpanelMobileNavigationBound) return;
    shell.__xpanelMobileNavigationBound = true;
    bindOverlayFocus();
    document.addEventListener('click', function (event) {
      var navigation = event.target && event.target.closest ? event.target.closest('a[href][data-nav-route]') : null;
      if (activeOverlay && activeOverlay.kind === 'mobile-nav' && navigation && activeOverlay.element.contains(navigation)) {
        // Follow the actual link immediately; presentation never delays navigation.
        closeActiveOverlay(true, true, true);
        return;
      }
      var target = event.target && event.target.closest ? event.target.closest('[data-action]') : null;
      if (!target) return;
      var action = target.getAttribute('data-action');
      if (action === 'toggle-mobile-nav') {
        event.preventDefault();
        toggleMobileNavigation(target);
      } else if (action === 'close-mobile-nav') {
        event.preventDefault();
        if (activeOverlay && activeOverlay.kind === 'mobile-nav') closeActiveOverlay(true);
      }
    });
    document.addEventListener('keydown', function (event) {
      if (event.isComposing) return;
      if (!activeOverlay) {
        if (event.key === 'Escape' && closeFocusedToolbar(event.target)) event.preventDefault();
        return;
      }
      if (activeOverlay.kind !== 'mobile-nav') return;
      if (event.key === 'Escape') {
        event.preventDefault();
        closeActiveOverlay(true);
      } else if (event.key === 'Tab') trapOverlayFocus(event);
    });
  }
`;

/** Status documents omit the realtime client. Mount the same navigation owner
 * only on the validated server status branch; ordinary documents use its WS mount. */
export const MOBILE_NAVIGATION_CLIENT_SCRIPT = /* js */ `
(function () {
  'use strict';
  if (typeof document === 'undefined' || typeof window === 'undefined') return;
  var sidebar = document.querySelector('[data-xp-sidebar]');
  if (!sidebar || !sidebar.parentElement || !document.documentElement.hasAttribute('data-status')) return;
${SHELL_MOTION_CLIENT_SCRIPT}
  var lastKeyPrefix = null;
  var lastKeyPrefixTimer = null;
  var activeOverlay = null;
  var toolbarMobileMode = null;
  var lastFocusedElement = null;
  var commandPalette = null;
  var focusableSelector = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), details > summary:first-of-type, [tabindex], [contenteditable="true"]';
${MOBILE_NAVIGATION_CLIENT_FUNCTIONS}
  bindMobileNavigation();
})();
`;
