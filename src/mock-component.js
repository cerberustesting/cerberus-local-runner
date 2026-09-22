// Stands in for a real bundled binary (Selenium, the Cerberus extension, cloudflared) so
// mock.mode can validate process spawning/signaling without downloading real dependencies.
'use strict';
const http = require('http');

const [, , kind, portArg] = process.argv;

if (kind === 'cloudflared') {
  const suffix = portArg ? '-' + portArg : '';
  console.log(`INF Your quick Tunnel has been created! Visit it at https://mock-runner${suffix}.trycloudflare.com`);
  setInterval(() => {}, 1 << 30); // stay alive until killed, like the real cloudflared process
} else {
  const port = Number(portArg);
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ value: { ready: true } }));
  });
  server.listen(port, '127.0.0.1', () => {
    console.log(`Mock ${kind} ready on ${port}`);
  });
}

process.on('SIGTERM', () => process.exit(0));