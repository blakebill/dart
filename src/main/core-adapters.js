'use strict';

const path = require('path');
const yaml = require('js-yaml');
const { buildMihomoConfig } = require('./converter');
const { assetSha256 } = require('./integrity');

const DART_MIHOMO_REPO = 'blakebill/mihomo';
const OFFICIAL_MIHOMO_REPO = 'MetaCubeX/mihomo';

function releaseRepo(customRepo, officialRepo, source) {
  return source === 'official' ? officialRepo : customRepo;
}

function cleanReleaseAsset(asset) {
  if (!asset) return null;
  const name = String(asset.name || '');
  const url = String(asset.browser_download_url || '');
  if (!name || path.basename(name) !== name || /[\\/]/.test(name) || !url) return null;
  return { fileName: name, url, sha256: assetSha256(asset) };
}

function findReleaseAsset(release, predicate) {
  return ((release && release.assets) || [])
    .map(cleanReleaseAsset)
    .filter((asset) => asset && predicate(asset));
}

const adapters = {
  mihomo: {
    id: 'mihomo',
    label: 'mihomo',
    folderName: 'mihomo',
    resourceFolders: ['mihomo'],
    configFile: 'config.yaml',
    configExtension: '.yaml',
    configFormat: 'YAML',
    repo: DART_MIHOMO_REPO,
    officialRepo: OFFICIAL_MIHOMO_REPO,
    repoFor(source) {
      return releaseRepo(DART_MIHOMO_REPO, OFFICIAL_MIHOMO_REPO, source);
    },
    supportsLiveRuleInspection: true,
    geoDataFiles: [
      'geoip.dat',
      'geosite.dat',
      'country.mmdb',
      'ASN.mmdb',
      'geodata-meta.json',
    ],
    // Derived from the binary + authoritative GeoData. It must never
    // participate in update rollback fingerprints because prepareStart rewrites it.
    geoDataCacheFiles: ['.mihomo-geodata-validation.json'],
    ruleSetItems: [
      { tag: 'geoip', file: 'geoip.dat' },
      { tag: 'geosite', file: 'geosite.dat' },
      { tag: 'country-mmdb', file: 'country.mmdb' },
      { tag: 'asn-mmdb', file: 'ASN.mmdb' },
    ],
    exportDialog: {
      title: 'Export mihomo config',
      defaultPath: 'config.yaml',
      filters: [{ name: 'YAML', extensions: ['yaml', 'yml'] }],
    },
    legacyGeoDirs(runtimeDir, resourcesBinDir) {
      return [
        { loc: 'updated', dir: runtimeDir },
        { loc: 'bundled', dir: resourcesBinDir },
      ];
    },
    binaryName(platform = process.platform) {
      return platform === 'win32' ? 'mihomo.exe' : 'mihomo';
    },
    serializeConfig(config) {
      return yaml.dump(config, { lineWidth: -1, noRefs: true });
    },
    routeEntries(config) {
      return (config.rules || []).map((rule) => ({ kind: 'clash', rule }));
    },
    summarizeConfig(config) {
      return {
        generatedNodes: (config.proxies || []).length,
        generatedRules: (config.rules || []).length,
        tun: !!(config.tun && config.tun.enable),
      };
    },
    dnsOverrideEnabled(config) {
      return !!(config.dns && config.dns.enable);
    },
    dnsPath(config, settings, direct) {
      if (!settings.enableDnsOverride || !config.dns) {
        return { resolver: 'system', server: 'System DNS', detour: 'system', confidence: 'exact' };
      }
      const servers = direct ? config.dns['direct-nameserver'] : config.dns.nameserver;
      const firstServer = Array.isArray(servers) ? servers[0] : servers;
      return {
        resolver: direct ? 'direct-nameserver' : 'nameserver',
        server: firstServer || (direct ? settings.dnsLocal : settings.dnsRemote),
        detour: direct ? 'DIRECT' : '🚀 Proxy',
        confidence: 'estimated',
      };
    },
    checkArgs(configPath, workDir) {
      return ['-t', '-f', configPath, '-d', workDir];
    },
    runArgs(configPath, workDir) {
      return ['-f', configPath, '-d', workDir];
    },
    versionArgs: ['-v'],
    processEnv(baseEnv, { runtimeDir }) {
      const uiRoot = path.join(runtimeDir, 'ui');
      const safePaths = [baseEnv.SAFE_PATHS, uiRoot].filter(Boolean).join(path.delimiter);
      return { ...baseEnv, SAFE_PATHS: safePaths };
    },
    prepareStart(manager) {
      return manager.validateMihomoGeoData();
    },
    geoDataReady(manager) {
      return manager.mihomoGeoDataReady();
    },
    validateGeoFile(manager, file) {
      return manager._validGeoFile(file);
    },
    updateGeoData(manager, onProgress, proxyPort) {
      return manager.updateMihomoGeoData(onProgress, proxyPort);
    },
    sanitizeExport(config) {
      delete config.secret;
    },
    buildConfig(nodes, commonOpts, context) {
      return buildMihomoConfig(nodes, {
        ...commonOpts,
        hasGeoData: context.manager.mihomoGeoDataReady(false),
        externalUiDir: context.ui.dir.replace(/\\/g, '/'),
        externalUiDownloadUrl: context.ui.downloadUrl,
      });
    },
    releaseAsset(version, goos, arch, release, source = 'custom') {
      const ext = goos === 'windows' ? 'zip' : 'gz';
      const canonicalName = `mihomo-${goos}-${arch}-v${version}.${ext}`.toLowerCase();
      const candidates = findReleaseAsset(release, (asset) => {
        const lower = asset.fileName.toLowerCase();
        return /mihomo/i.test(asset.fileName) &&
          lower.includes(goos) &&
          lower.includes(arch) &&
          new RegExp(`\\.${ext}$`, 'i').test(asset.fileName);
      }).sort((a, b) => {
        const rank = (asset) => {
          const lower = asset.fileName.toLowerCase();
          if (lower === canonicalName) return 0;
          if (/compatible/i.test(lower)) return 2;
          if (/(?:^|[-_])(?:go\d+|v[1-3])(?:[-_.]|$)/i.test(lower)) return 3;
          return 1;
        };
        return rank(a) - rank(b);
      });
      if (candidates[0]) return candidates[0];
      // A successful release lookup is authoritative. Silently synthesizing a
      // filename here can select a non-existent or unverifiable build.
      if (release) return null;
      const fileName = `mihomo-${goos}-${arch}-v${version}.${ext}`;
      return {
        fileName,
        url: `https://github.com/${this.repoFor(source)}/releases/download/v${version}/${fileName}`,
        sha256: null,
      };
    },
    modeChangeNeedsRestart(currentMode, nextMode) {
      return currentMode !== nextMode && (currentMode === 'block' || nextMode === 'block');
    },
    singleGzip: true,
    allowBinaryPrefix: true,
  },
};

for (const adapter of Object.values(adapters)) Object.freeze(adapter);
Object.freeze(adapters);

function normalizeCoreType(type) {
  return 'mihomo';
}

function hasCoreAdapter(type) {
  return Object.prototype.hasOwnProperty.call(adapters, type);
}

function getCoreAdapter(type) {
  return adapters[normalizeCoreType(type)];
}

function listCoreAdapters() {
  return Object.values(adapters);
}

module.exports = { getCoreAdapter, hasCoreAdapter, listCoreAdapters, normalizeCoreType };
