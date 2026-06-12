# sing-box core directory

Place the sing-box core executable in this directory:

- Windows: `sing-box.exe`
- Linux/macOS (development): `sing-box`

How to obtain it:

1. **Build script**: run `npm run fetch-core` to download and extract the core here
   automatically (use `SINGBOX_VERSION=x.y.z` to pin a version).
2. **In-app download**: launch the app → Settings → "Download core".
3. **Manual**: download the archive for your platform from
   https://github.com/SagerNet/sing-box/releases and extract the executable here.

When packaging (`npm run dist`), this directory is copied into the installer under
`resources/bin/` via electron-builder's `extraResources`, so the core ships with the app.

> Note: the core binary itself is ignored in `.gitignore` and is not committed.
