'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');

const fetch = require('../src/main/fetch');

async function main() {
  const payload = Buffer.from('redirected download completed');
  const server = http.createServer((req, res) => {
    if (req.url === '/redirect') {
      res.writeHead(302, { Location: '/file' });
      res.end();
      return;
    }
    if (req.url === '/bad-redirect') {
      res.writeHead(302, { Location: 'http://[' });
      res.end();
      return;
    }
    if (req.url === '/unsupported-redirect') {
      res.writeHead(302, { Location: 'ftp://example.com/file' });
      res.end();
      return;
    }
    if (req.url === '/file') {
      res.writeHead(200, { 'Content-Length': payload.length });
      res.end(payload);
      return;
    }
    if (req.url === '/large') {
      res.writeHead(200, { 'Content-Length': 16 });
      res.end('0123456789abcdef');
      return;
    }
    if (req.url === '/chunked') {
      res.writeHead(200);
      res.write('01234567');
      res.end('89abcdef');
      return;
    }
    if (req.url === '/abort') {
      res.writeHead(200, { 'Content-Length': 64 });
      res.write('partial');
      setImmediate(() => res.destroy());
      return;
    }
    if (req.url === '/hang') {
      res.writeHead(200);
      res.write('partial');
      return;
    }
    res.writeHead(404);
    res.end();
  });
  const proxyServer = http.createServer();
  let proxyConnects = 0;
  proxyServer.on('connect', (req, clientSocket, head) => {
    proxyConnects += 1;
    const separator = req.url.lastIndexOf(':');
    const host = req.url.slice(0, separator);
    const port = Number(req.url.slice(separator + 1));
    const upstream = net.connect(port, host, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on('error', () => clientSocket.destroy());
  });
  let tunneledTlsBytes = 0;
  const tunnelInspectionProxy = http.createServer();
  tunnelInspectionProxy.on('connect', (_req, clientSocket) => {
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    clientSocket.once('data', (chunk) => {
      tunneledTlsBytes += chunk.length;
      clientSocket.destroy();
    });
    setTimeout(() => clientSocket.destroy(), 1000).unref();
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  await new Promise((resolve) => proxyServer.listen(0, '127.0.0.1', resolve));
  await new Promise((resolve) => tunnelInspectionProxy.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dart-fetch-'));
  const dest = path.join(dir, 'download.bin');

  try {
    fs.writeFileSync(dest, 'old');
    const redirects = [];
    await fetch.download(`${base}/redirect`, dest, { onRedirect: (next) => redirects.push(next) });
    assert.deepStrictEqual(fs.readFileSync(dest), payload);
    assert.deepStrictEqual(redirects, [`${base}/file`]);
    console.log('✓ redirected downloads replace the destination without a deletion race');

    await assert.rejects(fetch.getBuffer(`${base}/bad-redirect`), /invalid redirect location/);
    await assert.rejects(fetch.getBuffer(`${base}/unsupported-redirect`), /unsupported URL protocol/);
    await assert.rejects(fetch.getBuffer('file:///etc/hosts'), /unsupported URL protocol/);
    console.log('✓ malformed and non-HTTP redirects fail as normal request errors');

    await fetch.download(`${base}/file`, dest, { onProgress: () => { throw new Error('renderer gone'); } });
    assert.deepStrictEqual(fs.readFileSync(dest), payload);
    console.log('✓ observer callback failures cannot strand a completed download');

    await assert.rejects(
      fetch.getBufferWithFallback(`${base}/large`, { maxBytes: 8 }),
      /response exceeds 8 bytes/
    );
    await assert.rejects(
      fetch.getBufferWithFallback(`${base}/chunked`, { maxBytes: 8 }),
      /response exceeds 8 bytes/
    );
    console.log('✓ buffered responses enforce their size limit');

    fs.writeFileSync(dest, 'known-good');
    await assert.rejects(fetch.download(`${base}/large`, dest, { maxBytes: 8 }), /download exceeds 8 bytes/);
    assert.strictEqual(fs.readFileSync(dest, 'utf-8'), 'known-good');
    console.log('✓ streamed downloads enforce their size limit without replacing the destination');

    await assert.rejects(fetch.download(`${base}/missing`, dest), /HTTP 404/);
    assert.strictEqual(fs.readFileSync(dest, 'utf-8'), 'known-good');
    console.log('✓ failed downloads preserve an existing destination');

    const blockedParent = path.join(dir, 'not-a-directory');
    fs.writeFileSync(blockedParent, 'blocker');
    await assert.rejects(fetch.download(`${base}/file`, path.join(blockedParent, 'child.bin')));
    assert.strictEqual(fs.readFileSync(blockedParent, 'utf-8'), 'blocker');
    console.log('✓ destination setup errors reject the download instead of escaping the promise');

    await assert.rejects(fetch.download(`${base}/abort`, dest));
    assert.strictEqual(fs.readFileSync(dest, 'utf-8'), 'known-good');
    assert.deepStrictEqual(fs.readdirSync(dir).filter((name) => name.includes('.part-')), []);
    console.log('✓ interrupted downloads preserve the destination and clean staging files');

    const controller = new AbortController();
    const cancelled = fetch.downloadWithFallback(`${base}/hang`, dest, { signal: controller.signal });
    setTimeout(() => controller.abort(), 20);
    await assert.rejects(cancelled, /aborted/);
    assert.strictEqual(fs.readFileSync(dest, 'utf-8'), 'known-good');
    assert.deepStrictEqual(fs.readdirSync(dir).filter((name) => name.includes('.part-')), []);
    console.log('✓ cancelled downloads stop immediately without a direct retry or staging leak');

    const connectsBeforeHttp = proxyConnects;
    const proxiedHttp = await fetch.getBuffer(`${base}/file`, { proxyPort: proxyServer.address().port });
    assert.deepStrictEqual(proxiedHttp.body, payload);
    assert.strictEqual(proxyConnects, connectsBeforeHttp + 1);
    console.log('✓ HTTP requests honor updateViaProxy through a CONNECT tunnel');

    const tunnel = await fetch.connectTunnel('127.0.0.1', server.address().port, proxyServer.address().port, 2000);
    const tunneledResponse = new Promise((resolve, reject) => {
      const chunks = [];
      tunnel.on('data', (chunk) => chunks.push(chunk));
      tunnel.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
      tunnel.on('error', reject);
    });
    tunnel.write('GET /file HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n');
    assert.ok((await tunneledResponse).includes(payload.toString('utf-8')));
    console.log('✓ CONNECT tunnels carry diagnostic TCP traffic through the proxy');

    await assert.rejects(
      fetch.getBuffer(`https://127.0.0.1:${server.address().port}/file`, {
        proxyPort: tunnelInspectionProxy.address().port,
        timeout: 2000,
      })
    );
    assert.ok(tunneledTlsBytes > 0, 'HTTPS opened a direct socket instead of writing TLS into the CONNECT tunnel');
    console.log('✓ HTTPS requests keep TLS inside the CONNECT tunnel');

    const subscription = require('../src/main/subscription');
    const originalGetBufferWithFallback = fetch.getBufferWithFallback;
    let attempts = 0;
    fetch.getBufferWithFallback = async () => {
      attempts += 1;
      throw new Error('network unreachable');
    };
    try {
      await assert.rejects(subscription.fetchSubscription('https://example.invalid/sub'), /network unreachable/);
      assert.strictEqual(attempts, 1, 'network errors were repeated for every User-Agent');
    } finally {
      fetch.getBufferWithFallback = originalGetBufferWithFallback;
    }
    console.log('✓ subscription network failures stop before User-Agent retries');

    const nativeConfig = JSON.stringify({
      outbounds: [{
        type: 'trojan', tag: 'native-node', server: 'native.example.com',
        server_port: 443, password: 'secret',
      }],
    });
    const clashConfig = [
      'proxies:',
      '  - name: clash-node',
      '    type: trojan',
      '    server: clash.example.com',
      '    port: 443',
      '    password: secret',
    ].join('\n');
    const requestedAgents = [];
    try {
      fetch.getBufferWithFallback = async (_url, options) => {
        requestedAgents.push(options.headers['User-Agent']);
        return { body: Buffer.from(nativeConfig), headers: {} };
      };
      const native = await subscription.fetchSubscription(
        'https://example.invalid/sub',
        () => {},
        { coreType: 'sing-box' }
      );
      assert.strictEqual(native.format, 'singbox');
      assert.deepStrictEqual(requestedAgents, ['sing-box/1.13.0']);

      requestedAgents.length = 0;
      fetch.getBufferWithFallback = async (_url, options) => {
        const ua = options.headers['User-Agent'];
        requestedAgents.push(ua);
        return {
          body: Buffer.from(ua.startsWith('sing-box/') ? 'format unavailable' : clashConfig),
          headers: {},
        };
      };
      const fallback = await subscription.fetchSubscription(
        'https://example.invalid/sub',
        () => {},
        { coreType: 'sing-box' }
      );
      assert.strictEqual(fallback.format, 'clash');
      assert.deepStrictEqual(requestedAgents.slice(0, 2), ['sing-box/1.13.0', 'mihomo/1.18.10']);

      requestedAgents.length = 0;
      fetch.getBufferWithFallback = async (_url, options) => {
        requestedAgents.push(options.headers['User-Agent']);
        return { body: Buffer.from(clashConfig), headers: {} };
      };
      const mihomo = await subscription.fetchSubscription(
        'https://example.invalid/sub',
        () => {},
        { coreType: 'mihomo' }
      );
      assert.strictEqual(mihomo.format, 'clash');
      assert.deepStrictEqual(requestedAgents, ['mihomo/1.18.10']);
    } finally {
      fetch.getBufferWithFallback = originalGetBufferWithFallback;
    }
    console.log('✓ subscription requests prefer the active core format and fall back across ecosystems');
  } finally {
    await new Promise((resolve) => tunnelInspectionProxy.close(resolve));
    await new Promise((resolve) => proxyServer.close(resolve));
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((e) => {
  console.error('✗ fetch test failed:', e.message);
  process.exitCode = 1;
});
