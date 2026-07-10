'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
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

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dart-fetch-'));
  const dest = path.join(dir, 'download.bin');

  try {
    fs.writeFileSync(dest, 'old');
    await fetch.download(`${base}/redirect`, dest);
    assert.deepStrictEqual(fs.readFileSync(dest), payload);
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
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((e) => {
  console.error('✗ fetch test failed:', e.message);
  process.exitCode = 1;
});
