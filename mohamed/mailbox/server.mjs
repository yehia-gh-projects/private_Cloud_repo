// A local inbox for the demo. floci keeps every mail the service sends instead of
// relaying it, and it sends no CORS headers, so a plain HTML file cannot read the
// store. This serves one page and forwards its fetch to the emulator.
//
//   node mailbox/server.mjs      -> http://127.0.0.1:4545
//
// Nothing is stored here and nothing is written back: it is a reader.

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.PORT ?? 4545);
const FLOCI = process.env.FLOCI_URL ?? 'http://127.0.0.1:4566';
const PAGE = fileURLToPath(new URL('./index.html', import.meta.url));

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === '/' || url.pathname === '/index.html') {
    const html = await readFile(PAGE);
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }

  if (url.pathname === '/messages') {
    try {
      const upstream = await fetch(`${FLOCI}/_aws/ses`);
      const body = await upstream.text();
      res.writeHead(upstream.status, { 'content-type': 'application/json; charset=utf-8' });
      res.end(body);
    } catch (error) {
      res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: `floci is not answering: ${error.message}` }));
    }
    return;
  }

  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('not found');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`inbox on http://127.0.0.1:${PORT}  reading ${FLOCI}/_aws/ses`);
});
