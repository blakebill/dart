# Bundled core directory

`npm run fetch-core` downloads the Windows build bundle here before packaging:

- `mihomo/mihomo.exe`
- `mihomo/geoip.dat`
- `mihomo/geosite.dat`
- `mihomo/country.mmdb`

The generated files are ignored by Git. GitHub Actions runs the same script
before `electron-builder`, and `extraResources` copies this directory into the
installer under `resources/bin/`.

Version pins:

- `MIHOMO_VERSION=1.19.13 npm run fetch-core`

Leave the variables empty to bundle the latest releases.
