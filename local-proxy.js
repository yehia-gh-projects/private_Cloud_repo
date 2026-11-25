'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const PORT = Number(process.env.PROXY_PORT || 8080);

const TARGETS = {
  mohamed: { host: '127.0.0.1', port: 3000 },
  yehia: { host: '127.0.0.1', port: 3002 },
  mohab: { host: '127.0.0.1', port: 3003 },
};

const YEHIA_STATIC_DIR = path.join(__dirname, 'yehia', 'frontend');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
};

function serveStaticFile(res, rootDir, relPath) {
  const safePath = path.normalize(relPath).replace(/^(\.\.[/\\])+/, '');
  let filePath = path.join(rootDir, safePath);

  if (!filePath.startsWith(rootDir)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Forbidden');
    return;
  }

  fs.stat(filePath, (statErr, stats) => {
    if (statErr) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }

    if (stats.isDirectory()) {
      filePath = path.join(filePath, 'index.html');
    }

    fs.readFile(filePath, (readErr, data) => {
      if (readErr) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not found');
        return;
      }

      const ext = path.extname(filePath).toLowerCase();
      const contentType = MIME_TYPES[ext] || 'application/octet-stream';
      res.writeHead(200, {
        'Content-Type': contentType,
        'Cache-Control': 'no-store',
      });
      res.end(data);
    });
  });
}

function proxyRequest(req, res, target, targetPath) {
  const headers = {
    ...req.headers,
    host: `${target.host}:${target.port}`,
    'x-forwarded-host': req.headers.host || `localhost:${PORT}`,
    'x-forwarded-proto': 'http',
  };

  const proxyReq = http.request(
    {
      hostname: target.host,
      port: target.port,
      path: targetPath,
      method: req.method,
      headers,
    },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
      proxyRes.pipe(res);
    }
  );

  proxyReq.on('error', (err) => {
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
    }
    res.end(
      JSON.stringify({
        error: {
          code: 'BAD_GATEWAY',
          message: `Upstream ${target.host}:${target.port} unavailable: ${err.message}`,
        },
      })
    );
  });

  req.pipe(proxyReq);
}

function resolveRoute(urlStr) {
  const parsed = new URL(urlStr, `http://localhost:${PORT}`);
  const pathname = parsed.pathname;
  const search = parsed.search || '';

  // 1. Yehia's Timetable static frontend (/timetable/) and API (/api/timetables/*)
  if (pathname === '/timetable') {
    return { type: 'redirect', location: `/timetable/${search}` };
  }
  if (pathname.startsWith('/timetable/')) {
    const rel = pathname.slice('/timetable/'.length) || 'index.html';
    return { type: 'yehia-static', relPath: rel };
  }
  if (pathname === '/api/timetables' || pathname.startsWith('/api/timetables/') || pathname === '/api/health') {
    return { type: 'proxy', target: TARGETS.yehia, targetPath: `${pathname}${search}` };
  }

  // 2. Mohab's Compare & Share APIs
  if (
    pathname === '/api/compare' ||
    pathname.startsWith('/api/compare/') ||
    pathname === '/api/shares' ||
    pathname.startsWith('/api/shares/')
  ) {
    return { type: 'proxy', target: TARGETS.mohab, targetPath: `${pathname}${search}` };
  }

  // 3. Mohab's Compare & Share pages and CSS/JS assets
  if (pathname === '/compare' || pathname === '/compare/') {
    return { type: 'proxy', target: TARGETS.mohab, targetPath: `/index.html${search}` };
  }
  if (pathname.startsWith('/compare/')) {
    const stripped = pathname.slice('/compare'.length) || '/index.html';
    return { type: 'proxy', target: TARGETS.mohab, targetPath: `${stripped}${search}` };
  }
  if (pathname === '/share' || pathname === '/share/' || pathname === '/share.html') {
    return { type: 'proxy', target: TARGETS.mohab, targetPath: `/share.html${search}` };
  }
  if (pathname === '/shared' || pathname === '/shared/' || pathname === '/shared.html') {
    return { type: 'proxy', target: TARGETS.mohab, targetPath: `/shared.html${search}` };
  }
  if (pathname.startsWith('/share/')) {
    const stripped = pathname.slice('/share'.length) || '/share.html';
    return { type: 'proxy', target: TARGETS.mohab, targetPath: `${stripped}${search}` };
  }
  if (pathname.startsWith('/css/') || pathname.startsWith('/js/')) {
    return { type: 'proxy', target: TARGETS.mohab, targetPath: `${pathname}${search}` };
  }

  // 4. Mohamed's Catalogue & Accounts frontend and APIs (default)
  return { type: 'proxy', target: TARGETS.mohamed, targetPath: `${pathname}${search}` };
}

const server = http.createServer((req, res) => {
  const route = resolveRoute(req.url || '/');

  if (route.type === 'redirect') {
    res.writeHead(302, { Location: route.location });
    res.end();
    return;
  }

  if (route.type === 'yehia-static') {
    serveStaticFile(res, YEHIA_STATIC_DIR, route.relPath);
    return;
  }

  proxyRequest(req, res, route.target, route.targetPath);
});

server.listen(PORT, () => {
  console.log(`Local dev proxy listening on http://localhost:${PORT}`);
  console.log('  / , /api/auth/* , /api/courses/* , /api/sections/* -> http://127.0.0.1:3000 (mohamed)');
  console.log('  /timetable/ , /api/timetables/*                   -> yehia/frontend & http://127.0.0.1:3002 (yehia)');
  console.log('  /compare , /share* , /css/* , /js/* , /api/compare* , /api/shares* -> http://127.0.0.1:3003 (mohab)');
});
