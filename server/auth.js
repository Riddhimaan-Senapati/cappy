import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { loadState, saveState } from './storage.js';

const issuer = 'https://auth.openai.com';
const resource = 'https://api.openai.com/v1';
const redirectUri = 'http://127.0.0.1:3210/auth/callback';
const jwks = createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`));
const random = () => randomBytes(32).toString('base64url');
let state = await loadState();
await saveState(state);
let pending;
let refresh;
let authError = null;
let generation = 0;

const active = () => state.accounts.find(account => account.clientId === state.activeId);

async function exchange(parameters) {
  const response = await fetch(`${issuer}/api/accounts/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ ...parameters, resource }),
    signal: AbortSignal.timeout(30_000),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(`ChatGPT token exchange failed (${response.status}). Please sign in again.`);
  if (!body.access_token || !Number.isFinite(body.expires_in)) throw new Error('ChatGPT returned an incomplete token response.');
  return body;
}

export function status() {
  const account = active();
  return {
    connected: Boolean(account?.access_token),
    email: account?.email,
    accounts: state.accounts.map(account => ({ id: account.clientId, email: account.email })),
    activeId: state.activeId,
    pending: Boolean(pending && pending.expires > Date.now()),
    error: authError,
  };
}

export function startLogin(accountId) {
  if (refresh) throw new Error('Token refresh is in progress. Try again in a moment.');
  const account = accountId ? state.accounts.find(item => item.clientId === accountId) : null;
  if (accountId && !account) throw new Error('Unknown ChatGPT account.');
  generation++;
  pending = { generation, state: random(), nonce: random(), verifier: random(), account, expires: Date.now() + 600_000 };
  authError = null;
  const params = new URLSearchParams({
    client_id: account?.clientId || 'dynamic_agent_client',
    ext_agent_host_id: state.hostId,
    response_type: 'code',
    redirect_uri: redirectUri,
    scope: 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct',
    resource,
    state: pending.state,
    nonce: pending.nonce,
    code_challenge_method: 'S256',
    code_challenge: createHash('sha256').update(pending.verifier).digest('base64url'),
  });
  if (!account) params.set('agent_name_hint', 'Browser Agent');
  if (account?.id_token) params.set('id_token_hint', account.id_token);
  if (account?.email) params.set('login_hint', account.email);
  return `${issuer}/api/accounts/authorize?${params}`;
}

export async function finishLogin(params) {
  const attempt = pending;
  const returnedState = Buffer.from(params.get('state') || '');
  const expectedState = Buffer.from(attempt?.state || '');
  if (!attempt || attempt.expires < Date.now() || returnedState.length !== expectedState.length ||
      !timingSafeEqual(returnedState, expectedState)) {
    throw new Error('Invalid or expired login state. Start sign-in from the extension again.');
  }
  pending = null;
  try {
    if (params.has('error')) throw new Error('ChatGPT sign-in was declined. Please try again and allow ChatGPT plan usage.');
    const clientId = params.get('client_id') || attempt.account?.clientId;
    if (!clientId || clientId === 'dynamic_agent_client') throw new Error('ChatGPT did not issue a client ID. Please register again.');
    if (attempt.account && clientId !== attempt.account.clientId) throw new Error('The returning client ID does not match this account.');
    if (!params.get('code')) throw new Error('Missing authorization code.');
    const tokens = await exchange({
      grant_type: 'authorization_code', client_id: clientId,
      code: params.get('code'), code_verifier: attempt.verifier, redirect_uri: redirectUri,
    });
    const { payload } = await jwtVerify(tokens.id_token, jwks, { issuer, audience: clientId, requiredClaims: ['exp', 'sub', 'nonce'] });
    if (payload.nonce !== attempt.nonce) throw new Error('The ChatGPT identity nonce does not match.');
    if (attempt.account && payload.sub !== attempt.account.subject) throw new Error('The signed-in ChatGPT account does not match.');
    if (!tokens.scope?.split(' ').includes('chatgpt.tokens.use.direct')) throw new Error('Allow ChatGPT plan usage during sign-in to use Browser Agent.');
    if (attempt.generation !== generation) throw new Error('This sign-in was cancelled. Start again.');
    const account = {
      clientId, subject: payload.sub, email: payload.email || payload.sub,
      ...tokens, expiresAt: Date.now() + tokens.expires_in * 1000,
    };
    state.accounts = state.accounts.filter(item => item.clientId !== clientId);
    state.accounts.push(account);
    state.activeId = clientId;
    await saveState(state);
  } catch (error) {
    authError = error.message;
    throw error;
  }
}

export async function accessToken() {
  if (pending?.expires < Date.now()) pending = null;
  if (pending) throw new Error('Finish ChatGPT sign-in before sending a message.');
  const account = active();
  if (!account?.access_token) throw new Error('Continue with ChatGPT first.');
  if (account.expiresAt > Date.now() + 60_000) return account.access_token;
  if (!refresh) {
    refresh = (async () => {
      if (!account.refresh_token) throw new Error('Your ChatGPT session expired. Please sign in again.');
      const tokens = await exchange({ grant_type: 'refresh_token', client_id: account.clientId, refresh_token: account.refresh_token });
      Object.assign(account, tokens, { expiresAt: Date.now() + tokens.expires_in * 1000 });
      await saveState(state);
      return account.access_token;
    })().finally(() => { refresh = null; });
  }
  return refresh;
}

export async function logout() {
  generation++;
  pending = null;
  if (refresh) await refresh.catch(() => {});
  const account = active();
  let revoked = true;
  if (account?.refresh_token) {
    try {
      const response = await fetch(`${issuer}/api/accounts/oauth/revoke`, {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: account.refresh_token, token_type_hint: 'refresh_token', client_id: account.clientId }),
        signal: AbortSignal.timeout(15_000),
      });
      revoked = response.ok;
    } catch { revoked = false; }
  }
  if (account) {
    for (const key of ['access_token', 'refresh_token', 'id_token', 'expiresAt']) delete account[key];
  }
  authError = null;
  await saveState(state);
  return { revoked };
}
