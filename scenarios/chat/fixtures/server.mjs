/**
 * Minimal static file server for the CalicoDesk chat embed fixture.
 *
 * Serves `embed.html` (and any other fixture assets) from the fixtures
 * directory on 127.0.0.1 so Playwright can load the external-website embed
 * page in tests. Deterministic and safe:
 *
 *   - serves only files inside the fixtures directory (path traversal blocked)
 *   - no caching (Cache-Control: no-store) so test reruns see fresh content
 *   - single host/port, overridable via CALICODESK_FIXTURE_PORT
 *
 * Started automatically by Playwright's `webServer` config (see
 * playwright.config.ts). Run it manually with:
 *
 *   node scenarios/chat/fixtures/server.mjs
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const fixturesRoot = resolve(
  fileURLToPath(new URL('.', import.meta.url)),
);

const host = '127.0.0.1';
const port = Number(process.env.CALICODESK_FIXTURE_PORT ?? 4177);

const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

function isWithinFixtures(filePath) {
  if (filePath === fixturesRoot) {
    return true;
  }
  return filePath.startsWith(fixturesRoot + sep);
}

const server = createServer(async (request, response) => {
  try {
    const requestUrl = new URL(
      request.url ?? '/',
      `http://${request.headers.host ?? host}`,
    );

    let pathname = decodeURIComponent(requestUrl.pathname);

    if (pathname === '/' || pathname === '') {
      pathname = '/embed.html';
    }

    const filePath = normalize(join(fixturesRoot, pathname));

    if (!isWithinFixtures(filePath)) {
      response.writeHead(403, {
        'Content-Type': 'text/plain; charset=utf-8',
      });
      response.end('403 Forbidden');
      return;
    }

    const body = await readFile(filePath);

    response.writeHead(200, {
      'Content-Type': contentTypes[extname(filePath)] ?? 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    response.end(body);
  } catch {
    response.writeHead(404, {
      'Content-Type': 'text/plain; charset=utf-8',
    });
    response.end('404 Not Found');
  }
});

server.listen(port, host, () => {
  console.log(
    `CalicoDesk chat fixture server: http://${host}:${port}/embed.html`,
  );
});