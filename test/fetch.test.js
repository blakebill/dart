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
    res.writeHead(404);
    res.end();
  });
  const proxyServer = http.createServer();
  proxyServer.on('connect', (req, clientSocket, head) => {
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
    await assert.rejects(fetch.download(`${base}/missing`, dest), /HTTP 404/);
    assert.strictEqual(fs.readFileSync(dest, 'utf-8'), 'known-good');
    console.log('✓ failed downloads preserve an existing destination');

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
