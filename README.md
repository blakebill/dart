# Dart

A Windows GUI client for the [sing-box](https://github.com/SagerNet/sing-box) core. Built with Electron.

## 📦 Directory structure

```
singbox-gui/
├── package.json            # Dependencies and electron-builder packaging config
├── bin/                    # Place the sing-box core here (bundled when packaging)
├── src/
│   ├── main/               # Electron main process (one module per concern)
│   │   ├── index.js        # Entry: Electron lifecycle + global error logging
│   │   ├── state.js        # Shared state, paths, log/status senders
│   │   ├── window.js       # BrowserWindow creation, tray hide/show wiring
│   │   ├── tray.js         # Tray icon + menu
│   │   ├── ipc.js          # Every ipcMain handler (payload validation lives here)
│   │   ├── core-control.js # Config build, core start/stop, proxy guard, Clash API
│   │   ├── singbox.js      # sing-box process management + core/geodata download
│   │   ├── subscription.js # Subscription fetching and format dispatch
│   │   ├── converter.js    # Node -> sing-box outbound, full config assembly
│   │   ├── fetch.js        # HTTP(S) helpers: proxy-first with direct fallback
│   │   ├── github.js       # GitHub release lookups with jsDelivr fallback
│   │   ├── update.js       # App release update check
│   │   ├── traffic.js      # Clash API /traffic stream -> renderer
│   │   ├── proxy.js        # Windows system proxy (registry)
│   │   ├── admin.js        # Windows admin detection / elevated relaunch
│   │   ├── uwp.js          # UWP loopback exemption
│   │   ├── store.js        # Atomic JSON persistence
│   │   └── parsers/
│   │       ├── clash.js        # Clash YAML parsing
│   │       └── share-link.js   # Share-link / Base64 subscription parsing
│   ├── preload/index.js    # contextBridge secure bridge (the only IPC surface)
│   └── renderer/           # Front-end UI (no bundler; classic scripts)
│       ├── index.html      # Layout + script load order
│       ├── style.css
│       ├── i18n.js         # zh/en dictionary & switch
│       └── js/             # Modules sharing the window.App namespace
│           ├── util.js     # Namespace bootstrap + shared helpers (loads first)
│           ├── charts.js   # Traffic charts + theme palette
│           ├── dashboard.js# Overview cards, quick actions, proxy mode
│           ├── nodes.js    # Node list, selection, latency tests
│           ├── subs.js     # Subscriptions + raw-content editor
│           ├── rules.js    # Rule list + local rules
│           ├── rulesets.js # Bundled + custom rule-sets
│           ├── conns.js    # Connections (incremental rendering)
│           ├── logs.js     # Log stream
│           ├── settings.js # Settings, core management, in-app updates
│           ├── tools.js    # Config conversion + UWP modals
│           └── main.js     # Entry: tabs, refresh, event streams (loads last)
├── build/
│   └── icon.ico            # App / installer icon
├── scripts/
│   ├── download-core.js    # Download the sing-box core into bin/ before packaging
│   └── make-icon.js        # Generate the placeholder icon build/icon.ico
├── .github/workflows/
│   └── release.yml         # Build and publish the Windows installer
└── test/
    ├── convert.test.js     # Conversion logic (nodes, rules, DNS, config assembly)
    ├── unit.test.js        # i18n parity, renderer wiring, HTML escaping, store
    └── main-smoke.test.js  # Boots the main process; IPC handlers == preload API
```

## 🧪 Tests

```
npm test
```

## 📄 License

GPL v3
