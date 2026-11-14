import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { finishLogin, logout, startLogin, status } from './auth.js';
import { listModels, plan } from './planner.js';

const manifest = JSON.parse(await readFile(new URL('../extension/manifest.json', import.meta.url)));
const extensionId = [...createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest().subarray(0, 16)]
  .map(byte => String.fromCharCode(97 + (byte >> 4), 97 + (byte & 15))).join('');
const origin = `chrome-extension://${extensionId}`;

function json(response, code, body) {
  response.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(body));
}

async function body(request) {
  let data = '';
  for await (const chunk of request) {
    data += chunk;
    if (data.length > 128_000) throw new Error('Request is too large.');
  }
  return data ? JSON.parse(data) : {};
}

const server = createServer(async (request, response) => {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  if (request.headers.host !== '127.0.0.1:3210') return json(response, 403, { error: 'Invalid host.' });
  if (request.headers.origin && request.headers.origin !== origin) return json(response, 403, { error: 'Only Browser Agent can use this helper.' });
  response.setHeader('Access-Control-Allow-Origin', origin);
  response.setHeader('Vary', 'Origin');
  if (request.method === 'OPTIONS') {
    response.setHeader('Access-Control-Allow-Methods', 'GET, POST');
    response.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Browser-Agent');
    response.writeHead(204);
    return response.end();
  }
  const url = new URL(request.url, 'http://127.0.0.1:3210');
  if (url.pathname === '/auth/callback' && request.method === 'GET') {
    try {
      await finishLogin(url.searchParams);
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'" });
      return response.end('<!doctype html><title>Browser Agent connected</title><body style="font:18px system-ui;padding:64px;max-width:560px;margin:auto"><h1>You’re connected.</h1><p>Return to your page and click Browser Agent to start chatting. You can close this tab.</p>');
    } catch {
      response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      return response.end('Sign-in did not complete. Return to Browser Agent for details and try again.');
    }
  }
  if (request.headers['x-browser-agent'] !== extensionId) return json(response, 403, { error: 'Missing extension request header.' });
  try {
    if (url.pathname === '/status' && request.method === 'GET') return json(response, 200, status());
    if (url.pathname === '/auth/start' && request.method === 'POST') {
      const { accountId } = await body(request);
      return json(response, 200, { url: startLogin(accountId) });
    }
    if (url.pathname === '/auth/logout' && request.method === 'POST') return json(response, 200, await logout());
    if (url.pathname === '/models' && request.method === 'GET') return json(response, 200, { models: await listModels() });
    if (url.pathname === '/plan' && request.method === 'POST') return json(response, 200, await plan(await body(request)));
    return json(response, 404, { error: 'Not found.' });
  } catch (error) {
    json(response, 400, { error: error.message });
  }
});
server.requestTimeout = 100_000;
server.listen(3210, '127.0.0.1', () => {
  console.log('Browser Agent helper is ready at http://127.0.0.1:3210');
  console.log(`Load the extension/ directory in Chrome. Extension ID: ${extensionId}`);
});
server.on('error', error => {
  console.error(error.code === 'EADDRINUSE' ? 'Port 3210 is already in use. Stop the other helper before starting this one.' : error.message);
  process.exitCode = 1;
});
