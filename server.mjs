// Runs Next.js behind a tiny HTTP server that records the real peer address.
// Route handlers can't see the socket, and clients can set X-Forwarded-For themselves,
// so the address that actually connected goes in x-guardrail-peer (any client value is replaced).
// Usage: node server.mjs [--dev] [-p 3000]
import { createServer } from 'node:http';
import next from 'next';

const args = process.argv.slice(2);
const dev = args.includes('--dev');
const pi = args.indexOf('-p');
const port = Number(pi >= 0 ? args[pi + 1] : process.env.PORT || 3000);
const hostname = process.env.HOSTNAME || '0.0.0.0';

const app = next({ dev, port, hostname: 'localhost' });
const handle = app.getRequestHandler();
await app.prepare();
const upgrade = app.getUpgradeHandler?.();

// OPSARA_HTTP_LOG=1 writes one line per /v1 request (method, path, status, time, body size, peer) and logs
// connections that Node itself refuses (bad requests never reach the app, so the Activity page cannot show them).
const httpLog = process.env.OPSARA_HTTP_LOG === '1';
const server = createServer((req, res) => {
  const peer = req.socket.remoteAddress ?? '';
  req.headers['x-guardrail-peer'] = peer;
  if (httpLog && req.url?.startsWith('/v1/')) {
    const t = Date.now();
    const line = (what) => console.log(`[http] ${req.method} ${req.url.split('?')[0]} ${what} after ${Date.now() - t} ms, body ${req.headers['content-length'] ?? 'chunked'} bytes, from ${peer}`);
    res.on('finish', () => line(`-> ${res.statusCode}`));
    res.on('close', () => !res.writableFinished && line('client closed the connection early'));
  }
  handle(req, res);
});
if (httpLog) {
  server.on('clientError', (err, socket) => {
    console.log(`[http] clientError ${err.code ?? ''} ${err.message} from ${socket.remoteAddress ?? ''}`);
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    else socket.destroy();
  });
}
if (upgrade) server.on('upgrade', (req, socket, head) => upgrade(req, socket, head));
server.listen(port, hostname, () => {
  console.log(`  ▲ Opsara ${dev ? 'dev' : 'production'} server on http://localhost:${port} (listening on ${hostname})`);
});
