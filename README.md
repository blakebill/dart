# Dart Network Control

Dart is a Windows desktop proxy client built with Electron and Mihomo. It provides a native-feeling Windows 11 interface for profile management, routing, traffic inspection, TUN, system proxy control, and adaptive node selection.

This is an independent project and is not affiliated with or endorsed by Mihomo or Zashboard.

## Highlights

- Run either the official Mihomo release or the Dart customized Mihomo build.
- Import Clash YAML, Base64 subscriptions, and supported share links.
- Generate and validate Mihomo YAML before starting the core.
- Use system proxy or administrator-assisted TUN mode.
- Choose Manual, Auto, Fallback, or Smart node selection.
- Inspect connections, traffic, logs, routing rules, DNS paths, and runtime health.
- Update profiles, remote Clash rule lists, GeoData, the core, and the app in place.
- Keep the local controller protected with a per-run secret bound to loopback.

## Requirements

- Windows 10 or Windows 11 (x64)
- Node.js 22 or newer for development
- Administrator approval when enabling TUN

## Quick start

1. Install Dart or run it from source.
2. Add a Clash-compatible profile URL or supported share links.
3. Select a node and routing mode.
4. Start Mihomo, then enable system proxy or TUN as needed.

## Development

```bash
npm ci
npm test
npm run dev
```

Useful commands:

```bash
npm run fetch-core
npm run test:visual
npm run dist
```

`npm run fetch-core` downloads the customized Mihomo Windows binary and required GeoData into `bin/mihomo/`. Set `MIHOMO_VERSION` to pin a release; an empty value resolves the latest stable release.

## Architecture

```text
Renderer (Fluent-style UI)
        │ IPC through contextBridge
        ▼
Electron main process
  ├─ profile and settings store
  ├─ Mihomo config generator
  ├─ core lifecycle and updater
  ├─ system proxy and TUN control
  ├─ Smart/Auto selection services
  └─ diagnostics and connection sampling
        │
        ▼
Mihomo process + authenticated loopback Clash API
```

Important source areas:

```text
src/main/core-manager.js       Core process, downloads, paths, and GeoData
src/main/core-adapters.js      Mihomo runtime capabilities and release assets
src/main/converter.js          Mihomo YAML configuration generation
src/main/core-control.js       Lifecycle, selection, routing, and controller API
src/main/subscription.js       Clash/share-link profile ingestion
src/main/smart-selection.js    Long-term Smart selection model
src/renderer/                  Desktop UI
scripts/download-core.js       Reproducible Mihomo bundle acquisition
```

## Smart selection

Smart makes a stable long-term choice from latency, jitter, failures, connection feedback, signal decay, and network changes. The customized Mihomo Smart group can provide per-connection failover, while the GUI remains responsible for the long-term preferred node. Auto remains available as the simpler lowest-latency strategy.

## Security and privacy

- The controller listens on `127.0.0.1` and uses a randomly generated secret for every app run.
- Profile credentials remain local unless the user explicitly exports a generated configuration.
- Core and GeoData downloads are checked against release SHA-256 metadata when available.
- Subscription requests use Mihomo/Clash-compatible User-Agent values only.
- No telemetry is implemented by Dart.

## Bundled components

| Component | Purpose | License |
| --- | --- | --- |
| [Dart Mihomo fork](https://github.com/blakebill/mihomo) | Proxy runtime bundled with the installer | GPL-3.0-only |
| [Mihomo](https://github.com/MetaCubeX/mihomo) | Optional official runtime source | GPL-3.0-only |
| [MetaCubeX meta-rules-dat](https://github.com/MetaCubeX/meta-rules-dat) | GeoIP, Geosite, and Country MMDB data | GPL-3.0-only |
| [Zashboard](https://github.com/Zephyruso/zashboard) | Local controller panel downloaded on demand | MIT |

The Dart application source is licensed under the MIT License. Bundled third-party components retain their own licenses.
