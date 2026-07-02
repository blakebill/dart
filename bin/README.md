# Bundled core directory

`npm run fetch-core` downloads the Windows build bundle here before packaging:

- `singbox/sing-box.exe`
- `singbox/geoip-cn.srs`
- `singbox/geosite-cn.srs`
- `mihomo/mihomo.exe`
- `mihomo/geoip.dat`
- `mihomo/geosite.dat`
- `mihomo/country.mmdb`

The generated files are ignored by Git. GitHub Actions runs the same script
before `electron-builder`, and `extraResources` copies this directory into the
installer under `resources/bin/`.

Version pins:

- `SINGBOX_VERSION=1.11.4 npm run fetch-core`
- `MIHOMO_VERSION=1.19.13 npm run fetch-core`

Leave the variables empty to bundle the latest releases.
