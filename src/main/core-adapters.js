'use strict';

const path = require('path');
const yaml = require('js-yaml');
const { buildMihomoConfig, buildSingboxConfig } = require('./converter');
const { assetSha256 } = require('./integrity');

const DART_SINGBOX_REPO = 'blakebill/sing-box';
const DART_MIHOMO_REPO = 'blakebill/mihomo';
const OFFICIAL_SINGBOX_REPO = 'SagerNet/sing-box';
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
  'sing-box': {
    id: 'sing-box',
    label: 'sing-box',
    folderName: 'singbox',
    resourceFolders: ['singbox', 'sing-box'],
    configFile: 'config.json',
    configExtension: '.json',
    configFormat: 'JSON',
    repo: DART_SINGBOX_REPO,
    officialRepo: OFFICIAL_SINGBOX_REPO,
    repoFor(source) {
      return releaseRepo(DART_SINGBOX_REPO, OFFICIAL_SINGBOX_REPO, source);
    },
    supportsBinaryRuleSets: true,
    supportsDynamicRuleData: true,
    supportsLiveRuleInspection: false,
    geoDataFiles: ['geoip-cn.srs', 'geosite-cn.srs', 'geodata-meta.json'],
    ruleSetItems: [
      { tag: 'geoip-cn', file: 'geoip-cn.srs' },
      { tag: 'geosite-cn', file: 'geosite-cn.srs' },
    ],
    exportDialog: {
      title: 'Export sing-box config',
      defaultPath: 'config.json',
      filters: [{ name: 'JSON', extensions: ['json'] }],
    },
    legacyGeoDirs(runtimeDir, resourcesBinDir) {
      return [
        { loc: 'updated', dir: path.join(runtimeDir, 'bin') },
        { loc: 'bundled', dir: resourcesBinDir },
      ];
    },
    binaryName(platform = process.platform) {
      return platform === 'win32' ? 'sing-box.exe' : 'sing-box';
    },
    // Runtime configs are written often on start/restart; pretty-print only when
    // exporting for humans (see serializeConfig options.pretty).
    serializeConfig(config, options = {}) {
      return options.pretty ? JSON.stringify(config, null, 2) : JSON.stringify(config);
    },
    routeEntries(config) {
      return (((config.route || {}).rules) || []).map((rule) => ({ kind: 'sing-box', rule }));
    },
    summarizeConfig(config) {
      return {
        generatedNodes: (config.outbounds || [])
          .filter((item) => !['selector', 'urltest', 'smart', 'direct'].includes(item.type)).length,
        generatedRules: (((config.route || {}).rules) || []).length,
        tun: (config.inbounds || []).some((item) => item.type === 'tun'),
      };
    },
    dnsPath(config, settings, direct) {
      return {
        resolver: direct ? 'local-dns' : 'proxy-dns',
        server: direct ? settings.dnsLocal : settings.dnsRemote,
        detour: direct ? 'direct' : '🚀 Proxy',
        confidence: settings.clashMode === 'rule' ? 'estimated' : 'exact',
      };
    },
    checkArgs(configPath) {
      return ['check', '-c', configPath];
    },
    runArgs(configPath, workDir) {
      return ['run', '-c', configPath, '-D', workDir];
    },
    versionArgs: ['version'],
    processEnv(baseEnv) {
      return baseEnv;
    },
    prepareStart() {
      return Promise.resolve(true);
    },
    geoDataReady(manager) {
      return manager.ensureSingBoxGeoData();
    },
    validateGeoFile(manager, file) {
      return manager._validSrs(file);
    },
    updateGeoData(manager, onProgress, proxyPort) {
      return manager._coalesceGeoUpdate(
        'sing-box',
        () => manager._updateSingBoxGeoData(onProgress, proxyPort)
      );
    },
    buildConfig(nodes, commonOpts, context) {
      return buildSingboxConfig(nodes, {
        ...commonOpts,
        externalUiDir: context.ui.dir.replace(/\\/g, '/'),
        externalUiDownloadUrl: context.ui.downloadUrl,
        ruleSetDir: context.manager.resolveRuleSetDir(),
        geoAvailable: context.availableGeoSet(context.clashRules),
        ruleSetData: context.loadRuleSetData(context.clashRules, context.providers),
      });
    },
    releaseAsset(version, goos, arch, release, source = 'custom') {
      const ext = goos === 'windows' ? 'zip' : 'tar.gz';
      const fileName = `sing-box-${version}-${goos}-${arch}.${ext}`;
      const exact = findReleaseAsset(release, (asset) => asset.fileName === fileName)[0];
      return exact || {
        fileName,
        url: `https://github.com/${this.repoFor(source)}/releases/download/v${version}/${fileName}`,
        sha256: null,
      };
    },
    releaseTag(version, source = 'custom') {
      const clean = String(version || '').replace(/^v/, '');
      if (source === 'official') return `v${clean.replace(/-dart\.\d+$/, '')}`;
      return `v${/-dart\.\d+$/.test(clean) ? clean : `${clean}-dart.1`}`;
    },
    modeChangeNeedsRestart() {
      return false;
    },
  },
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
    supportsBinaryRuleSets: false,
    supportsDynamicRuleData: false,
    supportsLiveRuleInspection: true,
    geoDataFiles: [
      'geoip.dat',
      'geosite.dat',
      'country.mmdb',
      'geodata-meta.json',
      '.mihomo-geodata-validation.json',
    ],
    ruleSetItems: [
      { tag: 'geoip', file: 'geoip.dat' },
      { tag: 'geosite', file: 'geosite.dat' },
      { tag: 'country-mmdb', file: 'country.mmdb' },
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
    dnsPath(config, settings, direct) {
      if (!settings.enableTun || !config.dns) {
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
      const candidates = findReleaseAsset(release, (asset) => {
        const lower = asset.fileName.toLowerCase();
        return /mihomo/i.test(asset.fileName) &&
          lower.includes(goos) &&
          lower.includes(arch) &&
          new RegExp(`\\.${ext}$`, 'i').test(asset.fileName);
      }).sort((a, b) =>
        Number(/compatible|go\d+/i.test(a.fileName)) - Number(/compatible|go\d+/i.test(b.fileName))
      );
      if (candidates[0]) return candidates[0];
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
  return type === 'mihomo' ? 'mihomo' : 'sing-box';
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
