import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { createServer } from 'node:https';
import { connect } from 'node:net';
import { join } from 'node:path';

export async function startPilotTestProxy(scratch) {
  const key = join(scratch, 'loopback.key');
  const cert = join(scratch, 'loopback.pem');
  const tls = spawnSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert,
    '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
  ], { encoding: 'utf8', timeout: 15_000 });
  if (tls.error) throw tls.error;
  assert.equal(tls.status, 0, 'OpenSSL could not create the temporary loopback certificate.');

  const certificate = readFileSync(cert);
  const sockets = new Set();
  let backendPort = null;
  let closing;

  function track(socket) {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  }

  function closeSockets() {
    for (const socket of sockets) socket.destroy();
  }

  const proxy = createServer({ key: readFileSync(key), cert: certificate }, (incoming, outgoing) => {
    const port = backendPort;
    if (port === null) {
      incoming.resume();
      outgoing.writeHead(502, { Connection: 'close' }).end();
      return;
    }
    const upstream = httpRequest({
      hostname: '127.0.0.1', port, agent: false,
      method: incoming.method, path: incoming.url, headers: incoming.rawHeaders,
    }, response => {
      outgoing.writeHead(response.statusCode, response.rawHeaders);
      response.once('error', () => outgoing.destroy());
      response.pipe(outgoing);
    });
    upstream.on('error', () => {
      if (outgoing.headersSent) outgoing.destroy();
      else outgoing.writeHead(502).end();
    });
    incoming.once('error', () => upstream.destroy());
    outgoing.once('close', () => upstream.destroy());
    incoming.pipe(upstream);
  });
  proxy.on('connection', track);
  proxy.on('upgrade', (incoming, client, head) => {
    const port = backendPort;
    if (port === null) {
      client.once('error', () => client.destroy());
      client.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    const upstream = connect({ host: '127.0.0.1', port });
    track(upstream);
    client.on('error', () => upstream.destroy());
    upstream.on('error', () => client.destroy());
    client.once('close', () => upstream.destroy());
    upstream.once('close', () => client.destroy());
    upstream.once('connect', () => {
      const headers = [];
      for (let index = 0; index < incoming.rawHeaders.length; index += 2) {
        headers.push(`${incoming.rawHeaders[index]}: ${incoming.rawHeaders[index + 1]}`);
      }
      upstream.write(`${incoming.method} ${incoming.url} HTTP/1.1\r\n${headers.join('\r\n')}\r\n\r\n`);
      if (head.length) upstream.write(head);
      client.pipe(upstream).pipe(client);
    });
  });
  proxy.listen(0, '127.0.0.1');
  await once(proxy, 'listening');

  return {
    origin: `https://127.0.0.1:${proxy.address().port}`,
    certificate,
    setBackendPort(port) {
      assert.ok(port === null || !closing && Number.isSafeInteger(port) && port >= 1 && port <= 65535,
        'The test backend must use a loopback TCP port while the proxy is open.');
      if (backendPort === port) return;
      // An existing connection must not follow a restarted or restored backend.
      if (backendPort !== null) closeSockets();
      backendPort = port;
    },
    close() {
      if (!closing) {
        backendPort = null;
        closeSockets();
        closing = new Promise((resolve, reject) => proxy.close(error => error ? reject(error) : resolve()));
      }
      return closing;
    },
  };
}
