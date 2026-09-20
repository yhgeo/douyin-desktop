'use strict';

/**
 * Minimal HTTP client for `GM_xmlhttpRequest`.
 *
 * The userscript asks the *main process* to make these requests, so they are not
 * subject to the page's CORS rules - which is the whole point of the GM_* API.
 * Only http/https are accepted; anything else is refused before a socket is opened.
 */

const https = require('node:https');
const http = require('node:http');

const TIMEOUT_MS = 30000;

/**
 * @param {string} url
 * @param {{ method?: string, headers?: object, body?: string|Buffer }} [options]
 * @returns {Promise<{ status: number, statusText: string, headers: object, body: Buffer }>}
 */
function requestUrl(url, options = {}) {
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

    const client = parsed.protocol === 'https:' ? https : http;
    const request = client.request(parsed, {
      method: options.method || 'GET',
      headers: options.headers || {},
      timeout: TIMEOUT_MS,
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode || 0,
        statusText: response.statusMessage || '',
        headers: response.headers,
        body: Buffer.concat(chunks),
      }));
    });

    request.on('timeout', () => request.destroy(new Error('请求超时')));
    request.on('error', reject);
    if (options.body) request.write(options.body);
    request.end();
  });
}

module.exports = { TIMEOUT_MS, requestUrl };
