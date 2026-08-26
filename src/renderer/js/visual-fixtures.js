'use strict';
// Deterministic state used only by the Electron visual-regression harness.
(function () {
  const params = new URLSearchParams(window.location.search);
  if (params.get('visual-test') !== '1') return;

  const App = window.App;
  const GB = 1024 ** 3;
  const theme = params.get('theme') === 'dark' ? 'dark' : 'light';
  const language = params.get('lang') === 'en' ? 'en' : 'zh';
  const settingsDirty = params.get('settings-dirty') === '1';
  const sidebarCollapsed = params.get('sidebar-collapsed') === '1';
  const requestedTab = params.get('tab') || 'dashboard';
  const requestedRuleView = params.get('rule-view') === 'remote' ? 'remote' : 'local';
  const readyToken = params.get('visual-token') || 'ready';
  const now = Date.UTC(2026, 6, 29, 4, 0, 0);
  const visualNodeName = 'Example Node 01';
  const state = {
    activeSub: 'fixture-primary',
    selected: visualNodeName,
    settings: {
      language,
      theme,
      coreType: 'mihomo',
      clashMode: 'rule',
      mixedPort: 7890,
      clashApiPort: 9090,
      logLevel: 'info',
      autoSetSystemProxy: true,
      autoLaunch: false,
      silentStart: false,
      notifications: true,
      enableIpv6: false,
      enableDnsOverride: false,
      useBuiltinRules: false,
      enableTun: false,
      testUrl: 'http://www.gstatic.com/generate_204',
      smartMode: 'balanced',
      smartRegions: [],
      dnsRemote: 'https://1.1.1.1/dns-query',
      dnsLocal: 'https://223.5.5.5/dns-query',
      dnsStrategy: 'prefer_ipv4',
    },
    status: {
      running: true,
      systemProxy: true,
      coreInstalled: true,
      coreType: 'mihomo',
      coreName: 'Dart Mihomo',
      coreVersion: '1.12.0',
    },
    subscriptions: [
      {
        id: 'fixture-primary',
        name: 'Example Profile A',
        url: 'https://example.com/profile-a.yaml',
        nodeCount: 28,
        updatedAt: now - 12 * 60 * 1000,
        autoUpdateMinutes: 60,
        userInfo: {
          upload: 1.8 * GB,
          download: 10.6 * GB,
          total: 100 * GB,
          expire: Math.floor((now + 21 * 86400000) / 1000),
        },
      },
      {
        id: 'fixture-secondary',
        name: 'Example Profile B',
        url: 'https://example.com/profile-b.yaml',
        nodeCount: 16,
        updatedAt: now - 46 * 60 * 1000,
        autoUpdateMinutes: 120,
        userInfo: { upload: 2.2 * GB, download: 20 * GB, total: 1000 * GB },
      },
      {
        id: 'fixture-backup',
        name: 'Example Profile C',
        url: 'https://example.com/profile-c.yaml',
        nodeCount: 12,
        updatedAt: now - 2 * 3600000,
        autoUpdateMinutes: 0,
        userInfo: { upload: 8.4 * GB, download: 51.4 * GB, total: 1000 * GB },
      },
    ],
  };

  const fixtureConnections = {
    running: true,
    totalConnections: 3,
    up: 1872,
    down: 5843,
    connections: [
      {
        id: 'fixture-1',
        metadata: { host: 'api.example.com', destinationPort: '443', network: 'tcp' },
        rule: 'Match',
        chains: ['Proxy', visualNodeName],
        upload: 54321,
        download: 735421,
      },
      {
        id: 'fixture-2',
        metadata: { host: 'cdn.example.net', destinationPort: '443', network: 'tcp' },
        rule: 'Proxy',
        chains: ['Proxy', visualNodeName],
        upload: 12345,
        download: 245678,
      },
      {
        id: 'fixture-3',
        metadata: { host: 'dns.example.org', destinationPort: '853', network: 'udp' },
        rule: 'Direct',
        chains: ['Direct'],
        upload: 822,
        download: 1412,
      },
    ],
  };

  function seedTraffic() {
    App.trafficChart.reset();
    App.miniChart.reset();
    for (let index = 0; index < 60; index++) {
      const pulse = index === 35 ? 148000 : index === 52 ? 76000 : 0;
      const down = 1800 + (index % 8) * 170 + pulse;
      const up = 900 + (index % 5) * 120 + Math.round(pulse * 0.12);
      App.trafficChart.push(up, down);
      App.miniChart.push(up, down);
    }
  }

  function seedDashboardEvents() {
    const list = App.$('#dashboardEventList');
    if (!list) return;
    list.innerHTML = `
      <div class="dashboard-event is-warn">
        <span class="dashboard-event-dot" aria-hidden="true"></span>
        <span class="dashboard-event-text">System proxy settings were restored</span>
        <time class="dashboard-event-time">11:58:20</time>
      </div>
      <div class="dashboard-event is-info">
        <span class="dashboard-event-dot" aria-hidden="true"></span>
        <span class="dashboard-event-text">Active profile updated</span>
        <time class="dashboard-event-time">11:56:04</time>
      </div>
      <div class="dashboard-event is-info">
        <span class="dashboard-event-dot" aria-hidden="true"></span>
        <span class="dashboard-event-text">Core started</span>
        <time class="dashboard-event-time">11:55:48</time>
      </div>
      <div class="dashboard-event is-info">
        <span class="dashboard-event-dot" aria-hidden="true"></span>
        <span class="dashboard-event-text">System proxy enabled</span>
        <time class="dashboard-event-time">11:55:47</time>
      </div>
      <div class="dashboard-event is-warn">
        <span class="dashboard-event-dot" aria-hidden="true"></span>
        <span class="dashboard-event-text">GeoData fallback is active</span>
        <time class="dashboard-event-time">11:51:12</time>
      </div>
      <div class="dashboard-event is-info">
        <span class="dashboard-event-dot" aria-hidden="true"></span>
        <span class="dashboard-event-text">Profile check completed</span>
        <time class="dashboard-event-time">11:49:31</time>
      </div>`;
  }

  function seedPolicyGroups() {
    const list = App.$('#ruleGroupList');
    if (!list) return;
    list.innerHTML = [
      ['Proxy', 'source', 'Example Node 01'],
      ['Microsoft Services', 'direct', ''],
      ['Streaming Media', 'source', '🚀 Proxy'],
      ['Advertising', 'reject', ''],
      ['Final', 'proxy', ''],
    ].map(([name, mode, outbound], index) => `
      <article class="sub-item rule-group-item${index === 0 ? ' is-expanded' : ''}">
        <strong class="sub-name rule-group-name">${name}</strong>
        <div class="rule-group-actions" role="group" aria-label="${name}">
          ${['source', 'proxy', 'direct', 'reject'].map((value) => `<button type="button" class="btn compact rule-group-mode${mode === value ? ' primary' : ''}" aria-pressed="${mode === value}">${{
            source: window.i18n.t('rulegroups.targetSource'),
            proxy: window.i18n.t('customrs.targetProxy'),
            direct: 'DIRECT',
            reject: 'REJECT',
          }[value]}</button>`).join('')}
        </div>
        ${outbound ? `<button type="button" class="rule-group-outbound" aria-expanded="${index === 0}"><span class="rule-group-outbound-label">${window.i18n.t('rulegroups.currentOutbound')}</span><strong>${outbound}</strong><span class="rule-group-outbound-action">${window.i18n.t(index === 0 ? 'rulegroups.collapseOutbound' : 'rulegroups.changeOutbound')}<span class="rule-group-chevron" aria-hidden="true"></span></span></button>` : ''}
        ${index === 0 ? `<div class="rule-group-picker"><input class="input rule-group-search" value="" placeholder="${window.i18n.t('rulegroups.searchOutbound')}"/><div class="rule-group-choices" role="group">${['Example Node 01', 'Example Node 02', 'DIRECT', 'REJECT', '🚀 Proxy'].map((value, pickIndex) => `<button type="button" class="btn compact rule-group-choice${pickIndex === 0 ? ' primary' : ''}"><span>${value}</span></button>`).join('')}</div></div>` : ''}
      </article>`).join('');
  }

  function seedRules() {
    const ruleList = App.$('#ruleList');
    if (!ruleList) return;
    ruleList.classList.remove('is-empty');
    ruleList.innerHTML = [
      ['DOMAIN-SUFFIX', 'example.com', '🚀 Proxy'],
      ['IP-ASN', '13335', 'DIRECT'],
      ['MATCH', '', '🚀 Proxy'],
    ].map(([type, payload, proxy]) => `<div class="rule-item"><span class="rule-type">${type}</span><span class="rule-payload">${payload}</span><span class="rule-proxy">${proxy}</span></div>`).join('');
    App.$('#ruleCount').textContent = window.i18n.t('rules.count', 3) + ' · ' + window.i18n.t('rules.live');
    App.$('#lrList').innerHTML = `
      <div class="sub-item"><div class="sub-info"><div class="sub-name">ASN routing</div><div class="sub-meta">IP-ASN · Proxy · 2</div></div><div class="sub-actions"><button class="btn">${window.i18n.t('subs.edit')}</button><button class="btn danger">${window.i18n.t('customrs.remove')}</button></div></div>`;
    App.$('#crsList').innerHTML = `
      <div class="sub-item"><div class="sub-info"><div class="sub-name">Privacy rules</div><div class="sub-meta">Clash · Reject · 128 rules</div></div><div class="sub-actions"><button class="btn">${window.i18n.t('customrs.refresh')}</button><button class="btn">${window.i18n.t('subs.edit')}</button><button class="btn danger">${window.i18n.t('customrs.remove')}</button></div></div>`;
  }

  async function boot({ ensureTabModules, showTab, setLanguage }) {
    document.documentElement.dataset.visualTest = 'true';
    App.store.replace(state);
    App.delays.set(visualNodeName, 68);
    App.currentNodeName = () => visualNodeName;
    App.applyTheme(theme, theme);
    setLanguage(language);
    App.$('#appVersion').textContent = 'v0.9.7';
    if (sidebarCollapsed && App.setSidebarCollapsed) {
      App.setSidebarCollapsed(true, { persist: false });
    }
    seedTraffic();
    App.renderDashboard();
    App.$('#dashConnections').textContent = String(fixtureConnections.totalConnections);
    seedDashboardEvents();

    await ensureTabModules(requestedTab);
    showTab(requestedTab, { activate: false, immediate: true });

    if (requestedTab === 'subs' && App.renderSubs) {
      App.renderSubs();
      const firstMenu = App.$('#subList [data-menu-toggle]');
      if (firstMenu) firstMenu.click();
    }
    if (requestedTab === 'nodes') {
      App.$('#nodeCount').textContent = window.i18n.t('nodes.count', 0);
      App.ui.renderEmptyState(App.$('#nodeList'), {
        iconClass: 'node-empty-icon',
        title: window.i18n.t('nodes.empty'),
        actionLabel: window.i18n.t('nodes.openConfigs'),
        actionName: 'open-configs',
      });
    }
    if (requestedTab === 'groups') seedPolicyGroups();
    if (requestedTab === 'rules') {
      seedRules();
      if (requestedRuleView === 'remote') App.$('#ruleManagerRemoteTab').click();
    }
    if (requestedTab === 'conns' && App.renderConnections) App.renderConnections(fixtureConnections);
    if (requestedTab === 'logs') {
      App.$('#logBox').innerHTML = [
        '<span class="log-entry" data-level="info"><span class="log-time">12:00:01</span> <span class="log-lv info">INFO</span> Runtime configuration loaded successfully.</span>',
        '<span class="log-entry" data-level="info"><span class="log-time">12:00:02</span> <span class="log-lv info">INFO</span> System proxy is active on 127.0.0.1:7890.</span>',
        '<span class="log-entry" data-level="warning"><span class="log-time">12:00:03</span> <span class="log-lv warning">WARN</span> Waiting for the next Smart health sample.</span>',
      ].join('\n');
    }
    if (requestedTab === 'settings' && App.renderSettings) {
      App.renderSettings();
      App.renderCoreStatus(state.status);
      if (App.refreshSelects) App.refreshSelects();
      if (settingsDirty) {
        const mixedPort = App.$('#setMixedPort');
        mixedPort.value = '7891';
        mixedPort.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }

    // Motion is disabled in fixture mode and every render above is synchronous.
    // Mark readiness immediately so background tabs do not depend on timers.
    window.__visualTestReady = readyToken;
  }

  App.visualTest = Object.freeze({ boot });
})();
