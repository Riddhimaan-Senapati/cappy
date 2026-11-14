import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const directory = await mkdtemp(join(tmpdir(), 'browser-agent-test-'));
process.env.BROWSER_AGENT_DATA_DIR = directory;
const auth = await import('../server/auth.js');
const { readResponse, validatePlan } = await import('../server/planner.js');
test.after(() => rm(directory, { recursive: true, force: true }));

async function* chunks(text) {
  const bytes = new TextEncoder().encode(text);
  for (let i = 0; i < bytes.length; i += 7) yield bytes.slice(i, i + 7);
}

test('OAuth uses a stable host, fresh PKCE/state/nonce, and the official dynamic client', async () => {
  const first = new URL(auth.startLogin());
  const second = new URL(auth.startLogin());
  assert.equal(first.origin, 'https://auth.openai.com');
  assert.equal(first.searchParams.get('client_id'), 'dynamic_agent_client');
  assert.equal(first.searchParams.get('redirect_uri'), 'http://127.0.0.1:3210/auth/callback');
  assert.equal(first.searchParams.get('ext_agent_host_id'), second.searchParams.get('ext_agent_host_id'));
  for (const field of ['state', 'nonce', 'code_challenge']) assert.notEqual(first.searchParams.get(field), second.searchParams.get(field));
  await assert.rejects(auth.finishLogin(new URLSearchParams({ state: 'invalid', code: 'code' })), /Invalid or expired/);
  assert.equal(auth.status().connected, false);
  await assert.rejects(auth.finishLogin(new URLSearchParams({ state: second.searchParams.get('state'), error: 'access_denied' })), /declined/);
  assert.equal(auth.status().pending, false);
});

test('SSE parser handles split UTF-8 and waits for the terminal success event', async () => {
  const stream = 'data: {"type":"response.output_text.delta","delta":"A–Z"}\r\n\r\ndata: {"type":"response.completed"}\n\ndata: [DONE]\n\n';
  assert.equal(await readResponse(chunks(stream)), 'A–Z');
});

test('partial or failed inference never produces an executable action', async () => {
  await assert.rejects(readResponse(chunks('data: {"type":"response.output_text.delta","delta":"partial"}\n\n')), /interrupted/);
  await assert.rejects(readResponse(chunks('data: {"type":"response.failed","response":{"error":{"message":"Plan limit reached"}}}\n\n')), /Plan limit/);
});


test('model edit plans can only refer to IDs from the current page context', () => {
  const page = { html: '<main id="n1"><h1 id="n2">Title</h1></main>' };
  assert.equal(validatePlan({ action: 'edit', message: 'Change title', operations: [{ type: 'text', id: 'n2', text: 'New title' }] }, page).action, 'edit');
  assert.throws(() => validatePlan({ action: 'edit', message: 'Change title', operations: [{ type: 'hide', ids: ['n999'] }] }, page), /outside/);
  assert.throws(() => validatePlan({ action: 'edit', message: 'Execute', operations: [{ type: 'script', id: 'n2' }] }, page), /unsupported/);
});
