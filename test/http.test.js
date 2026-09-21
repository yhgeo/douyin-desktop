'use strict';

// Coverage for the HTTP client behind GM_xmlhttpRequest.
//
// The userscript asks the main process to make these requests, so they bypass the page's
// CORS rules - that is the point of the GM_* API. Three things a caller is entitled to
// expect, and which this used to get wrong:
//
//   * redirects are followed. `onload` used to receive the 302 itself, with an empty
//     body, whenever an endpoint redirected - so the caller got nothing at all.
//   * the body is bounded. The whole response was concatenated into memory with no limit.
//   * the request can be cancelled. `abort()` on the renderer side was a no-op, because
//     the request lives here.
//
// Everything is served from a loopback server, so this needs no network.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const {
  MAX_REDIRECTS,
  MAX_RESPONSE_BYTES,
  TIMEOUT_MS,
  isRedirect,
  requestUrl,
} = require('../app/platform/http');

const BIG_BYTES = MAX_RESPONSE_BYTES + 65536;

let origin;

/** One server for the whole file; each case is a route. */
const server = http.createServer((request, response) => {
  // A client that walks away mid-response (the body-cap case) must not crash the test
  // process with an unhandled 'error'.
  request.on('error', () => {});
  response.on('error', () => {});

  const url = new URL(request.url, 'http://127.0.0.1');

  switch (url.pathname) {
    case '/a':
      response.writeHead(302, { location: '/b' });
      response.end('redirecting');
      return;
    case '/b':
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end('ok');
      return;
    case '/rel':
      response.writeHead(302, { location: './target' });
      response.end('');
      return;
    case '/target':
      response.end('target-body');
      return;
    case '/loop':
      response.writeHead(302, { location: '/loop' });
      response.end('');
      return;
    case '/echo':
      response.end(`method=${request.method}`);
      return;
    case '/post-303':
      response.writeHead(303, { location: '/echo' });
      response.end('');
      return;
    case '/post-307':
      response.writeHead(307, { location: '/echo' });
      response.end('');
      return;
    case '/big': {
      response.writeHead(200, { 'content-type': 'application/octet-stream' });
      const chunk = Buffer.alloc(65536, 0x61);
      let written = 0;
      const pump = () => {
        while (written < BIG_BYTES) {
          written += chunk.length;
          if (!response.write(chunk)) {
            response.once('drain', pump);
            return;
          }
        }
        response.end();
      };
      pump();
      return;
    }
    case '/slow':
      // Never answers: the point is to still be in flight when the caller cancels.
      return;
    default:
      response.writeHead(404);
      response.end('not found');
  }
});

test.before(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  // The global agent keeps sockets alive, so `close()` alone would wait for them.
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

// ---------------------------------------------------------------------------

test('isRedirect covers exactly the statuses that carry a Location', () => {
  for (const status of [301, 302, 303, 307, 308]) {
    assert.equal(isRedirect(status), true, String(status));
  }
  for (const status of [200, 204, 304, 400, 404, 500]) {
    assert.equal(isRedirect(status), false, String(status));
  }
});

test('a redirect is followed, and the caller sees the final response', async () => {
  const result = await requestUrl(`${origin}/a`);

  assert.equal(result.status, 200, 'not the 302 itself');
  assert.equal(result.body.toString('utf8'), 'ok', 'and not an empty body');
  assert.equal(result.finalUrl, `${origin}/b`, 'the caller can tell where it landed');
  assert.ok(result.headers['content-type'].includes('text/plain'));
});

test('a relative Location is resolved against the request URL', async () => {
  const result = await requestUrl(`${origin}/rel`);
  assert.equal(result.status, 200);
  assert.equal(result.body.toString('utf8'), 'target-body');
  assert.equal(result.finalUrl, `${origin}/target`);
});

test('a redirect loop stops instead of spinning forever', async () => {
  const result = await requestUrl(`${origin}/loop`);

  // The hops are exhausted, so the last 302 is handed back rather than followed again.
  assert.equal(result.status, 302);
  assert.equal(result.body.length, 0);
  assert.equal(result.finalUrl, `${origin}/loop`);
});

test('303 turns a POST into a GET, as a browser would', async () => {
  const result = await requestUrl(`${origin}/post-303`, { method: 'POST', body: 'payload' });
  assert.equal(result.status, 200);
  assert.equal(result.body.toString('utf8'), 'method=GET');
});

test('307 preserves the method', async () => {
  const result = await requestUrl(`${origin}/post-307`, { method: 'POST', body: 'payload' });
  assert.equal(result.status, 200);
  assert.equal(result.body.toString('utf8'), 'method=POST');
});

test('a request that is not http(s) is refused before a socket is opened', async () => {
  await assert.rejects(requestUrl('bytedance://webview?url=x'), /不支持的请求协议/);
  await assert.rejects(requestUrl('file:///C:/Windows/win.ini'), /不支持的请求协议/);
  await assert.rejects(requestUrl('not a url'), TypeError);
});

test('an already-aborted signal refuses the request', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(requestUrl(`${origin}/b`, { signal: controller.signal }), /请求已取消/);
});

test('an in-flight request can be cancelled', async () => {
  const controller = new AbortController();
  const started = Date.now();
  const pending = requestUrl(`${origin}/slow`, { signal: controller.signal });

  setTimeout(() => controller.abort(), 20);

  await assert.rejects(pending, /请求已取消/);
  assert.ok(Date.now() - started < 5000, 'cancellation must not wait for the request timeout');
});

test('the abort listener is removed once the request finishes', async () => {
  // Otherwise every completed GM_xmlhttpRequest would leave a listener on the signal, and
  // a long-lived controller would accumulate them until Node warned about it.
  // A stand-in signal, because an AbortSignal does not expose its listener list.
  const listeners = new Set();
  const signal = {
    aborted: false,
    addEventListener: (_type, listener) => listeners.add(listener),
    removeEventListener: (_type, listener) => listeners.delete(listener),
  };

  const result = await requestUrl(`${origin}/b`, { signal });
  assert.equal(result.status, 200);

  // 'close' arrives after 'end', so give it a moment to land.
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(listeners.size, 0, 'the listener must not outlive the request');
});

test('the response body is capped instead of being read into memory without limit', async () => {
  await assert.rejects(requestUrl(`${origin}/big`), /上限/);
});

test('the limits are finite and the timeout is set', () => {
  assert.ok(Number.isFinite(MAX_RESPONSE_BYTES) && MAX_RESPONSE_BYTES > 0);
  assert.ok(Number.isInteger(MAX_REDIRECTS) && MAX_REDIRECTS > 0);
  assert.ok(Number.isFinite(TIMEOUT_MS) && TIMEOUT_MS > 0);
  // A redirect loop costs at most MAX_REDIRECTS round trips, which is what bounds it.
  assert.ok(MAX_REDIRECTS <= 10);
});
