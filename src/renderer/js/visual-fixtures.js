'use strict';
// Deterministic state used only by the Electron visual-regression harness.
(function () {
  const params = new URLSearchParams(window.location.search);
  if (params.get('visual-test') !== '1') return;

  const App = window.App;
  const GB = 1024 ** 3;
  const theme = params.get('theme') === 'dark' ? 'dark' : 'light';
  const language = params.get('lang') === 'en' ? 'en' : 'zh';
  const requestedTab = params.get('tab') || 'dashboard';
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
        nodeCount: 16,
        updatedAt: now - 46 * 60 * 1000,
        autoUpdateMinutes: 120,
        userInfo: { upload: 2.2 * GB, download: 20 * GB, total: 1000 * GB },
      },
      {
        id: 'fixture-backup',
        name: 'Example Profile C',
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

  async function boot({ ensureTabModules, showTab, setLanguage }) {
    document.documentElement.dataset.visualTest = 'true';
    App.store.replace(state);
    App.delays.set(visualNodeName, 68);
    App.applyTheme(theme, theme);
    setLanguage(language);
    seedTraffic();
    App.renderDashboard();

    await ensureTabModules(requestedTab);
    showTab(requestedTab, { activate: false });

    if (requestedTab === 'subs' && App.renderSubs) App.renderSubs();
    if (requestedTab === 'nodes') {
      App.$('#nodeCount').textContent = window.i18n.t('nodes.count', 0);
      App.ui.renderEmptyState(App.$('#nodeList'), {
        iconClass: 'node-empty-icon',
        title: window.i18n.t('nodes.empty'),
        actionLabel: window.i18n.t('nodes.openConfigs'),
        actionName: 'open-configs',
      });
    }
    if (requestedTab === 'conns' && App.renderConnections) App.renderConnections(fixtureConnections);
    if (requestedTab === 'logs' && App.renderLogEmptyState) App.renderLogEmptyState();
    if (requestedTab === 'settings' && App.renderSettings) {
      App.renderSettings();
      App.renderCoreStatus(state.status);
      if (App.refreshSelects) App.refreshSelects();
    }

    // Motion is disabled in fixture mode and every render above is synchronous.
    // Mark readiness immediately so background tabs do not depend on timers.
    window.__visualTestReady = readyToken;
  }

  App.visualTest = Object.freeze({ boot });
})();
