'use strict';

/**
 * Minimal HTTP client for `GM_xmlhttpRequest`.
 *
 * The userscript asks the *main process* to make these requests, so they are not
 * subject to the page's CORS rules - which is the whole point of the GM_* API.
 * Only http/https are accepted; anything else is refused before a socket is opened.
 *
 * Three things a GM_xmlhttpRequest caller is entitled to expect, and which this used
 * to get wrong:
 *
 *  - **Redirects are followed.** `onload` used to receive the 302 itself, with an
 *    empty body, whenever an endpoint redirected - so a caller got nothing at all.
 *  - **The body is bounded.** The whole response was concatenated into memory with no
 *    limit; the import path has an 8 MB cap, this had none.
 *  - **The request can be cancelled.** `abort()` was a no-op on the renderer side
 *    because the request lives here. It now takes an `AbortSignal`.
 */

const https = require('node:https');
const http = require('node:http');

const TIMEOUT_MS = 30000;

/** Redirect hops to follow before giving up, so a redirect loop cannot spin forever. */
const MAX_REDIRECTS = 5;

/**
 * Hard cap on the response body.
 *
 * Generous - a video-parse endpoint can return a sizeable JSON document - but finite,
 * so a runaway or hostile endpoint cannot exhaust the main process's memory.
 */
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;

/** Statuses that carry a Location worth following. 304 is deliberately not one. */
function isRedirect(status) {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

/**
 * @param {string} url
 * @param {{ method?: string, headers?: object, body?: string|Buffer, signal?: AbortSignal }} [options]
 * @param {number} [redirectsLeft]
 * @returns {Promise<{ status: number, statusText: string, headers: object, body: Buffer, finalUrl: string }>}
 */
function requestUrl(url, options = {}, redirectsLeft = MAX_REDIRECTS) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch (error) {
      reject(error);
      return;
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      reject(new Error(`不支持的请求协议：${parsed.protocol}`));
      return;
    }
    if (options.signal?.aborted) {
      reject(new Error('请求已取消'));
      return;
    }

    const client = parsed.protocol === 'https:' ? https : http;
    const request = client.request(parsed, {
      method: options.method || 'GET',
      headers: options.headers || {},
      timeout: TIMEOUT_MS,
    }, (response) => {
      const status = response.statusCode || 0;
      const location = response.headers.location;

      if (location && isRedirect(status) && redirectsLeft > 0) {
        // Drain the redirect body before reusing the socket.
        response.resume();
        let next;
        try {
          next = new URL(location, parsed).href;
        } catch (error) {
          reject(error);
          return;
        }
        // 303 (and in practice 301/302) turn a POST into a GET, as browsers do.
        const nextOptions = status === 303
          ? { ...options, method: 'GET', body: undefined }
          : options;
        resolve(requestUrl(next, nextOptions, redirectsLeft - 1));
        return;
      }

      const chunks = [];
      let received = 0;
      response.on('data', (chunk) => {
        received += chunk.length;
        if (received > MAX_RESPONSE_BYTES) {
          request.destroy(new Error(`响应体超过 ${Math.round(MAX_RESPONSE_BYTES / 1024 / 1024)} MB 上限`));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => resolve({
        status,
        statusText: response.statusMessage || '',
        headers: response.headers,
        body: Buffer.concat(chunks),
        finalUrl: parsed.href,
      }));
    });

    const onAbort = () => request.destroy(new Error('请求已取消'));
    if (options.signal) options.signal.addEventListener('abort', onAbort, { once: true });

    const cleanup = () => options.signal?.removeEventListener('abort', onAbort);

    request.on('timeout', () => request.destroy(new Error('请求超时')));
    request.on('error', (error) => {
      cleanup();
      reject(error);
    });
    request.on('close', cleanup);
    if (options.body) request.write(options.body);
    request.end();
  });
}

module.exports = { MAX_REDIRECTS, MAX_RESPONSE_BYTES, TIMEOUT_MS, isRedirect, requestUrl };
