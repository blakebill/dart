'use strict';
// Custom dropdown: the native <select> popup can't be styled (the OS draws it),
// so we progressively enhance every <select> with a div-based menu that matches
// the app's rounded theme. The native <select> stays in the DOM (hidden) and
// keeps owning the value + 'change' event, so all existing logic is untouched —
// option clicks just set the native value and dispatch 'change'.
(function () {
  const App = window.App || (window.App = {});

  let openMenuCtl = null; // controller {root, menu, close} of the open dropdown
  const selectSync = new WeakMap();

  function closeOpen() {
    if (openMenuCtl) openMenuCtl.close();
  }

  // Close the open menu on a click outside it, Esc, an outer scroll, or resize
  // (the menu is position:fixed, so it must not linger when things move). The
  // trigger and option clicks stopPropagation, so this only sees outside clicks.
  document.addEventListener('click', (e) => {
    if (openMenuCtl && !openMenuCtl.root.contains(e.target) && !openMenuCtl.menu.contains(e.target)) closeOpen();
  });
  document.addEventListener('keydown', (e) => {
    if (openMenuCtl && e.key === 'Escape') closeOpen();
  });
  window.addEventListener('scroll', (e) => {
    if (openMenuCtl && openMenuCtl.menu.contains(e.target)) return; // scrolling inside the menu
    closeOpen();
  }, true);
  window.addEventListener('resize', closeOpen);

  function enhance(sel) {
    if (!(sel instanceof HTMLSelectElement) || sel.dataset.enhanced) return;
    sel.dataset.enhanced = '1';
    let root = null;
    try {
      buildEnhanced(sel, (el) => { root = el; });
    } catch (e) {
      // Never leave a select hidden-but-inert: restore the native control.
      delete sel.dataset.enhanced;
      if (root && root.parentNode) root.remove();
    }
  }

  function buildEnhanced(sel, setRoot) {
    const root = document.createElement('div');
    setRoot(root);
    // Reuse the native select's look (.input/.small give border, radius, size).
    root.className = 'ui-select ' + sel.className;
    root.tabIndex = 0;
    root.setAttribute('role', 'listbox');

    const label = document.createElement('span');
    label.className = 'ui-select-label';

    const chevron = document.createElement('span');
    chevron.className = 'ui-select-chevron';
    chevron.innerHTML =
      "<svg width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='currentColor'" +
      " stroke-width='2.5' stroke-linecap='round' stroke-linejoin='round'>" +
      "<polyline points='6 9 12 15 18 9'/></svg>";

    root.append(label, chevron);
    sel.insertAdjacentElement('afterend', root);

    // The menu is transient and lives on <body> while open. body-level keeps its
    // position:fixed relative to the viewport — inside the wrapper, a transformed
    // ancestor (the animated content area) would become its containing block and
    // push it off-screen. Created on open, removed on close (so it never leaks).
    let menu = null;

    const syncLabel = () => {
      const o = sel.options[sel.selectedIndex];
      label.textContent = o ? o.textContent : '';
    };
    selectSync.set(sel, syncLabel);

    const closeMenu = () => {
      if (menu) { menu.remove(); menu = null; }
      root.classList.remove('open');
      if (openMenuCtl && openMenuCtl.root === root) openMenuCtl = null;
    };

    const openMenu = () => {
      if (sel.disabled) return;
      closeOpen(); // close any other open dropdown first

      menu = document.createElement('div');
      menu.className = 'ui-select-menu';
      for (const o of sel.options) {
        const item = document.createElement('div');
        item.className = 'ui-select-opt' + (o.selected ? ' selected' : '');
        item.textContent = o.textContent;
        item.addEventListener('click', (e) => {
          e.stopPropagation(); // don't bubble to the trigger (would re-open)
          if (sel.value !== o.value) {
            sel.value = o.value;
            sel.dispatchEvent(new Event('change', { bubbles: true }));
          }
          closeMenu();
        });
        menu.appendChild(item);
      }
      document.body.appendChild(menu);

      // Position under the trigger (flip up when short on room), clamped to the
      // viewport. getBoundingClientRect + a body-level fixed menu share the same
      // viewport coordinate system.
      const r = root.getBoundingClientRect();
      const mw = menu.offsetWidth;
      const mh = menu.offsetHeight;
      menu.style.minWidth = r.width + 'px';
      let left = Math.min(r.left, window.innerWidth - mw - 8);
      menu.style.left = Math.max(8, left) + 'px';
      const below = window.innerHeight - r.bottom;
      menu.style.top = (below < mh && r.top > below ? r.top - mh - 4 : r.bottom + 4) + 'px';

      root.classList.add('open');
      openMenuCtl = { root, menu, close: closeMenu };
    };

    root.addEventListener('click', (e) => {
      e.stopPropagation(); // keep the document close-handler from seeing our own click
      if (root.classList.contains('open')) closeMenu();
      else openMenu();
    });
    root.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') { e.preventDefault(); openMenu(); }
    });

    // Reflect programmatic `select.value = ...` (e.g. settings load) in the label
    // by wrapping the instance's value setter — change events aren't fired then.
    const desc = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
    Object.defineProperty(sel, 'value', {
      configurable: true,
      get() { return desc.get.call(this); },
      set(v) { desc.set.call(this, v); syncLabel(); },
    });
    sel.addEventListener('change', syncLabel);

    syncLabel();
  }

  /** Enhance every <select> within root (default: whole document). Idempotent. */
  function enhanceSelects(root) {
    (root || document).querySelectorAll('select').forEach(enhance);
  }

  // Translation updates mutate the native <option> text in place. Refresh the
  // mirrored label as well, otherwise the enhanced control keeps displaying
  // the previous language until its value changes.
  function refreshSelects(root) {
    closeOpen();
    enhanceSelects(root);
    (root || document).querySelectorAll('select').forEach((sel) => {
      const sync = selectSync.get(sel);
      if (sync) sync();
    });
  }

  App.enhanceSelects = enhanceSelects;
  App.refreshSelects = refreshSelects;
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => enhanceSelects());
  } else {
    enhanceSelects();
  }
})();
