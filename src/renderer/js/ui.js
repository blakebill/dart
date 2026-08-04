'use strict';
// Small DOM component primitives shared by page controllers.
(function () {
  const App = window.App;

  function emptyState(options = {}) {
    const root = document.createElement('div');
    root.className = ['workspace-empty-state', options.className].filter(Boolean).join(' ');

    const icon = document.createElement('span');
    icon.className = ['workspace-empty-icon', options.iconClass].filter(Boolean).join(' ');
    icon.setAttribute('aria-hidden', 'true');
    root.appendChild(icon);

    const title = document.createElement('strong');
    title.textContent = String(options.title || '');
    root.appendChild(title);

    if (options.actionLabel) {
      const action = document.createElement('button');
      action.type = 'button';
      action.className = options.actionClass || 'btn';
      action.textContent = String(options.actionLabel);
      if (options.actionName) action.dataset.uiAction = options.actionName;
      root.appendChild(action);
    }
    return root;
  }

  function renderEmptyState(container, options) {
    if (!container) return null;
    container.replaceChildren(emptyState(options));
    container.classList.add('is-empty');
    return container.firstElementChild;
  }

  function clearEmptyState(container) {
    if (!container) return;
    container.classList.remove('is-empty');
    container.replaceChildren();
  }

  App.ui = Object.freeze({
    emptyState,
    renderEmptyState,
    clearEmptyState,
  });
})();
