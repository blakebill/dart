'use strict';

/**
 * Lightweight self-test script (no test framework needed): node test/convert.test.js
 * Verifies share-link parsing, Clash parsing, and Mihomo conversion.
 */

const assert = require('assert');
const linkParser = require('../src/main/parsers/share-link');
const clashParser = require('../src/main/parsers/clash');
const {
  nodeToClashProxy,
  buildMihomoConfig,
  extractRuleGroups,
} = require('../src/main/converter');
const {
  parseSubscriptionContent,
  parseUserInfo,
  uniqueNodeNames,
  configFingerprint,
  formatSubscriptionForEditing,
} = require('../src/main/subscription');
const { normalizePolicyGroups } = require('../src/main/policy-groups');

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

test('parse hysteria2://', () => {
  const uri = 'hysteria2://pass@hy2.example.com:443?sni=hy2.example.com&insecure=1&obfs=salamander&obfs-password=xyz#HY2';
  const node = linkParser.parseSingleLink(uri);
  assert.strictEqual(node.type, 'hysteria2');
  assert.strictEqual(node.password, 'pass');
  assert.strictEqual(node.obfs, 'salamander');
  assert.strictEqual(node.obfsPassword, 'xyz');
  assert.strictEqual(node.skipCertVerify, true);
});

const clashYaml = `
port: 7890
proxies:
  - name: HK-vmess
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
  - name: US-ss
    type: ss
    server: us.example.com
    port: 8388
    cipher: aes-128-gcm
    password: pass
  - name: JP-trojan
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
  const normalized = parseSubscriptionContent(clashYaml);
  assert.deepStrictEqual(normalized.policyGroups[0], {
    name: 'PROXY',
    type: 'select',
    members: ['HK-vmess', 'US-ss', 'JP-trojan'],
  });
});

test('base64 Clash configs decode for parsing and editing', () => {
  const encoded = Buffer.from(clashYaml).toString('base64');
  const parsed = parseSubscriptionContent(encoded);
  assert.strictEqual(parsed.format, 'clash');
  assert.strictEqual(parsed.nodes.length, 3);
  assert.strictEqual(formatSubscriptionForEditing(encoded), clashYaml.trim());
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
  assert.deepStrictEqual(
    cfg['proxy-groups'][0].proxies.slice(0, 4),
    ['US-ss', '♻️ Auto', '🧠 Smart', '🛟 Fallback']
  );
  assert.ok(cfg['proxy-groups'].some((group) => group.name === '🧠 Smart' && group.type === 'select'));
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
  // Private LAN is still injected even without GeoData / with subscription rules.
  assert.ok(cfg.rules.some((rule) => /^IP-CIDR,10\.0\.0\.0\/8,DIRECT/i.test(rule)));
});

test('Mihomo injects private and CN direct even when the subscription has rules', () => {
  const cfg = buildMihomoConfig([{ type: 'trojan', name: 'n', server: 'a.com', port: 443, password: 'p' }], {
    clashRules: ['DOMAIN-SUFFIX,openai.com,PROXY', 'MATCH,PROXY'],
    hasGeoData: true,
  });
  assert.ok(cfg.rules.some((rule) => /^IP-CIDR,192\.168\.0\.0\/16,DIRECT/i.test(rule)));
  assert.ok(cfg.rules.includes('GEOIP,CN,DIRECT'));
  assert.ok(cfg.rules.includes('DOMAIN-SUFFIX,openai.com,🚀 Proxy'));
  assert.strictEqual(cfg.rules[cfg.rules.length - 1], 'MATCH,🚀 Proxy');
  const privateIdx = cfg.rules.findIndex((rule) => /^IP-CIDR,10\.0\.0\.0\/8,DIRECT/i.test(rule));
  const domainIdx = cfg.rules.indexOf('DOMAIN-SUFFIX,openai.com,🚀 Proxy');
  const cnIdx = cfg.rules.lastIndexOf('GEOIP,CN,DIRECT');
  assert.ok(privateIdx >= 0 && privateIdx < domainIdx);
  assert.ok(domainIdx < cnIdx);
  assert.ok(cnIdx < cfg.rules.length - 1);
});

test('Mihomo TUN mode emits tun configuration', () => {
  const cfg = buildMihomoConfig([{ type: 'trojan', name: 'n', server: 'a.com', port: 443, password: 'p' }], {
    enableTun: true,
    enableDnsOverride: true,
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

test('Mihomo races resolved IPs to avoid DIRECT address fallback stalls', () => {
  const cfg = buildMihomoConfig([
    { type: 'trojan', name: 'n', server: 'a.com', port: 443, password: 'p' },
  ], {
    enableTun: false,
  });
  assert.strictEqual(cfg['tcp-concurrent'], true);
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
    'trojan://p@d.com:443#%F0%9F%A7%A0%20Smart',
  ].join('\n'));
  assert.deepStrictEqual(res.nodes.map((node) => node.name), ['dup', 'dup 2', '♻️ Auto 2', '🧠 Smart 2']);
});

test('Mihomo DNS override also applies outside TUN mode', () => {
  const cfg = buildMihomoConfig([
    { type: 'trojan', name: 'N', server: 'a.com', port: 443, password: 'p' },
  ], {
    enableDnsOverride: true,
    enableTun: false,
    dnsRemote: 'tls://9.9.9.9',
    dnsLocal: '119.29.29.29',
  });
  assert.strictEqual(cfg.dns.enable, true);
  assert.strictEqual(cfg.dns['enhanced-mode'], 'redir-host');
  assert.deepStrictEqual(cfg.dns.nameserver, ['tls://9.9.9.9']);
  assert.ok(!cfg.tun);
});

test('parse anytls:// share link', () => {
  const node = linkParser.parseSingleLink('anytls://pw@a.com:8443?sni=a.com&insecure=1#AT');
  assert.strictEqual(node.type, 'anytls');
  assert.strictEqual(node.password, 'pw');
  assert.strictEqual(node.servername, 'a.com');
  assert.strictEqual(node.skipCertVerify, true);
});

console.log('\nSubscription rule policy-group overrides:');

test('extractRuleGroups includes final policy targets and excludes DIRECT/REJECT', () => {
  const rules = [
    'DOMAIN-SUFFIX,netflix.com,Streaming',
    'DOMAIN-SUFFIX,google.com,ProxyPick',
    'DOMAIN-SUFFIX,youtube.com,Streaming', // dup group
    'GEOIP,CN,DIRECT',
    'DOMAIN-KEYWORD,ad,REJECT',
    'MATCH,ProxyPick',
    'FINAL,FinalOnly',
  ];
  assert.deepStrictEqual(extractRuleGroups(rules), ['FinalOnly', 'ProxyPick', 'Streaming']);
});

test('policy-group normalization removes invalid and cyclic references', () => {
  const groups = normalizePolicyGroups([
    { name: 'A', type: 'select', members: ['B'] },
    { name: 'B', type: 'fallback', members: ['A', 'node'] },
    { name: 'Empty', type: 'select', members: ['missing'] },
    { name: '🚀 Proxy', type: 'select', members: ['node'] },
  ], ['node']);
  assert.deepStrictEqual(groups.map((group) => group.name), ['A', 'B']);
  assert.deepStrictEqual(groups[0].members, ['B']);
  assert.deepStrictEqual(groups[1].members, ['node']);
});

test('deep policy-group graphs are bounded and normalized without recursion', () => {
  const groups = Array.from({ length: 4096 }, (_, index) => ({
    name: `Group ${index}`,
    type: 'select',
    members: [index === 4095 ? 'node' : `Group ${index + 1}`],
  }));
  const normalized = normalizePolicyGroups(groups, ['node']);
  assert.strictEqual(normalized.length, groups.length);
  assert.deepStrictEqual(normalized.at(-1).members, ['node']);
});

console.log('\nGEOSITE / GEOIP categories:');

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

test('policy groups affect config fingerprints', () => {
  const base = { nodes: [{ name: 'A' }], rules: ['MATCH,Group'] };
  const first = configFingerprint({ ...base, policyGroups: [{ name: 'Group', type: 'select', members: ['A'] }] });
  const second = configFingerprint({ ...base, policyGroups: [{ name: 'Group', type: 'url-test', members: ['A'] }] });
  assert.notStrictEqual(first, second);
});

console.log('\nGeoData mirrors:');

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
  assert.strictEqual(config['proxy-groups'][0].proxies.length, nodes.length + 4);
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
  // private LAN directs + expanded domain rules + GEOIP CN fallback + MATCH
  assert.strictEqual(config.rules.length, domains.length + 10);
  assert.strictEqual(config.rules[config.rules.length - 1], 'MATCH,🚀 Proxy');
});

test('Mihomo conversion keeps preprocessed custom rule lines', () => {
  const config = buildMihomoConfig(
    [{ name: 'node', type: 'trojan', server: 'example.com', port: 443, password: 'p' }],
    { extraRules: ['DOMAIN-SUFFIX,custom.example,DIRECT'] }
  );
  assert.ok(config.rules.includes('DOMAIN-SUFFIX,custom.example,DIRECT'));
});

console.log(`\nDone, ${passed} tests passed.`);
