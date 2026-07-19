'use strict';
// Progressively enhance native selects with a themed combobox while keeping
// the original select as the single source of truth for values and events.
(function () {
  const App = window.App || (window.App = {});

  let openMenuCtl = null;
  let selectId = 0;
  const selectSync = new WeakMap();

  function closeOpen(options) {
    if (openMenuCtl) openMenuCtl.close(options);
  }

  document.addEventListener('click', (event) => {
    if (!openMenuCtl) return;
    if (!openMenuCtl.root.contains(event.target) && !openMenuCtl.menu.contains(event.target)) closeOpen();
  });
  // Capture Escape before a parent dialog interprets it as a request to close.
  document.addEventListener('keydown', (event) => {
    if (!openMenuCtl || event.key !== 'Escape') return;
    event.preventDefault();
    event.stopImmediatePropagation();
    closeOpen({ focus: true });
  }, true);
  window.addEventListener('scroll', (event) => {
    if (openMenuCtl && openMenuCtl.menu.contains(event.target)) return;
    closeOpen();
  }, true);
  window.addEventListener('resize', () => closeOpen());

  function explicitLabel(select) {
    if (!select.id) return null;
    return Array.from(document.querySelectorAll('label[for]')).find((label) => label.htmlFor === select.id) || null;
  }

  function copyAccessibleName(select, root) {
    const labelledBy = select.getAttribute('aria-labelledby');
    const ariaLabel = select.getAttribute('aria-label');
    const label = explicitLabel(select);
    if (label) {
      if (!label.id) label.id = `ui-select-label-${++selectId}`;
      root.setAttribute('aria-labelledby', label.id);
      label.htmlFor = root.id;
    } else if (labelledBy) {
      root.setAttribute('aria-labelledby', labelledBy);
    } else if (ariaLabel) {
      root.setAttribute('aria-label', ariaLabel);
    } else if (select.title) {
      root.setAttribute('aria-label', select.title);
    }
  }

  function enhance(select) {
    if (!(select instanceof HTMLSelectElement) || select.dataset.enhanced) return;
    select.dataset.enhanced = '1';
    let root = null;
    try {
      root = buildEnhanced(select);
    } catch (error) {
      delete select.dataset.enhanced;
      select.removeAttribute('aria-hidden');
      select.removeAttribute('tabindex');
      if (root) {
        const label = Array.from(document.querySelectorAll('label[for]'))
          .find((candidate) => candidate.htmlFor === root.id);
        if (label && select.id) label.htmlFor = select.id;
        if (root.parentNode) root.remove();
      }
    }
  }

  function buildEnhanced(select) {
    const id = ++selectId;
    const root = document.createElement('button');
    root.type = 'button';
    root.className = `ui-select ${select.className}`;
    root.id = `ui-select-${id}`;
    root.setAttribute('role', 'combobox');
    root.setAttribute('aria-haspopup', 'listbox');
    root.setAttribute('aria-autocomplete', 'none');
    root.setAttribute('aria-expanded', 'false');

    const menuId = `ui-select-menu-${id}`;
    root.setAttribute('aria-controls', menuId);
    copyAccessibleName(select, root);

    const valueLabel = document.createElement('span');
    valueLabel.className = 'ui-select-label';
    const chevron = document.createElement('span');
    chevron.className = 'ui-select-chevron';
    chevron.setAttribute('aria-hidden', 'true');
    chevron.innerHTML =
      "<svg width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='currentColor'" +
      " stroke-width='2.5' stroke-linecap='round' stroke-linejoin='round'>" +
      "<polyline points='6 9 12 15 18 9'/></svg>";
    root.append(valueLabel, chevron);
    select.insertAdjacentElement('afterend', root);
    select.setAttribute('aria-hidden', 'true');
    select.tabIndex = -1;

    let menu = null;
    let activeIndex = -1;
    let typeahead = '';
    let typeaheadTimer = null;

    const enabledIndexes = () => Array.from(select.options)
      .map((option, index) => (!option.disabled ? index : -1))
      .filter((index) => index >= 0);

    function syncControl() {
      const option = select.options[select.selectedIndex];
      valueLabel.textContent = option ? option.textContent : '';
      root.disabled = !!select.disabled;
      root.setAttribute('aria-disabled', String(!!select.disabled));
      if (select.getAttribute('aria-label') && !root.hasAttribute('aria-labelledby')) {
        root.setAttribute('aria-label', select.getAttribute('aria-label'));
      }
    }
    selectSync.set(select, syncControl);

    function setActive(index) {
      if (!menu || index < 0 || index >= select.options.length || select.options[index].disabled) return;
      activeIndex = index;
      menu.querySelectorAll('[role="option"]').forEach((item, itemIndex) => {
        item.classList.toggle('active', itemIndex === index);
      });
      const active = menu.children[index];
      root.setAttribute('aria-activedescendant', active.id);
      active.scrollIntoView({ block: 'nearest' });
    }

    function closeMenu({ focus = false } = {}) {
      clearTimeout(typeaheadTimer);
      typeahead = '';
      if (menu) {
        menu.remove();
        menu = null;
      }
      activeIndex = -1;
      root.classList.remove('open');
      root.setAttribute('aria-expanded', 'false');
      root.removeAttribute('aria-activedescendant');
      if (openMenuCtl && openMenuCtl.root === root) openMenuCtl = null;
      if (focus) root.focus();
    }

    function choose(index) {
      const option = select.options[index];
      if (!option || option.disabled) return;
      if (select.value !== option.value) {
        select.value = option.value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
      }
      syncControl();
      closeMenu({ focus: true });
    }

    function openMenu(preferredIndex) {
      if (select.disabled || menu) return;
      closeOpen();
      menu = document.createElement('div');
      menu.id = menuId;
      menu.className = 'ui-select-menu';
      menu.setAttribute('role', 'listbox');
      menu.setAttribute('aria-labelledby', root.getAttribute('aria-labelledby') || root.id);

      Array.from(select.options).forEach((option, index) => {
        const item = document.createElement('div');
        item.id = `${menuId}-option-${index}`;
        item.className = 'ui-select-opt' + (option.selected ? ' selected' : '');
        item.textContent = option.textContent;
        item.setAttribute('role', 'option');
        item.setAttribute('aria-selected', String(option.selected));
        item.setAttribute('aria-disabled', String(!!option.disabled));
        item.addEventListener('pointermove', () => setActive(index));
        item.addEventListener('click', (event) => {
          event.stopPropagation();
          choose(index);
        });
        menu.appendChild(item);
      });
      document.body.appendChild(menu);

      const rect = root.getBoundingClientRect();
      menu.style.minWidth = rect.width + 'px';
      const menuWidth = Math.max(rect.width, menu.offsetWidth);
      const menuHeight = menu.offsetHeight;
      const left = Math.min(rect.left, window.innerWidth - menuWidth - 8);
      menu.style.left = Math.max(8, left) + 'px';
      const below = window.innerHeight - rect.bottom;
      menu.style.top = (below < menuHeight && rect.top > below ? rect.top - menuHeight - 4 : rect.bottom + 4) + 'px';

      root.classList.add('open');
      root.setAttribute('aria-expanded', 'true');
      openMenuCtl = { root, menu, close: closeMenu };
      const indexes = enabledIndexes();
      const initial = indexes.includes(preferredIndex)
        ? preferredIndex
        : (indexes.includes(select.selectedIndex) ? select.selectedIndex : indexes[0]);
      if (initial !== undefined) setActive(initial);
    }

    function moveActive(delta) {
      const indexes = enabledIndexes();
      if (!indexes.length) return;
      const current = indexes.indexOf(activeIndex);
      const next = current < 0
        ? (delta > 0 ? 0 : indexes.length - 1)
        : (current + delta + indexes.length) % indexes.length;
      setActive(indexes[next]);
    }

    function runTypeahead(key) {
      clearTimeout(typeaheadTimer);
      typeahead += key.toLocaleLowerCase();
      typeaheadTimer = setTimeout(() => { typeahead = ''; }, 700);
      const options = Array.from(select.options);
      const match = options.findIndex((option) =>
        !option.disabled && option.textContent.trim().toLocaleLowerCase().startsWith(typeahead)
      );
      if (match >= 0) {
        if (!menu) openMenu(match);
        else setActive(match);
      }
    }

    root.addEventListener('click', (event) => {
      event.stopPropagation();
      if (menu) closeMenu();
      else openMenu(select.selectedIndex);
    });
    root.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        if (!menu) openMenu(select.selectedIndex);
        else moveActive(event.key === 'ArrowDown' ? 1 : -1);
      } else if (event.key === 'Home' || event.key === 'End') {
        event.preventDefault();
        if (!menu) openMenu(select.selectedIndex);
        const indexes = enabledIndexes();
        if (indexes.length) setActive(event.key === 'Home' ? indexes[0] : indexes[indexes.length - 1]);
      } else if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        if (!menu) openMenu(select.selectedIndex);
        else choose(activeIndex);
      } else if (event.key === 'Tab') {
        closeMenu();
      } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
        runTypeahead(event.key);
      }
    });

    const descriptor = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
    Object.defineProperty(select, 'value', {
      configurable: true,
      get() { return descriptor.get.call(this); },
      set(value) {
        descriptor.set.call(this, value);
        syncControl();
      },
    });
    select.addEventListener('change', syncControl);
    new MutationObserver(() => {
      closeMenu();
      syncControl();
    }).observe(select, { attributes: true, childList: true, characterData: true, subtree: true });

    syncControl();
    return root;
  }

  function enhanceSelects(root) {
    (root || document).querySelectorAll('select').forEach(enhance);
  }

  function refreshSelects(root) {
    closeOpen();
    enhanceSelects(root);
    (root || document).querySelectorAll('select').forEach((select) => {
      const sync = selectSync.get(select);
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
