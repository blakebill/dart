'use strict';

const crypto = require('crypto');
const { exec } = require('child_process');

/**
 * UWP loopback exemption manager (Windows only).
 *
 * UWP / Microsoft Store apps run in an AppContainer sandbox that, by default,
 * blocks connections to loopback (127.0.0.1). That stops them from using a local
 * proxy. Windows ships `CheckNetIsolation.exe` to manage per-app loopback
 * exemptions; this module enumerates the installed AppContainers (from the
 * registry) and reads/writes the exemption list, mirroring Clash Verge's tool.
 *
 * Setting exemptions requires administrator rights.
 */

function run(cmd) {
  // cmd.exe consoles use the legacy OEM/ANSI code page (e.g. GBK on zh-CN
  // Windows) while Node decodes stdout as UTF-8, which turns non-ASCII app
  // names from `reg query` into U+FFFD mojibake. Switch the console to the
  // UTF-8 code page first so the output decodes correctly.
  const full = process.platform === 'win32' ? 'chcp 65001>nul & ' + cmd : cmd;
  return new Promise((resolve, reject) => {
    exec(full, { windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error((stderr || err.message || '').toString().trim()));
      resolve((stdout || '').toString());
    });
  });
}

const MAP_PATH =
  'HKCU\\Software\\Classes\\Local Settings\\Software\\Microsoft\\Windows\\CurrentVersion\\AppContainer\\Mappings';

/** Run a PowerShell script via -EncodedCommand (avoids all cmd quoting). */
function runPowerShell(script) {
  // The script forces UTF-8 stdout so non-ASCII app names decode correctly.
  const full = '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8\n' + script;
  const b64 = Buffer.from(full, 'utf16le').toString('base64');
  return run(`powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${b64}`);
}

// The complete, system-wide AppContainer enumeration that Fiddler uses:
// FirewallAPI.dll!NetworkIsolationEnumAppContainers. The HKCU registry mappings
// are only a per-user subset (and Fiddler itself falls back to them when this
// API fails), which is why the list looked short. P/Invoke struct layout is
// ported verbatim from the canonical LoopUtil/Loopback.cs reference.
const ENUM_AC_SCRIPT = `
$src = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class AcEnum {
  [StructLayout(LayoutKind.Sequential)]
  struct INET_FIREWALL_AC_CAPABILITIES { public uint count; public IntPtr capabilities; }
  [StructLayout(LayoutKind.Sequential)]
  struct INET_FIREWALL_AC_BINARIES { public uint count; public IntPtr binaries; }
  [StructLayout(LayoutKind.Sequential)]
  struct INET_FIREWALL_APP_CONTAINER {
    internal IntPtr appContainerSid;
    internal IntPtr userSid;
    [MarshalAs(UnmanagedType.LPWStr)] public string appContainerName;
    [MarshalAs(UnmanagedType.LPWStr)] public string displayName;
    [MarshalAs(UnmanagedType.LPWStr)] public string description;
    internal INET_FIREWALL_AC_CAPABILITIES capabilities;
    internal INET_FIREWALL_AC_BINARIES binaries;
    [MarshalAs(UnmanagedType.LPWStr)] public string workingDirectory;
    [MarshalAs(UnmanagedType.LPWStr)] public string packageFullName;
  }
  [DllImport("FirewallAPI.dll")]
  static extern uint NetworkIsolationEnumAppContainers(uint Flags, out uint pdwCntPublicACs, out IntPtr ppACs);
  [DllImport("FirewallAPI.dll")]
  static extern void NetworkIsolationFreeAppContainers(IntPtr pACs);
  // Flags = NETISO_FLAG_FORCE_COMPUTE_BINARIES (1), the value Fiddler's
  // LoopUtil passes so every container is materialized.
  public static List<string[]> Run() {
    var result = new List<string[]>();
    uint count = 0; IntPtr arr = IntPtr.Zero;
    if (NetworkIsolationEnumAppContainers(1, out count, out arr) != 0) return result;
    var baseAddr = arr;
    var size = Marshal.SizeOf(typeof(INET_FIREWALL_APP_CONTAINER));
    var cur = arr;
    for (uint i = 0; i < count; i++) {
      var ac = (INET_FIREWALL_APP_CONTAINER)Marshal.PtrToStructure(cur, typeof(INET_FIREWALL_APP_CONTAINER));
      // SecurityIdentifier(IntPtr) reads the SID straight from native memory —
      // robust, unlike ConvertSidToStringSid whose LocalAlloc'd out-string trips
      // the .NET marshaller's CoTaskMem free on some systems.
      string sid = null;
      try { sid = new System.Security.Principal.SecurityIdentifier(ac.appContainerSid).Value; } catch {}
      result.Add(new string[] { sid, ac.displayName, ac.appContainerName, ac.packageFullName });
      cur = new IntPtr((long)cur + size);
    }
    NetworkIsolationFreeAppContainers(baseAddr);
    return result;
  }
}
'@
Add-Type -TypeDefinition $src | Out-Null
$items = [AcEnum]::Run() | ForEach-Object { @{ sid = $_[0]; displayName = $_[1]; moniker = $_[2]; packageFullName = $_[3] } }
ConvertTo-Json @($items) -Compress
`;

/** Every AppContainer on the system via the Network Isolation API. */
async function listViaFirewallApi() {
  try {
    const out = await runPowerShell(ENUM_AC_SCRIPT);
    const data = JSON.parse(out.trim() || '[]');
    const arr = Array.isArray(data) ? data : [data];
    return arr.filter((a) => a && a.sid && /^S-1-15-2-/i.test(a.sid));
  } catch (e) {
    return [];
  }
}

/** SIDs (app containers) currently exempted from loopback isolation. */
async function listExemptedSids() {
  if (process.platform !== 'win32') return new Set();
  try {
    // Output labels are localized, but the SID tokens are not — match those.
    const out = await run('CheckNetIsolation LoopbackExempt -s');
    const set = new Set();
    for (const m of out.matchAll(/S-1-15-2-[0-9-]+/gi)) set.add(m[0]);
    return set;
  } catch (e) {
    return new Set();
  }
}

/**
 * Derive an AppContainer SID from a package family name (the same derivation
 * Windows' DeriveAppContainerSidFromAppContainerName performs): SHA-256 of
 * the lowercased family name in UTF-16LE; the first 28 bytes become seven
 * little-endian DWORD sub-authorities under S-1-15-2.
 * Verified against the documented SID of Microsoft.MicrosoftEdge_8wekyb3d8bbwe.
 */
function familyNameToSid(family) {
  const h = crypto.createHash('sha256').update(Buffer.from(String(family).toLowerCase(), 'utf16le')).digest();
  const parts = [];
  for (let i = 0; i < 28; i += 4) parts.push(h.readUInt32LE(i));
  return 'S-1-15-2-' + parts.join('-');
}

/** AppContainers from the registry mappings: { sid, moniker, displayName }. */
async function listMappings() {
  let out;
  try {
    out = await run(`reg query "${MAP_PATH}" /s`);
  } catch (e) {
    return [];
  }
  const apps = [];
  let cur = null;
  for (const line of out.split(/\r?\n/)) {
    const keyMatch = line.match(/\\Mappings\\(S-1-15-2-[0-9-]+)\s*$/i);
    if (keyMatch) {
      if (cur) apps.push(cur);
      cur = { sid: keyMatch[1], moniker: '', displayName: '' };
      continue;
    }
    if (!cur) continue;
    const v = line.trim().match(/^(Moniker|DisplayName)\s+REG_SZ\s+(.*)$/i);
    if (v) {
      if (/^Moniker$/i.test(v[1])) cur.moniker = v[2].trim();
      else cur.displayName = v[2].trim();
    }
  }
  if (cur) apps.push(cur);
  return apps;
}

/** Installed (non-framework) Appx packages: { Name, PackageFamilyName }. */
async function listPackages() {
  try {
    const out = await run(
      'powershell -NoProfile -Command "Get-AppxPackage | Select-Object Name,PackageFamilyName,IsFramework | ConvertTo-Json -Compress"'
    );
    const data = JSON.parse(out);
    const arr = Array.isArray(data) ? data : data ? [data] : [];
    return arr.filter((p) => p && p.PackageFamilyName && !p.IsFramework);
  } catch (e) {
    return [];
  }
}

/**
 * Enumerate UWP AppContainers with their current exemption state.
 *
 * Sources, merged by SID (a single source is never complete):
 *   1. NetworkIsolationEnumAppContainers — the system-wide list Fiddler uses;
 *      the authoritative source. Falls back gracefully when the API call
 *      can't run (older Windows, locked-down PowerShell).
 *   2. registry AppContainer mappings — best localized display names, and the
 *      fallback when (1) yields nothing (mirrors Fiddler's own fallback).
 *   3. installed Appx packages, SID derived from the family name — a second
 *      fallback so a non-empty list survives even if both above come up short.
 *   4. SIDs already exempted via CheckNetIsolation — so containers exempted by
 *      other tools stay visible and are not silently wiped on Apply (which
 *      rewrites the whole exemption list).
 */
async function listApps(onLog = () => {}) {
  if (process.platform !== 'win32') return [];
  // Union of every source — the count can only grow, never shrink.
  const [api, exempted, mapped, packages] = await Promise.all([
    listViaFirewallApi(),
    listExemptedSids(),
    listMappings(),
    listPackages(),
  ]);
  // Per-source counts in the log make a short list diagnosable: if the API
  // count is 0 the P/Invoke didn't run and we're on registry fallback.
  onLog(
    `[gui] UWP enumerate: NetworkIsolation API=${api.length}, registry=${mapped.length}, ` +
      `Appx=${packages.length}, exempted=${exempted.size}`
  );

  // Merge keeps the best field seen for each SID: a real (non-@resource)
  // display name wins, then a moniker/family name, then the package full name.
  const bySid = new Map();
  const merge = ({ sid, displayName, moniker, packageFullName }) => {
    if (!sid) return;
    const e = bySid.get(sid) || { sid, displayName: '', moniker: '', packageFullName: '' };
    if (displayName && (!e.displayName || e.displayName.startsWith('@'))) e.displayName = displayName;
    if (moniker && !e.moniker) e.moniker = moniker;
    if (packageFullName && !e.packageFullName) e.packageFullName = packageFullName;
    bySid.set(sid, e);
  };

  for (const a of api) merge(a);
  for (const a of mapped) merge(a); // registry display names refine the API's
  for (const p of packages) {
    merge({ sid: familyNameToSid(p.PackageFamilyName), displayName: p.Name || '', moniker: String(p.PackageFamilyName).toLowerCase() });
  }
  for (const sid of exempted) merge({ sid });

  const apps = [...bySid.values()].map((a) => {
    const name = prettyName(a);
    // Windows system components are published under the cw5n1h2txyewy hash
    // (C:\Windows\SystemApps); everything else counts as a user/Store app.
    const system = /cw5n1h2txyewy/i.test(a.moniker + ' ' + a.packageFullName);
    return { sid: a.sid, name, moniker: a.moniker, packageFullName: a.packageFullName, system, enabled: exempted.has(a.sid) };
  });

  // Disambiguate names that still collide after resolution (e.g. Chrome's many
  // "Chrome Sandbox" containers, or two SIDs of one package) by appending a
  // short distinguisher, so every row is distinct — matching Fiddler.
  const nameCounts = new Map();
  for (const a of apps) nameCounts.set(a.name, (nameCounts.get(a.name) || 0) + 1);
  for (const a of apps) {
    if (nameCounts.get(a.name) > 1) {
      const tail = a.packageFullName || a.moniker || ('…' + a.sid.split('-').pop());
      a.name = `${a.name} (${tail.length > 48 ? tail.slice(0, 47) + '…' : tail})`;
    }
  }
  return apps.sort((a, b) => a.name.localeCompare(b.name));
}

// A readable label for an AppContainer. Many containers carry an UNRESOLVED
// display name — "@{Package?ms-resource://...}", a bare "ms-resource:..." token,
// or empty — which is useless to show. In those cases derive the name from the
// package: "Microsoft.AsyncTextService_8wekyb3d8bbwe" -> "Microsoft.AsyncTextService".
// Containers identified only by a raw GUID are normalized to the canonical
// {UPPERCASE} brace form (Windows' own convention) so casing is consistent.
const GUID_RE = /^\{?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\}?$/i;
function prettyName(a) {
  const dn = a.displayName || '';
  const resolved = dn && !dn.startsWith('@') && !/^ms-resource:/i.test(dn);
  let name;
  if (resolved) {
    name = dn;
  } else {
    const pkg = a.packageFullName || a.moniker || '';
    // Package family/full name is "Name_PublisherId[_version_...]"; the Name
    // part before the first underscore is the human-meaningful piece.
    name = (pkg && pkg.split('_')[0]) || a.sid || '';
  }
  const g = name.match(GUID_RE);
  return g ? '{' + g[1].toUpperCase() + '}' : name;
}

/**
 * Replace the loopback exemption list with exactly the given SIDs.
 * Requires administrator rights (clearing/adding exemptions is privileged).
 */
async function setExemptions(sids) {
  if (process.platform !== 'win32') throw new Error('only supported on Windows');
  await run('CheckNetIsolation LoopbackExempt -c');
  for (const sid of sids || []) {
    if (/^S-1-15-2-[0-9-]+$/i.test(sid)) {
      await run(`CheckNetIsolation LoopbackExempt -a -p="${sid}"`);
    }
  }
  return true;
}

module.exports = { listApps, setExemptions, familyNameToSid, prettyName };
