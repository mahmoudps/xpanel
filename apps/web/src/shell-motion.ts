/** Native presentation only. The existing shell controller remains the owner of
 * focus, inert state, scroll locks and navigation; no operation waits on motion. */
export const SHELL_MOTION_CLIENT_SCRIPT = /* js */ String.raw`
  function createShellMotionController(element, kind) {
    if (kind !== 'mobile-nav' && kind !== 'cmdk') return null;
    var surface = kind === 'cmdk' ? element.querySelector('.xp-cmdk-dialog') : element;
    var backdrop = kind === 'cmdk' ? element : document.querySelector('[data-xp-nav-backdrop]');
    if (!surface || !backdrop) return null;
    var preference = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
    var duration = kind === 'mobile-nav' ? 200 : 160;
    var animations = [], styles = [], phase = 'closed', revision = 0, closeCallback = null, listening = false;

    function listen(on) {
      if (!preference || listening === on) return;
      if (typeof preference.addEventListener === 'function') {
        preference[on ? 'addEventListener' : 'removeEventListener']('change', preferenceChanged);
      } else if (typeof preference.addListener === 'function') {
        preference[on ? 'addListener' : 'removeListener'](preferenceChanged);
      }
      listening = on;
    }
    function cleanup() {
      listen(false);
      var old = animations; animations = [];
      old.forEach(function (animation) { animation.cancel(); });
      styles.forEach(function (saved) { saved.element.style.willChange = saved.willChange; });
      styles = [];
    }
    function complete(open, ticket) {
      if (ticket !== revision) return;
      cleanup(); phase = open ? 'open' : 'closed';
      var callback = open ? null : closeCallback; closeCallback = null;
      if (callback) callback();
    }
    function preferenceChanged() {
      if (!preference.matches || !animations.length) return;
      var open = phase === 'opening';
      complete(open, ++revision);
    }
    function promote(target, properties) {
      if (styles.some(function (saved) { return saved.element === target; })) return;
      styles.push({ element: target, willChange: target.style.willChange });
      target.style.willChange = properties;
    }
    function prepare(open) {
      // Read original style once before any writes; animation effects are never
      // used as a new baseline during reversal.
      var style = window.getComputedStyle(surface), base = style.transform;
      var opacity = Number(window.getComputedStyle(backdrop).opacity);
      var offset = kind === 'mobile-nav'
        ? 'translateX(' + (style.direction === 'rtl' ? 24 : -24) + 'px)'
        : 'translateY(8px)';
      var closed = offset + (base === 'none' ? '' : ' ' + base);
      promote(surface, 'transform'); promote(backdrop, 'opacity');
      // Retain each effect immediately so partial setup is cancellable.
      animations.push(surface.animate([{ transform: closed }, { transform: base }], { duration: duration, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)', fill: 'both' }));
      animations.push(backdrop.animate([{ opacity: 0 }, { opacity: opacity }], { duration: duration, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)', fill: 'both' }));
      animations.forEach(function (animation) {
        animation.pause(); animation.currentTime = open ? 0 : duration;
      });
    }
    function move(open, callback) {
      closeCallback = open ? null : callback;
      phase = open ? 'opening' : 'closing';
      var ticket = ++revision;
      if ((preference && preference.matches) || typeof surface.animate !== 'function' || typeof backdrop.animate !== 'function') {
        complete(open, ticket); return;
      }
      try {
        if (!animations.length) prepare(open);
        listen(true);
        animations.forEach(function (animation) {
          // play() auto-rewinds at an endpoint. Retain the exact position even
          // when a reentrant request arrives before the pending play settles.
          var position = animation.currentTime;
          animation.playbackRate = open ? 1 : -1; animation.play();
          animation.currentTime = position;
        });
        Promise.all(animations.map(function (animation) { return animation.finished; })).then(function () {
          complete(open, ticket);
        }, function () {
          // A cancelled, superseded effect must never close a newer interaction.
          if (ticket === revision) complete(open, ticket);
        });
      } catch (_error) {
        complete(open, ticket);
      }
    }
    return {
      open: function () { move(true, null); },
      close: function (callback) { move(false, callback); },
      destroy: function () { revision++; closeCallback = null; cleanup(); phase = 'closed'; }
    };
  }
`;
