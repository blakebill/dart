'use strict';

/**
 * Lightweight self-test script (no test framework needed): node test/convert.test.js
 * Verifies the core logic of share-link parsing, Clash parsing, and sing-box conversion.
 */

const assert = require('assert');
const linkParser = require('../src/main/parsers/share-link');
const clashParser = require('../src/main/parsers/clash');
const {
  nodeToOutbound,
  nodeToClashProxy,
  buildSingboxConfig,
  buildMihomoConfig,
  buildRoute,
  clashRulesToSingbox,
  extractRuleGroups,
  extractGeoCategories,
  dnsServerFromAddress,
  ruleListToSingboxRule,
} = require('../src/main/converter');
const { parseSubscriptionContent, parseUserInfo, uniqueNodeNames, configFingerprint } = require('../src/main/subscription');
const { geoDataUrls } = require('../src/main/singbox');

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ✓ ' + name);
  } catch (e) {
    console.error('  ✗ ' + name + '\n    ' + e.message);
    process.exitCode = 1;
  }
}

console.log('Share-link parsing:');

test('parse vmess:// (base64 JSON)', () => {
  const vmessJson = {
    v: '2', ps: 'HK01', add: 'hk.example.com', port: '443', id: 'uuid-1234',
    aid: '0', net: 'ws', host: 'cdn.example.com', path: '/ray', tls: 'tls', scy: 'auto',
  };
  const uri = 'vmess://' + Buffer.from(JSON.stringify(vmessJson)).toString('base64');
  const node = linkParser.parseSingleLink(uri);
  assert.strictEqual(node.type, 'vmess');
  assert.strictEqual(node.server, 'hk.example.com');
  assert.strictEqual(node.port, 443);
  assert.strictEqual(node.uuid, 'uuid-1234');
  assert.strictEqual(node.network, 'ws');
  assert.strictEqual(node.tls, true);
  assert.strictEqual(node.wsOpts.path, '/ray');
  assert.strictEqual(node.wsOpts.headers.Host, 'cdn.example.com');
});

test('parse vless:// (reality)', () => {
  const uri = 'vless://uuid-abcd@1.2.3.4:443?type=tcp&security=reality&pbk=PUBKEY&sid=abcd&fp=chrome&sni=apple.com&flow=xtls-rprx-vision#US-Node';
  const node = linkParser.parseSingleLink(uri);
  assert.strictEqual(node.type, 'vless');
  assert.strictEqual(node.uuid, 'uuid-abcd');
  assert.strictEqual(node.port, 443);
  assert.strictEqual(node.flow, 'xtls-rprx-vision');
  assert.strictEqual(node.tls, true);
  assert.strictEqual(node.reality.publicKey, 'PUBKEY');
  assert.strictEqual(node.servername, 'apple.com');
  assert.strictEqual(node.name, 'US-Node');
});

test('parse trojan://', () => {
  const uri = 'trojan://pass123@tj.example.com:443?sni=tj.example.com&type=ws&path=/tj#JP-Node';
  const node = linkParser.parseSingleLink(uri);
  assert.strictEqual(node.type, 'trojan');
  assert.strictEqual(node.password, 'pass123');
  assert.strictEqual(node.servername, 'tj.example.com');
  assert.strictEqual(node.wsOpts.path, '/tj');
});

test('parse ss:// (SIP002)', () => {
  const userinfo = Buffer.from('aes-256-gcm:password123').toString('base64');
  const uri = `ss://${userinfo}@ss.example.com:8388#SG-Node`;
  const node = linkParser.parseSingleLink(uri);
  assert.strictEqual(node.type, 'ss');
  assert.strictEqual(node.cipher, 'aes-256-gcm');
  assert.strictEqual(node.password, 'password123');
  assert.strictEqual(node.server, 'ss.example.com');
  assert.strictEqual(node.port, 8388);
  assert.strictEqual(node.name, 'SG-Node');
});

test('parse plain SIP002 credentials and reject invalid ports', () => {
  const node = linkParser.parseSingleLink('SS://aes-128-gcm:plain%20password@ss.example.com:443#Plain');
  assert.strictEqual(node.cipher, 'aes-128-gcm');
  assert.strictEqual(node.password, 'plain password');
  assert.strictEqual(node.port, 443);
  assert.strictEqual(linkParser.parseSingleLink('trojan://secret@example.com:70000#bad'), null);
  assert.strictEqual(linkParser.parseSingleLink('ss://YWVzLTEyOC1nY206cA@example.com:443x#bad'), null);
  const malformedVmess = Buffer.from(JSON.stringify({ add: { host: 'example.com' }, port: 443, id: 'x' })).toString('base64');
  assert.strictEqual(linkParser.parseSingleLink('vmess://' + malformedVmess), null);
  const suffixedVmess = Buffer.from(JSON.stringify({ add: 'example.com', port: '443x', id: 'x' })).toString('base64');
  assert.strictEqual(linkParser.parseSingleLink('vmess://' + suffixedVmess), null);
});

test('parse ss:// plugin options and IPv6 endpoint', () => {
  const userinfo = Buffer.from('aes-128-gcm:secret').toString('base64');
  const plugin = encodeURIComponent('v2ray-plugin;mode=websocket;tls;host=cdn.example.com;path=/ws');
  const node = linkParser.parseSingleLink(`ss://${userinfo}@[2001:db8::1]:443/?plugin=${plugin}#IPv6-SS`);
  assert.strictEqual(node.server, '2001:db8::1');
  assert.strictEqual(node.port, 443);
  assert.strictEqual(node.plugin, 'v2ray-plugin');
  assert.deepStrictEqual(node.pluginOpts, {
    mode: 'websocket', tls: true, host: 'cdn.example.com', path: '/ws',
  });
  const outbound = nodeToOutbound(node);
  assert.strictEqual(outbound.plugin, 'v2ray-plugin');
  assert.ok(outbound.plugin_opts.includes('tls'));
  assert.ok(outbound.plugin_opts.includes('host=cdn.example.com'));
});

test('parse ss:// simple-obfs option names', () => {
  const userinfo = Buffer.from('aes-128-gcm:secret').toString('base64');
  const plugin = encodeURIComponent('simple-obfs;obfs=http;obfs-host=edge.example.com');
  const node = linkParser.parseSingleLink(`ss://${userinfo}@ss.example.com:443?plugin=${plugin}#obfs`);
  assert.deepStrictEqual(node.pluginOpts, { mode: 'http', host: 'edge.example.com' });
  const outbound = nodeToOutbound(node);
  assert.strictEqual(outbound.plugin, 'obfs-local');
  assert.strictEqual(outbound.plugin_opts, 'obfs=http;obfs-host=edge.example.com');
});

test('parse hysteria2://', () => {
  const uri = 'hysteria2://pass@hy2.example.com:443?sni=hy2.example.com&insecure=1&obfs=salamander&obfs-password=xyz#HY2';
  const node = linkParser.parseSingleLink(uri);
  assert.strictEqual(node.type, 'hysteria2');
  assert.strictEqual(node.password, 'pass');
  assert.strictEqual(node.obfs, 'salamander');
  assert.strictEqual(node.obfsPassword, 'xyz');
  assert.strictEqual(node.skipCertVerify, true);
});

test('parse base64 bulk subscription', () => {
  const links = [
    'trojan://p1@a.com:443#node1',
    'trojan://p2@b.com:443#node2',
  ].join('\n');
  const b64 = Buffer.from(links).toString('base64');
  const nodes = linkParser.parseSubscriptionLinks(b64);
  assert.strictEqual(nodes.length, 2);
  assert.strictEqual(nodes[0].name, 'node1');
});

console.log('\nClash config parsing:');

const clashYaml = `
port: 7890
proxies:
  - name: "HK-vmess"
    type: vmess
    server: hk.example.com
    port: 443
    uuid: uuid-xyz
    alterId: 0
    cipher: auto
    network: ws
    tls: true
    servername: cdn.example.com
    ws-opts:
      path: /path
      headers:
        Host: cdn.example.com
  - name: "US-ss"
    type: ss
    server: us.example.com
    port: 8388
    cipher: aes-128-gcm
    password: pass
  - name: "JP-trojan"
    type: trojan
    server: jp.example.com
    port: 443
    password: tjpass
    sni: jp.example.com
proxy-groups:
  - name: PROXY
    type: select
    proxies: [HK-vmess, US-ss, JP-trojan]
`;

test('detect Clash config', () => {
  assert.strictEqual(clashParser.isClashConfig(clashYaml), true);
});

test('Clash proxy types are case-insensitive', () => {
  const parsed = clashParser.parseClashConfig(`proxies:\n  - name: upper\n    type: TROJAN\n    server: example.com\n    port: 443\n    password: secret`);
  assert.strictEqual(parsed.nodes.length, 1);
  assert.strictEqual(parsed.nodes[0].type, 'trojan');
});

test('parse Clash proxies', () => {
  const { nodes, groups } = clashParser.parseClashConfig(clashYaml);
  assert.strictEqual(nodes.length, 3);
  assert.strictEqual(nodes[0].type, 'vmess');
  assert.strictEqual(nodes[0].wsOpts.path, '/path');
  assert.strictEqual(nodes[1].type, 'ss');
  assert.strictEqual(nodes[2].type, 'trojan');
  assert.strictEqual(groups.length, 1);
});

test('Clash parser rejects malformed endpoints and out-of-range ports', () => {
  const { nodes } = clashParser.parseClashConfig(`proxies:
  - { name: good, type: trojan, server: example.com, port: "443", password: p }
  - { name: negative, type: trojan, server: example.com, port: -1, password: p }
  - { name: overflow, type: trojan, server: example.com, port: 70000, password: p }
  - { name: suffix, type: trojan, server: example.com, port: 443x, password: p }
  - { name: object, type: trojan, server: { host: example.com }, port: 443, password: p }`);
  assert.deepStrictEqual(nodes.map((node) => node.name), ['good']);
});

console.log('\nsing-box conversion:');

test('vmess node -> outbound', () => {
  const { nodes } = clashParser.parseClashConfig(clashYaml);
  const ob = nodeToOutbound(nodes[0]);
  assert.strictEqual(ob.type, 'vmess');
  assert.strictEqual(ob.server, 'hk.example.com');
  assert.strictEqual(ob.uuid, 'uuid-xyz');
  assert.strictEqual(ob.tls.enabled, true);
  assert.strictEqual(ob.tls.server_name, 'cdn.example.com');
  assert.strictEqual(ob.transport.type, 'ws');
  assert.strictEqual(ob.transport.path, '/path');
  assert.strictEqual(ob.transport.headers.Host, 'cdn.example.com');
});

test('trojan node -> outbound', () => {
  const { nodes } = clashParser.parseClashConfig(clashYaml);
  const ob = nodeToOutbound(nodes[2]);
  assert.strictEqual(ob.type, 'trojan');
  assert.strictEqual(ob.password, 'tjpass');
  assert.strictEqual(ob.tls.enabled, true);
  assert.strictEqual(ob.tls.server_name, 'jp.example.com');
});

test('full Clash -> sing-box config', () => {
  const { nodes } = clashParser.parseClashConfig(clashYaml);
  const config = buildSingboxConfig(nodes, {});
  // Structure checks
  assert.ok(config.log);
  assert.ok(config.dns);
  assert.ok(Array.isArray(config.inbounds));
  assert.ok(Array.isArray(config.outbounds));
  assert.ok(config.route);
  // Inbounds include mixed
  assert.ok(config.inbounds.some((i) => i.type === 'mixed' && i.listen_port === 7890));
  // Outbounds include selector / automatic groups / 3 nodes / direct.
  const types = config.outbounds.map((o) => o.type);
  assert.ok(types.includes('selector'));
  assert.ok(types.includes('urltest'));
  assert.ok(config.outbounds.some((o) => o.tag === '🛟 Fallback' && o.type === 'urltest'));
  assert.ok(config.outbounds.find((o) => o.tag === '🚀 Proxy').outbounds.includes('🛟 Fallback'));
  assert.ok(types.includes('direct'));
  assert.ok(!types.includes('block'), 'block outbound removed in 1.12+');
  assert.strictEqual(config.outbounds.filter((o) => ['vmess', 'shadowsocks', 'trojan'].includes(o.type)).length, 3);
  // selector includes all node tags
  const selector = config.outbounds.find((o) => o.type === 'selector');
  assert.ok(selector.outbounds.includes('HK-vmess'));
  assert.ok(selector.outbounds.includes('US-ss'));
  // DNS uses the new 1.12+ server format (type/server, not address)
  assert.ok(config.dns.servers.every((s) => s.type && !s.address), 'DNS servers use new format');
  // route final
  assert.strictEqual(config.route.final, '🚀 Proxy');
  // clash api
  assert.ok(config.experimental.clash_api.external_controller.includes('9090'));
});

test('deduplicate nodes with duplicate names', () => {
  const nodes = [
    { type: 'trojan', name: 'dup', server: 'a.com', port: 443, password: 'p' },
    { type: 'trojan', name: 'dup', server: 'b.com', port: 443, password: 'p' },
  ];
  const config = buildSingboxConfig(nodes, {});
  const tags = config.outbounds.filter((o) => o.type === 'trojan').map((o) => o.tag);
  assert.strictEqual(new Set(tags).size, 2, 'duplicate tags should be deduplicated');
});

test('configs reject profiles with no supported proxy nodes', () => {
  assert.throws(() => buildSingboxConfig([{ type: 'unsupported', name: 'bad' }]), /No supported proxy nodes/);
  assert.throws(() => buildMihomoConfig([{ type: 'unsupported', name: 'bad' }]), /No supported proxy nodes/);
});

test('node -> Mihomo proxy', () => {
  const { nodes } = clashParser.parseClashConfig(clashYaml);
  const proxy = nodeToClashProxy(nodes[0]);
  assert.strictEqual(proxy.type, 'vmess');
  assert.strictEqual(proxy.name, 'HK-vmess');
  assert.strictEqual(proxy.server, 'hk.example.com');
  assert.strictEqual(proxy.network, 'ws');
  assert.strictEqual(proxy.tls, true);
  assert.strictEqual(proxy['ws-opts'].path, '/path');
});

test('full config for Mihomo keeps Clash semantics', () => {
  const { nodes } = clashParser.parseClashConfig(clashYaml);
  const cfg = buildMihomoConfig(nodes, {
    mixedPort: 7891,
    clashApiPort: 9091,
    clashApiSecret: 'secret',
    selected: 'US-ss',
    clashRules: ['DOMAIN-SUFFIX,openai.com,Proxy', 'DOMAIN,example.cn,DIRECT'],
    externalUiDir: 'C:/Users/test/AppData/Roaming/Dart/runtime/ui/zashboard',
    externalUiDownloadUrl: 'https://github.com/Zephyruso/zashboard/releases/latest/download/dist.zip',
  });
  assert.strictEqual(cfg['mixed-port'], 7891);
  assert.strictEqual(cfg['external-controller'], '127.0.0.1:9091');
  assert.strictEqual(cfg.secret, 'secret');
  assert.strictEqual(cfg['external-ui'], 'C:/Users/test/AppData/Roaming/Dart/runtime/ui/zashboard');
  assert.strictEqual(
    cfg['external-ui-url'],
    'https://github.com/Zephyruso/zashboard/releases/latest/download/dist.zip'
  );
  assert.strictEqual(cfg['geodata-mode'], true);
  assert.strictEqual(cfg['geodata-loader'], 'memconservative');
  assert.strictEqual(cfg.proxies.length, 3);
  assert.deepStrictEqual(cfg['proxy-groups'][0].proxies.slice(0, 3), ['US-ss', '♻️ Auto', '🛟 Fallback']);
  assert.ok(cfg['proxy-groups'].some((group) => group.name === '🛟 Fallback' && group.type === 'fallback'));
  assert.ok(cfg.rules.includes('DOMAIN-SUFFIX,openai.com,🚀 Proxy'));
  assert.ok(cfg.rules.includes('DOMAIN,example.cn,DIRECT'));
  assert.strictEqual(cfg.rules[cfg.rules.length - 1], 'MATCH,🚀 Proxy');
});

test('Mihomo fallback skips GEOIP when GeoData is unavailable', () => {
  const cfg = buildMihomoConfig([{ type: 'trojan', name: 'n', server: 'a.com', port: 443, password: 'p' }], {
    clashRules: ['GEOIP,CN,DIRECT', 'GEOSITE,category-ads-all,REJECT', 'DOMAIN-SUFFIX,openai.com,PROXY'],
    hasGeoData: false,
  });
  assert.strictEqual(cfg['geo-auto-update'], false);
  assert.ok(!cfg.rules.includes('GEOIP,CN,DIRECT'));
  assert.ok(!cfg.rules.includes('GEOSITE,category-ads-all,REJECT'));
  assert.ok(cfg.rules.includes('DOMAIN-SUFFIX,openai.com,🚀 Proxy'));
  assert.ok(cfg.rules.includes('MATCH,🚀 Proxy'));
});

test('Mihomo TUN mode emits tun configuration', () => {
  const cfg = buildMihomoConfig([{ type: 'trojan', name: 'n', server: 'a.com', port: 443, password: 'p' }], {
    enableTun: true,
    enableIpv6: false,
    dnsRemote: 'https://1.1.1.1/dns-query',
    dnsLocal: 'https://223.5.5.5/dns-query',
  });
  assert.strictEqual(cfg.tun.enable, true);
  assert.strictEqual(cfg.tun.stack, 'mixed');
  assert.strictEqual(cfg.tun.device, 'Dart');
  assert.strictEqual(cfg.tun['auto-route'], true);
  assert.strictEqual(cfg.tun['auto-detect-interface'], true);
  assert.deepStrictEqual(cfg.tun['dns-hijack'], ['any:53', 'tcp://any:53']);
  assert.strictEqual(cfg.dns.enable, true);
  assert.strictEqual(cfg.dns.ipv6, false);
  assert.strictEqual(cfg.dns['enhanced-mode'], 'fake-ip');
  assert.deepStrictEqual(cfg.dns.nameserver, ['https://1.1.1.1/dns-query']);
  assert.deepStrictEqual(cfg.dns['proxy-server-nameserver'], ['https://223.5.5.5/dns-query']);
  assert.strictEqual(cfg.dns['respect-rules'], true);
});

console.log('\nAuto format detection:');

test('parseSubscriptionContent detects Clash', () => {
  const res = parseSubscriptionContent(clashYaml);
  assert.strictEqual(res.format, 'clash');
  assert.strictEqual(res.nodes.length, 3);
});

test('parseSubscriptionContent detects share links', () => {
  const res = parseSubscriptionContent('trojan://p@a.com:443#n1\ntrojan://p@b.com:443#n2');
  assert.strictEqual(res.format, 'links');
  assert.strictEqual(res.nodes.length, 2);
});

test('subscription node names are unique and cannot shadow strategy groups', () => {
  const res = parseSubscriptionContent([
    'trojan://p@a.com:443#dup',
    'trojan://p@b.com:443#dup',
    'trojan://p@c.com:443#%E2%99%BB%EF%B8%8F%20Auto',
  ].join('\n'));
  assert.deepStrictEqual(res.nodes.map((node) => node.name), ['dup', 'dup 2', '♻️ Auto 2']);
});

test('TUN inbound', () => {
  const config = buildSingboxConfig([{ type: 'trojan', name: 'n', server: 'a.com', port: 443, password: 'p' }], { enableTun: true });
  const tun = config.inbounds.find((inbound) => inbound.type === 'tun');
  assert.ok(tun);
  assert.strictEqual(tun.interface_name, 'Dart');
});

test('clash_api secret is included when given, absent otherwise', () => {
  const node = { type: 'trojan', name: 'n', server: 'a.com', port: 443, password: 'p' };
  const withSecret = buildSingboxConfig([node], { clashApiSecret: 's3cret' });
  assert.strictEqual(withSecret.experimental.clash_api.secret, 's3cret');
  const noSecret = buildSingboxConfig([node], {});
  assert.ok(!('secret' in noSecret.experimental.clash_api));
});

test('clash_api hosts a local panel when externalUi opts are set', () => {
  const node = { type: 'trojan', name: 'n', server: 'a.com', port: 443, password: 'p' };
  const config = buildSingboxConfig([node], {
    externalUiDir: '/tmp/ui/zashboard',
    externalUiDownloadUrl: 'https://example.com/dist.zip',
  });
  const c = config.experimental.clash_api;
  assert.strictEqual(c.external_ui, '/tmp/ui/zashboard');
  assert.strictEqual(c.external_ui_download_url, 'https://example.com/dist.zip');
  assert.strictEqual(c.external_ui_download_detour, '🚀 Proxy');
  // And absent when not configured.
  const plain = buildSingboxConfig([node], {});
  assert.ok(!('external_ui' in plain.experimental.clash_api));
});

test('Block mode rejects everything via a top clash_mode rule', () => {
  const config = buildSingboxConfig([{ type: 'trojan', name: 'n', server: 'a.com', port: 443, password: 'p' }], {});
  const rules = config.route.rules;
  const blockIdx = rules.findIndex((r) => r.clash_mode === 'block');
  assert.ok(blockIdx >= 0, 'Block rule present');
  assert.strictEqual(rules[blockIdx].action, 'reject');
  // It must sit above every routing decision (only sniff/dns hijack before it).
  const directIdx = rules.findIndex((r) => r.clash_mode === 'direct');
  assert.ok(blockIdx < directIdx, 'Block precedes other mode rules');
});

test('sing-box mode rules use the lowercase values emitted by the Clash API', () => {
  const config = buildSingboxConfig([{ type: 'trojan', name: 'n', server: 'a.com', port: 443, password: 'p' }], {});
  assert.deepStrictEqual(
    config.route.rules.filter((rule) => rule.clash_mode).map((rule) => rule.clash_mode),
    ['block', 'direct', 'global']
  );
  assert.deepStrictEqual(config.dns.rules.slice(0, 2).map((rule) => rule.clash_mode), ['direct', 'global']);
});

test('custom latency URL is used by both cores health-check groups', () => {
  const node = { type: 'trojan', name: 'n', server: 'a.com', port: 443, password: 'p' };
  const testUrl = 'https://example.com/ping';
  const singbox = buildSingboxConfig([node], { testUrl });
  assert.ok(singbox.outbounds.filter((outbound) => outbound.type === 'urltest').every((outbound) => outbound.url === testUrl));
  const mihomo = buildMihomoConfig([node], { testUrl });
  assert.ok(mihomo['proxy-groups'].filter((group) => ['url-test', 'fallback'].includes(group.type)).every((group) => group.url === testUrl));
});

test('interface binding only in TUN mode (VPN/WireGuard coexistence)', () => {
  const node = { type: 'trojan', name: 'n', server: 'a.com', port: 443, password: 'p' };
  const tun = buildSingboxConfig([node], { enableTun: true });
  assert.strictEqual(tun.route.auto_detect_interface, true);
  // Without TUN there is no routing loop to avoid; leaving sockets unbound lets
  // them follow the routing table (e.g. into an active WireGuard tunnel).
  const sysProxy = buildSingboxConfig([node], { enableTun: false });
  assert.strictEqual(sysProxy.route.auto_detect_interface, undefined);
});

console.log('\nClash rules conversion:');

test('clashRulesToSingbox maps common rule types', () => {
  const { rules } = clashRulesToSingbox([
    'DOMAIN-SUFFIX,google.com,PROXY',
    'DOMAIN,example.com,DIRECT',
    'DOMAIN-KEYWORD,github,PROXY',
    'IP-CIDR,192.168.0.0/16,DIRECT,no-resolve',
    'DST-PORT,80,PROXY',
    'GEOIP,CN,DIRECT',
    'PROCESS-NAME,Telegram.exe,PROXY',
    'REJECT-RULE,ads.com,REJECT', // unknown type -> skipped
    'MATCH,PROXY', // final -> ignored
  ]);
  assert.deepStrictEqual(rules[0], { domain_suffix: ['google.com'], outbound: '🚀 Proxy' });
  assert.deepStrictEqual(rules[1], { domain: ['example.com'], outbound: 'direct' });
  assert.deepStrictEqual(rules[2], { domain_keyword: ['github'], outbound: '🚀 Proxy' });
  assert.deepStrictEqual(rules[3], { ip_cidr: ['192.168.0.0/16'], outbound: 'direct' });
  assert.deepStrictEqual(rules[4], { port: [80], outbound: '🚀 Proxy' });
  assert.deepStrictEqual(rules[5], { rule_set: ['geoip-cn'], outbound: 'direct' });
  assert.deepStrictEqual(rules[6], { process_name: ['Telegram.exe'], outbound: '🚀 Proxy' });
  assert.strictEqual(rules.length, 7, 'unknown type and MATCH are skipped');
});

test('REJECT target becomes a reject action', () => {
  const { rules } = clashRulesToSingbox(['DOMAIN,ad.com,REJECT']);
  assert.deepStrictEqual(rules[0], { domain: ['ad.com'], action: 'reject' });
});

test('buildSingboxConfig injects converted Clash rules before the geoip fallback', () => {
  const nodes = [{ type: 'trojan', name: 'N', server: 'a.com', port: 443, password: 'p' }];
  const config = buildSingboxConfig(nodes, {
    ruleSetDir: '/geo', // geodata present, so the geoip-cn fallback is emitted
    clashRules: ['DOMAIN-SUFFIX,openai.com,PROXY'],
  });
  const idxConverted = config.route.rules.findIndex(
    (r) => Array.isArray(r.domain_suffix) && r.domain_suffix.includes('openai.com')
  );
  const idxGeoip = config.route.rules.findIndex(
    (r) => Array.isArray(r.rule_set) && r.rule_set.includes('geoip-cn')
  );
  assert.ok(idxConverted > -1, 'converted rule present');
  assert.ok(idxConverted < idxGeoip, 'converted rule comes before geoip-cn fallback');
});

console.log('\nDNS address parsing:');

test('dnsServerFromAddress parses DoH/DoT/UDP', () => {
  assert.deepStrictEqual(dnsServerFromAddress('https://1.1.1.1/dns-query', 'r', '🚀 Proxy'), {
    tag: 'r', type: 'https', server: '1.1.1.1', detour: '🚀 Proxy',
  });
  assert.deepStrictEqual(dnsServerFromAddress('tls://8.8.8.8', 'l'), {
    tag: 'l', type: 'tls', server: '8.8.8.8',
  });
  assert.deepStrictEqual(dnsServerFromAddress('223.5.5.5', 'l'), {
    tag: 'l', type: 'udp', server: '223.5.5.5',
  });
  // custom DoH path is preserved
  const doh = dnsServerFromAddress('https://dns.google/resolve', 'r');
  assert.strictEqual(doh.type, 'https');
  assert.strictEqual(doh.server, 'dns.google');
  assert.strictEqual(doh.path, '/resolve');
  assert.deepStrictEqual(dnsServerFromAddress('udp://[2001:4860:4860::8888]:5353', 'v6'), {
    tag: 'v6', type: 'udp', server: '2001:4860:4860::8888', server_port: 5353,
  });
  assert.deepStrictEqual(dnsServerFromAddress('[2001:4860:4860::8844]', 'v6'), {
    tag: 'v6', type: 'udp', server: '2001:4860:4860::8844',
  });
  assert.throws(() => dnsServerFromAddress('udp://1.1.1.1:70000', 'bad'), /invalid DNS server port/);
});

test('buildSingboxConfig honors custom DNS + strategy', () => {
  const cfg = buildSingboxConfig([{ type: 'trojan', name: 'N', server: 'a.com', port: 443, password: 'p' }], {
    dnsRemote: 'tls://9.9.9.9',
    dnsLocal: '119.29.29.29',
    dnsStrategy: 'prefer_ipv6',
  });
  const remote = cfg.dns.servers.find((s) => s.tag === 'proxy-dns');
  const local = cfg.dns.servers.find((s) => s.tag === 'local-dns');
  assert.strictEqual(remote.type, 'tls');
  assert.strictEqual(remote.server, '9.9.9.9');
  assert.strictEqual(local.type, 'udp');
  assert.strictEqual(local.server, '119.29.29.29');
  assert.strictEqual(cfg.dns.strategy, 'prefer_ipv6');
});

test('TUN inbound uses mixed stack + mtu', () => {
  const cfg = buildSingboxConfig([{ type: 'trojan', name: 'N', server: 'a.com', port: 443, password: 'p' }], {
    enableTun: true,
  });
  const tun = cfg.inbounds.find((i) => i.type === 'tun');
  assert.ok(tun);
  assert.strictEqual(tun.stack, 'mixed');
  assert.strictEqual(tun.mtu, 9000);
});

console.log('\nCustom rule-set conversion:');

test('ruleListToSingboxRule parses Clash classical lines', () => {
  const { rule, rules, count } = ruleListToSingboxRule(
    [
      '# comment',
      'DOMAIN-SUFFIX,google.com',
      'DOMAIN,example.com',
      'DOMAIN-KEYWORD,telegram',
      'IP-CIDR,1.1.1.0/24,no-resolve',
      'USER-AGENT,Foo*', // unsupported -> skipped
    ].join('\n'),
    'proxy'
  );
  assert.strictEqual(count, 4);
  assert.strictEqual(rule, null, 'mixed matcher fields are emitted as multiple OR rules');
  assert.strictEqual(rules.length, 4);
  const byField = Object.fromEntries(
    rules.map((r) => [Object.keys(r).find((k) => k !== 'outbound' && k !== 'action'), r])
  );
  assert.deepStrictEqual(byField.domain_suffix, { domain_suffix: ['google.com'], outbound: '🚀 Proxy' });
  assert.deepStrictEqual(byField.domain, { domain: ['example.com'], outbound: '🚀 Proxy' });
  assert.deepStrictEqual(byField.domain_keyword, { domain_keyword: ['telegram'], outbound: '🚀 Proxy' });
  assert.deepStrictEqual(byField.ip_cidr, { ip_cidr: ['1.1.1.0/24'], outbound: '🚀 Proxy' });
});

test('ruleListToSingboxRule handles a domain list + reject target', () => {
  const { rule, rules } = ruleListToSingboxRule('payload:\n  - "+.ads.com"\n  - .track.net\n  - plain.com', 'reject');
  assert.strictEqual(rules.length, 1);
  assert.deepStrictEqual(rule.domain_suffix, ['ads.com', 'track.net', 'plain.com']);
  assert.strictEqual(rule.action, 'reject');
  assert.ok(!rule.outbound);
});

test('custom rules inject into the config before geoip fallback', () => {
  const { rules } = ruleListToSingboxRule('DOMAIN-SUFFIX,openai.com', 'proxy');
  const cfg = buildSingboxConfig([{ type: 'trojan', name: 'N', server: 'a.com', port: 443, password: 'p' }], {
    ruleSetDir: '/geo', // geodata present, so the geoip-cn fallback is emitted
    extraRules: rules,
  });
  const i = cfg.route.rules.findIndex((r) => Array.isArray(r.domain_suffix) && r.domain_suffix.includes('openai.com'));
  const g = cfg.route.rules.findIndex((r) => Array.isArray(r.rule_set) && r.rule_set.includes('geoip-cn'));
  assert.ok(i > -1 && i < g);
});

test('buildRoute matches the full config route block', () => {
  const opts = {
    ruleSetDir: '/geo', // geodata present -> local rule-sets
    clashRules: ['DOMAIN-SUFFIX,openai.com,PROXY', 'DOMAIN,direct.test,DIRECT'],
    extraRules: [{ domain: ['x.com'], action: 'reject' }],
    extraRuleSets: [{ type: 'local', tag: 'custom-1', format: 'binary', path: '/x.srs' }],
  };
  const route = buildRoute(opts);
  const cfg = buildSingboxConfig([{ type: 'trojan', name: 'A', server: 'a.com', port: 443, password: 'p' }], opts);
  assert.deepStrictEqual(route.rules, cfg.route.rules);
  assert.deepStrictEqual(route.rule_set, cfg.route.rule_set);
  // The geo rule-sets are local (bundled), never remote (a remote fetch is
  // fatal at startup in sing-box).
  assert.ok(route.rule_set.every((rs) => rs.type === 'local'));
  // The custom inline rule precedes the geoip/geosite fallback.
  const r = route.rules.findIndex((x) => Array.isArray(x.domain) && x.domain.includes('x.com'));
  const g = route.rules.findIndex((x) => Array.isArray(x.rule_set) && x.rule_set.includes('geoip-cn'));
  assert.ok(r > -1 && r < g);
});

test('without geodata, the route never references an undefined rule-set', () => {
  // A fresh install has no .srs (ruleSetDir = null). The config must degrade —
  // no remote rule-sets, no geoip-cn/geosite-cn references anywhere — so the
  // core boots instead of fatally failing to fetch a remote rule-set.
  const opts = {
    ruleSetDir: null,
    // Defensive case: even if a caller accidentally says the geo tags are
    // available, no local rule_set may be emitted without a real directory.
    geoAvailable: new Set(['geoip-cn', 'geosite-cn']),
    // A GEOIP,CN rule would normally convert to a geoip-cn reference.
    clashRules: ['GEOIP,CN,DIRECT', 'DOMAIN-SUFFIX,openai.com,PROXY'],
  };
  const cfg = buildSingboxConfig([{ type: 'trojan', name: 'A', server: 'a.com', port: 443, password: 'p' }], opts);
  // No rule-set definitions beyond any custom ones (none here).
  assert.deepStrictEqual(cfg.route.rule_set, []);
  // No remote rule-sets anywhere.
  assert.ok(!JSON.stringify(cfg).includes('"type":"remote"'));
  // Nothing references the (now undefined) geo rule-sets — route or DNS.
  const refs = JSON.stringify(cfg.route.rules) + JSON.stringify(cfg.dns.rules);
  assert.ok(!refs.includes('geoip-cn') && !refs.includes('geosite-cn'));
  // The GEOIP,CN rule was dropped, but the normal proxy rule survives.
  assert.ok(JSON.stringify(cfg.route.rules).includes('openai.com'));
});

console.log('\nAnyTLS:');

test('parse anytls (Clash) -> outbound with tls', () => {
  const { nodes } = clashParser.parseClashConfig('proxies:\n  - {name: AT, type: anytls, server: a.com, port: 8443, password: pw, sni: a.com, alpn: [h2], client-fingerprint: chrome}');
  assert.strictEqual(nodes.length, 1);
  assert.strictEqual(nodes[0].type, 'anytls');
  const ob = nodeToOutbound(nodes[0]);
  assert.strictEqual(ob.type, 'anytls');
  assert.strictEqual(ob.password, 'pw');
  assert.strictEqual(ob.tls.enabled, true);
  assert.strictEqual(ob.tls.server_name, 'a.com');
  assert.deepStrictEqual(ob.tls.alpn, ['h2']);
  assert.strictEqual(ob.tls.utls.fingerprint, 'chrome');
});

test('parse anytls:// share link', () => {
  const node = linkParser.parseSingleLink('anytls://pw@a.com:8443?sni=a.com&insecure=1#AT');
  assert.strictEqual(node.type, 'anytls');
  assert.strictEqual(node.password, 'pw');
  assert.strictEqual(node.servername, 'a.com');
  assert.strictEqual(node.skipCertVerify, true);
});

console.log('\nSubscription rule policy-group overrides:');

test('extractRuleGroups returns distinct proxy groups, excluding DIRECT/REJECT/MATCH', () => {
  const rules = [
    'DOMAIN-SUFFIX,netflix.com,Streaming',
    'DOMAIN-SUFFIX,google.com,ProxyPick',
    'DOMAIN-SUFFIX,youtube.com,Streaming', // dup group
    'GEOIP,CN,DIRECT',
    'DOMAIN-KEYWORD,ad,REJECT',
    'MATCH,ProxyPick',
  ];
  assert.deepStrictEqual(extractRuleGroups(rules), ['ProxyPick', 'Streaming']);
});

test('clashRulesToSingbox honors per-group outbound overrides', () => {
  const rules = [
    'DOMAIN-SUFFIX,netflix.com,Streaming',
    'DOMAIN-SUFFIX,google.com,ProxyPick',
    'DOMAIN-KEYWORD,ad,Ads',
    'DOMAIN,example.cn,DIRECT',
  ];
  const overrides = { Streaming: 'direct', Ads: 'reject' };
  const out = clashRulesToSingbox(rules, true, overrides).rules;
  assert.strictEqual(out[0].outbound, 'direct'); // Streaming -> direct
  assert.strictEqual(out[1].outbound, '🚀 Proxy'); // ProxyPick -> default selector
  assert.strictEqual(out[2].action, 'reject'); // Ads -> reject
  assert.ok(!out[2].outbound, 'reject sets action, not outbound');
  assert.strictEqual(out[3].outbound, 'direct'); // explicit DIRECT untouched
});

console.log('\nGEOSITE / GEOIP categories:');

test('extractGeoCategories collects geosite/geoip refs, dedupes, skips exotic names', () => {
  const cats = extractGeoCategories([
    'GEOSITE,cn,DIRECT',
    'GEOSITE,category-ads-all,REJECT',
    'GEOSITE,cn,Proxy', // dup tag
    'GEOIP,JP,Proxy',
    'GEOSITE,geolocation-!cn,Proxy', // exotic "!" -> skipped
    'DOMAIN,x.com,DIRECT', // not geo
  ]);
  const tags = cats.map((c) => c.tag).sort();
  assert.deepStrictEqual(tags, ['geoip-jp', 'geosite-category-ads-all', 'geosite-cn']);
  const ads = cats.find((c) => c.tag === 'geosite-category-ads-all');
  assert.strictEqual(ads.repo, 'sing-geosite');
  assert.strictEqual(ads.file, 'geosite-category-ads-all.srs');
  assert.strictEqual(cats.find((c) => c.tag === 'geoip-jp').repo, 'sing-geoip');
});

test('clashRulesToSingbox emits GEOSITE/GEOIP only for available tags', () => {
  const rules = [
    'GEOSITE,category-ads-all,REJECT',
    'GEOSITE,cn,DIRECT',
    'GEOIP,JP,Proxy',
    'GEOSITE,netflix,Proxy', // not available -> dropped
  ];
  const avail = new Set(['geosite-cn', 'geosite-category-ads-all', 'geoip-jp']);
  const { rules: out, usedGeoTags } = clashRulesToSingbox(rules, true, null, avail);
  assert.deepStrictEqual(out[0], { rule_set: ['geosite-category-ads-all'], action: 'reject' });
  assert.deepStrictEqual(out[1], { rule_set: ['geosite-cn'], outbound: 'direct' });
  assert.deepStrictEqual(out[2], { rule_set: ['geoip-jp'], outbound: '🚀 Proxy' });
  assert.strictEqual(out.length, 3, 'the unavailable geosite-netflix rule is dropped');
  assert.deepStrictEqual([...usedGeoTags].sort(), ['geoip-jp', 'geosite-category-ads-all', 'geosite-cn']);
});

test('buildRoute defines a local rule_set for each used geo category', () => {
  const route = buildRoute({
    ruleSetDir: '/geo',
    clashRules: ['GEOSITE,category-ads-all,REJECT', 'GEOSITE,cn,DIRECT'],
    geoAvailable: new Set(['geoip-cn', 'geosite-cn', 'geosite-category-ads-all']),
  });
  const tags = route.rule_set.map((rs) => rs.tag).sort();
  assert.deepStrictEqual(tags, ['geoip-cn', 'geosite-category-ads-all', 'geosite-cn']);
  assert.ok(route.rule_set.every((rs) => rs.type === 'local' && rs.path.endsWith(rs.tag + '.srs')));
});

console.log('\nRULE-SET providers:');

test('parseClashConfig extracts rule-providers (type/behavior/url/format)', () => {
  const yaml = [
    'proxies:',
    '  - {name: A, type: trojan, server: a.com, port: 443, password: p}',
    'rule-providers:',
    '  reject:',
    '    type: http',
    '    behavior: domain',
    '    url: https://example.com/reject.yaml',
    '    format: yaml',
    'rules:',
    '  - RULE-SET,reject,REJECT',
  ].join('\n');
  const r = clashParser.parseClashConfig(yaml);
  assert.ok(r.ruleProviders.reject, 'reject provider parsed');
  assert.strictEqual(r.ruleProviders.reject.behavior, 'domain');
  assert.strictEqual(r.ruleProviders.reject.url, 'https://example.com/reject.yaml');
});

test('Mihomo config drops unusable providers and dangling RULE-SET rules', () => {
  const config = buildMihomoConfig(
    [{ name: 'node', type: 'trojan', server: 'example.com', port: 443, password: 'p' }],
    {
      clashRules: [
        'RULE-SET,remote,DIRECT',
        'RULE-SET,local,DIRECT',
        'RULE-SET,missing,DIRECT',
        'RULE-SET,bad-mrs,DIRECT',
        'RULE-SET,constructor,DIRECT',
      ],
      ruleProviders: {
        remote: { type: 'http', behavior: 'domain', format: 'text', url: 'https://example.com/rules.txt' },
        local: { type: 'file', behavior: 'classical', format: 'yaml', url: '' },
        missing: { type: 'http', behavior: 'domain', format: 'yaml', url: '' },
        'bad-mrs': { type: 'http', behavior: 'classical', format: 'mrs', url: 'https://example.com/rules.mrs' },
        constructor: { type: 'http', behavior: 'domain', format: 'yaml', url: 'https://example.com/constructor.yaml' },
      },
    }
  );
  assert.deepStrictEqual(Object.keys(config['rule-providers']), ['remote']);
  assert.deepStrictEqual(config['rule-providers'].remote, {
    type: 'http', behavior: 'domain', url: 'https://example.com/rules.txt', format: 'text',
  });
  assert.ok(config.rules.includes('RULE-SET,remote,DIRECT'));
  assert.ok(!config.rules.some((rule) => /RULE-SET,(local|missing|bad-mrs|constructor),/.test(rule)));
});

test('rule-provider names cannot mutate the normalized object prototype', () => {
  const parsed = clashParser.parseClashConfig([
    'proxies: []',
    'rule-providers:',
    '  __proto__: {type: http, url: https://example.com/proto.yaml}',
    '  constructor: {type: http, url: https://example.com/ctor.yaml}',
    '  safe: {type: http, url: https://example.com/safe.yaml}',
  ].join('\n'));
  assert.deepStrictEqual(Object.keys(parsed.ruleProviders), ['safe']);
  assert.strictEqual(Object.getPrototypeOf(parsed.ruleProviders), Object.prototype);
});

test('subscription user-info accepts only standard finite counters', () => {
  const info = parseUserInfo({
    'subscription-userinfo': 'upload=1; download=2; total=3; expire=4; constructor=9; extra=10; bad=Infinity',
  });
  assert.deepStrictEqual(info, { upload: 1, download: 2, total: 3, expire: 4 });
});

test('clashRulesToSingbox emits RULE-SET as one rule per matcher field (OR), honoring target', () => {
  const ruleSetData = {
    direct: { domain_suffix: ['cn', 'qq.com'], ip_cidr: ['1.1.1.0/24'], domain: [], domain_keyword: [], process_name: [] },
  };
  const { rules } = clashRulesToSingbox(['RULE-SET,direct,DIRECT'], true, null, null, ruleSetData);
  // Separate rules for domain_suffix and ip_cidr (single field each) → OR.
  assert.deepStrictEqual(rules, [
    { domain_suffix: ['cn', 'qq.com'], outbound: 'direct' },
    { ip_cidr: ['1.1.1.0/24'], outbound: 'direct' },
  ]);
});

test('clashRulesToSingbox drops RULE-SET whose provider is not yet cached', () => {
  const { rules } = clashRulesToSingbox(['RULE-SET,missing,DIRECT'], true, null, null, {});
  assert.deepStrictEqual(rules, []);
});

console.log('\nsing-box subscription parsing:');

const singboxParser = require('../src/main/parsers/singbox');

test('parseSingboxConfig converts outbounds to nodes, skipping non-proxies', () => {
  const cfg = JSON.stringify({
    outbounds: [
      { type: 'selector', tag: 'select', outbounds: ['a'] },
      { type: 'vless', tag: 'VL', server: '1.2.3.4', server_port: 443, uuid: 'u', flow: 'xtls-rprx-vision',
        tls: { enabled: true, server_name: 'e.com', reality: { enabled: true, public_key: 'PK', short_id: 'ab' } } },
      { type: 'shadowsocks', tag: 'SS', server: '5.6.7.8', server_port: 8388, method: 'aes-128-gcm', password: 'pw' },
      { type: 'direct', tag: 'direct' },
    ],
  });
  const { nodes, isSingbox } = singboxParser.parseSingboxConfig(cfg);
  assert.strictEqual(isSingbox, true);
  assert.strictEqual(nodes.length, 2); // selector + direct dropped
  const vl = nodes.find((n) => n.type === 'vless');
  assert.strictEqual(vl.uuid, 'u');
  assert.strictEqual(vl.flow, 'xtls-rprx-vision');
  assert.strictEqual(vl.reality.publicKey, 'PK');
});

test('sing-box parser rejects malformed endpoints and out-of-range ports', () => {
  const { nodes } = singboxParser.parseSingboxConfig(JSON.stringify({
    outbounds: [
      { type: 'trojan', tag: 'good', server: 'example.com', server_port: '443', password: 'p' },
      { type: 'trojan', tag: 'zero', server: 'example.com', server_port: 0, password: 'p' },
      { type: 'trojan', tag: 'overflow', server: 'example.com', server_port: 65536, password: 'p' },
      { type: 'trojan', tag: 'suffix', server: 'example.com', server_port: '443x', password: 'p' },
      { type: 'trojan', tag: 'object', server: { host: 'example.com' }, server_port: 443, password: 'p' },
    ],
  }));
  assert.deepStrictEqual(nodes.map((node) => node.name), ['good']);
});

test('a sing-box node round-trips back to the same outbound type', () => {
  const { nodes } = singboxParser.parseSingboxConfig(JSON.stringify([
    { type: 'vmess', tag: 'VM', server: 'v.com', server_port: 443, uuid: 'x', security: 'auto', alter_id: 0,
      transport: { type: 'ws', path: '/ws', headers: { Host: 'v.com' } } },
  ]));
  const ob = nodeToOutbound(nodes[0]);
  assert.strictEqual(ob.type, 'vmess');
  assert.strictEqual(ob.transport.type, 'ws');
  assert.strictEqual(ob.transport.path, '/ws');
});

test('parseSubscriptionContent detects sing-box JSON (raw and base64)', () => {
  const json = JSON.stringify({
    outbounds: [{ type: 'trojan', tag: 'T', server: 't.com', server_port: 443, password: 'p', tls: { enabled: true } }],
    route: {
      rules: [
        { domain_suffix: 'example.com', outbound: 'direct' },
        { ip_is_private: true, outbound: 'direct' },
        { rule_set: 'geoip-cn', outbound: 'direct' },
        { action: 'hijack-dns', protocol: 'dns' },
      ],
    },
  });
  const parsed = parseSubscriptionContent(json);
  assert.strictEqual(parsed.format, 'singbox');
  assert.ok(parsed.rules.includes('DOMAIN-SUFFIX,example.com,DIRECT'));
  assert.ok(parsed.rules.includes('IP-CIDR,10.0.0.0/8,DIRECT'));
  assert.ok(!parsed.rules.some((rule) => rule.startsWith('RULE-SET,')));
  assert.ok(!parsed.rules.some((rule) => rule.includes('hijack-dns')));
  const b64 = Buffer.from(json).toString('base64');
  assert.strictEqual(parseSubscriptionContent(b64).format, 'singbox');
  const wrapped = b64.match(/.{1,76}/g).join('\n');
  assert.strictEqual(parseSubscriptionContent(wrapped).format, 'singbox');
});

console.log('\nGeoData mirrors:');

test('geoDataUrls offers raw + jsDelivr fallbacks for a rule-set', () => {
  const urls = geoDataUrls('sing-geoip', 'geoip-cn.srs');
  assert.ok(urls.length >= 2, 'has fallback sources, not just raw');
  assert.strictEqual(urls[0], 'https://raw.githubusercontent.com/SagerNet/sing-geoip/rule-set/geoip-cn.srs');
  // Every URL targets the same repo@branch/file, just via a different host.
  assert.ok(urls.every((u) => u.endsWith('geoip-cn.srs')));
  assert.ok(urls.some((u) => u.includes('jsdelivr.net/gh/SagerNet/sing-geoip@rule-set/geoip-cn.srs')));
});

console.log('\nLarge input regressions:');

test('node-name normalization drops corrupt non-object entries', () => {
  assert.deepStrictEqual(
    uniqueNodeNames([null, [], { name: 'valid', type: 'trojan' }]).map((node) => node.name),
    ['valid']
  );
});

test('duplicate node names are normalized without quadratic suffix scans', () => {
  const nodes = Array.from({ length: 20000 }, () => ({ name: 'same', type: 'trojan' }));
  const started = Date.now();
  const normalized = uniqueNodeNames(nodes);
  assert.strictEqual(normalized[19999].name, 'same 20000');
  assert.ok(Date.now() - started < 1500, 'duplicate-name normalization regressed to quadratic time');
});

test('large Mihomo proxy groups are deduplicated in linear time', () => {
  const nodes = Array.from({ length: 20000 }, (_, index) => ({
    name: `node-${index}`, type: 'trojan', server: 'example.com', port: 443, password: 'p',
  }));
  const started = Date.now();
  const config = buildMihomoConfig(nodes, { hasGeoData: false });
  assert.strictEqual(config['proxy-groups'][0].proxies.length, nodes.length + 3);
  assert.ok(Date.now() - started < 1500, 'Mihomo proxy-group construction regressed to quadratic time');
});

test('config fingerprints are stable across object key order without building one giant JSON string', () => {
  const a = { nodes: [{ name: 'n', server: 'x', port: 443 }], rules: ['MATCH,PROXY'] };
  const b = { nodes: [{ port: 443, server: 'x', name: 'n' }], rules: ['MATCH,PROXY'] };
  assert.strictEqual(configFingerprint(a), configFingerprint(b));
});

test('Mihomo conversion accepts very large inline remote rule lists', () => {
  const domains = Array.from({ length: 150000 }, (_, index) => `d${index}.example`);
  const config = buildMihomoConfig(
    [{ name: 'node', type: 'trojan', server: 'example.com', port: 443, password: 'p' }],
    { extraRules: [{ domain_suffix: domains, outbound: '🚀 Proxy' }] }
  );
  assert.strictEqual(config.rules.length, domains.length + 1);
});

console.log(`\nDone, ${passed} tests passed.`);
