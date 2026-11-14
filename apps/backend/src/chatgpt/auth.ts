import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmodSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ISSUER = "https://auth.openai.com";
export const RESOURCE = "https://api.openai.com/v1";
const AUTHORIZE_URL = `${ISSUER}/api/accounts/authorize`;
const TOKEN_URL = `${ISSUER}/api/accounts/oauth/token`;
const DISCOVERY_URL = `${ISSUER}/.well-known/openid-configuration`;
export const SCOPES = [
  "openid",
  "profile",
  "email",
  "offline_access",
  "resource.invoke",
  "chatgpt.tokens.use.direct",
];
export const REQUIRED_SCOPE = "chatgpt.tokens.use.direct";
const DYNAMIC_CLIENT = "dynamic_agent_client";
const AGENT_NAME = "Adaptive Browser Agent";
const CALLBACK_PATH = "/auth/callback";
const DEFAULT_CALLBACK_PORT = 1455;
const LOGIN_TIMEOUT_MS = 5 * 60_000;
const REFRESH_MARGIN_MS = 60_000;

export const CREDENTIALS_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../.chatgpt-credentials.json",
);

export interface ChatGptCredentials {
  issuer: string;
  client_id: string;
  ext_agent_host_id: string;
  subject: string;
  email?: string;
  id_token: string;
  access_token: string;
  refresh_token: string;
  scopes: string[];
  expires_at: number;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  token_type?: string;
  expires_in: number;
  scope?: string;
}

export function callbackPort(env: Record<string, string | undefined> = process.env): number {
  const port = Number(env.CHATGPT_CALLBACK_PORT);
  return Number.isInteger(port) && port > 0 ? port : DEFAULT_CALLBACK_PORT;
}

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export function parseScopes(raw: string | undefined): string[] {
  return raw ? raw.split(/\s+/).filter(Boolean) : [];
}

export function assertPlanScope(scopes: readonly string[]): void {
  if (scopes.includes(REQUIRED_SCOPE)) return;
  throw new Error(
    `ChatGPT did not grant plan usage (${REQUIRED_SCOPE}). Run bun run chatgpt:login again and allow "use your ChatGPT plan".`,
  );
}

export function buildAuthorizeUrl(options: {
  clientId?: string;
  hostId: string;
  redirectUri: string;
  state: string;
  nonce: string;
  challenge: string;
  idTokenHint?: string;
  loginHint?: string;
}): string {
  const params = new URLSearchParams({
    response_type: "code",
    redirect_uri: options.redirectUri,
    scope: SCOPES.join(" "),
    resource: RESOURCE,
    state: options.state,
    nonce: options.nonce,
    code_challenge: options.challenge,
    code_challenge_method: "S256",
    ext_agent_host_id: options.hostId,
  });
  if (options.clientId) {
    params.set("client_id", options.clientId);
    if (options.idTokenHint) params.set("id_token_hint", options.idTokenHint);
    if (options.loginHint) params.set("login_hint", options.loginHint);
  } else {
    params.set("client_id", DYNAMIC_CLIENT);
    params.set("agent_name_hint", AGENT_NAME);
  }
  return `${AUTHORIZE_URL}?${params}`;
}

// The ID token arrives straight from the token endpoint over TLS, so its signature is not re-checked here (OIDC Core 3.1.3.7).
export function decodeIdToken(idToken: string, clientId: string, nonce: string): { sub: string; email?: string } {
  const segments = idToken.split(".");
  if (segments.length !== 3) throw new Error("ChatGPT returned a malformed ID token.");
  const claims = JSON.parse(Buffer.from(segments[1]!, "base64url").toString("utf8")) as Record<string, unknown>;
  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (claims.iss !== ISSUER) throw new Error("ChatGPT ID token has an unexpected issuer.");
  if (!audience.includes(clientId)) throw new Error("ChatGPT ID token was issued to a different client.");
  if (claims.nonce !== nonce) throw new Error("ChatGPT ID token nonce does not match this sign-in.");
  if (typeof claims.sub !== "string" || !claims.sub) throw new Error("ChatGPT ID token has no subject.");
  if (typeof claims.exp !== "number" || claims.exp * 1000 <= Date.now()) throw new Error("ChatGPT ID token has expired.");
  return { sub: claims.sub, email: typeof claims.email === "string" ? claims.email : undefined };
}

export function readCredentials(file: string = CREDENTIALS_PATH): ChatGptCredentials | null {
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, "utf8")) as ChatGptCredentials;
}

export function writeCredentials(credentials: ChatGptCredentials, file: string = CREDENTIALS_PATH): void {
  const temp = `${file}.tmp`;
  writeFileSync(temp, `${JSON.stringify(credentials, null, 2)}\n`, { mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, file);
}

export function chatgptSignedIn(file: string = CREDENTIALS_PATH): boolean {
  return existsSync(file);
}

async function postToken(params: Record<string, string>): Promise<TokenResponse> {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
    signal: AbortSignal.timeout(30_000),
  });
  const json = (await response.json().catch(() => ({}))) as Partial<TokenResponse> & { error?: string };
  if (!response.ok) throw new Error(`ChatGPT token request failed (${response.status}): ${json.error ?? "unknown error"}`);
  if (typeof json.access_token !== "string" || typeof json.expires_in !== "number") {
    throw new Error("ChatGPT returned an incomplete token response.");
  }
  return json as TokenResponse;
}

function exchangeCode(clientId: string, code: string, verifier: string, redirectUri: string) {
  return postToken({
    grant_type: "authorization_code",
    client_id: clientId,
    code,
    code_verifier: verifier,
    redirect_uri: redirectUri,
    resource: RESOURCE,
  });
}

function refreshGrant(clientId: string, refreshToken: string) {
  return postToken({ grant_type: "refresh_token", client_id: clientId, refresh_token: refreshToken, resource: RESOURCE });
}

async function revocationEndpoint(): Promise<string> {
  const response = await fetch(DISCOVERY_URL, { signal: AbortSignal.timeout(15_000) });
  const metadata = (await response.json()) as { revocation_endpoint?: unknown };
  if (typeof metadata.revocation_endpoint !== "string") throw new Error("no revocation endpoint published");
  return metadata.revocation_endpoint;
}

async function revokeRefreshToken(credentials: ChatGptCredentials): Promise<boolean> {
  try {
    const response = await fetch(await revocationEndpoint(), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        token: credentials.refresh_token,
        token_type_hint: "refresh_token",
        client_id: credentials.client_id,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

function openBrowser(url: string): void {
  const command = process.platform === "darwin" ? "open" : "xdg-open";
  const child = spawn(command, [url], { stdio: "ignore", detached: true });
  child.on("error", () => console.log("Could not open a browser. Open the URL above by hand."));
  child.unref();
}

function waitForCallback(port: number, onListening: () => void): Promise<URLSearchParams> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
      if (url.pathname !== CALLBACK_PATH) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(
        "<p>Signed in. You can close this tab and return to the terminal.</p>",
      );
      clearTimeout(timer);
      server.close();
      resolve(url.searchParams);
    });
    const timer = setTimeout(() => {
      server.close();
      reject(new Error("Timed out waiting for the ChatGPT sign-in callback."));
    }, LOGIN_TIMEOUT_MS);
    server.on("error", (error) => {
      clearTimeout(timer);
      reject(new Error(`Could not listen on 127.0.0.1:${port} (${error.message}). Free the port or set CHATGPT_CALLBACK_PORT.`));
    });
    server.listen(port, "127.0.0.1", onListening);
  });
}

export async function login(): Promise<ChatGptCredentials> {
  const existing = readCredentials();
  const port = callbackPort();
  const redirectUri = `http://127.0.0.1:${port}${CALLBACK_PATH}`;
  const hostId = existing?.ext_agent_host_id ?? randomUUID();
  const { verifier, challenge } = pkcePair();
  const state = randomBytes(24).toString("base64url");
  const nonce = randomBytes(24).toString("base64url");
  const url = buildAuthorizeUrl({
    clientId: existing?.client_id,
    hostId,
    redirectUri,
    state,
    nonce,
    challenge,
    idTokenHint: existing?.id_token,
    loginHint: existing?.email,
  });

  const callback = await waitForCallback(port, () => {
    console.log(`Opening your browser to sign in with ChatGPT.\nIf it does not open, visit:\n${url}\n`);
    openBrowser(url);
  });

  if (callback.get("state") !== state) throw new Error("Sign-in state did not match; start again.");
  const oauthError = callback.get("error");
  if (oauthError) throw new Error(`ChatGPT sign-in was declined or failed (${oauthError}).`);

  const clientId = callback.get("client_id") ?? existing?.client_id;
  if (!clientId || clientId === DYNAMIC_CLIENT) {
    throw new Error("ChatGPT did not issue a client ID, so registration is incomplete. Run bun run chatgpt:login again.");
  }
  if (existing && clientId !== existing.client_id) throw new Error("ChatGPT returned a different client ID; aborting.");
  const code = callback.get("code");
  if (!code) throw new Error("ChatGPT did not return an authorization code.");

  const token = await exchangeCode(clientId, code, verifier, redirectUri);
  if (!token.id_token || !token.refresh_token) {
    throw new Error("ChatGPT token response is missing the ID token or refresh token (offline_access not granted).");
  }
  const identity = decodeIdToken(token.id_token, clientId, nonce);
  const scopes = parseScopes(token.scope);
  assertPlanScope(scopes);
  if (existing && existing.subject !== identity.sub) {
    console.warn("Signed in as a different ChatGPT account; replacing saved credentials.");
  }

  const credentials: ChatGptCredentials = {
    issuer: ISSUER,
    client_id: clientId,
    ext_agent_host_id: hostId,
    subject: identity.sub,
    email: identity.email,
    id_token: token.id_token,
    access_token: token.access_token,
    refresh_token: token.refresh_token,
    scopes,
    expires_at: Date.now() + token.expires_in * 1000,
  };
  writeCredentials(credentials);
  return credentials;
}

function requireCredentials(): ChatGptCredentials {
  const credentials = readCredentials();
  if (!credentials) throw new Error("Not signed in to ChatGPT. Run bun run chatgpt:login.");
  return credentials;
}

let refreshing: Promise<ChatGptCredentials> | null = null;

async function doRefresh(): Promise<ChatGptCredentials> {
  const current = requireCredentials();
  const token = await refreshGrant(current.client_id, current.refresh_token);
  const scopes = token.scope ? parseScopes(token.scope) : current.scopes;
  assertPlanScope(scopes);
  const next: ChatGptCredentials = {
    ...current,
    access_token: token.access_token,
    refresh_token: token.refresh_token ?? current.refresh_token,
    id_token: token.id_token ?? current.id_token,
    scopes,
    expires_at: Date.now() + token.expires_in * 1000,
  };
  writeCredentials(next);
  return next;
}

export function refreshCredentials(): Promise<ChatGptCredentials> {
  refreshing ??= doRefresh().finally(() => {
    refreshing = null;
  });
  return refreshing;
}

export async function accessToken(): Promise<string> {
  const credentials = requireCredentials();
  if (credentials.expires_at - REFRESH_MARGIN_MS > Date.now()) return credentials.access_token;
  return (await refreshCredentials()).access_token;
}

export async function logout(): Promise<{ hadCredentials: boolean; revoked: boolean }> {
  const credentials = readCredentials();
  if (!credentials) return { hadCredentials: false, revoked: false };
  const revoked = await revokeRefreshToken(credentials);
  rmSync(CREDENTIALS_PATH, { force: true });
  return { hadCredentials: true, revoked };
}

async function main(argv: string[]): Promise<number> {
  const command = argv[2];
  if (command === "login") {
    const credentials = await login();
    console.log(
      `Signed in${credentials.email ? ` as ${credentials.email}` : ""}. Set LLM_PROVIDER=chatgpt in apps/backend/.env to use your ChatGPT plan.`,
    );
    return 0;
  }
  if (command === "logout") {
    const { hadCredentials, revoked } = await logout();
    if (!hadCredentials) console.log("Not signed in to ChatGPT; nothing to do.");
    else if (revoked) console.log("Signed out and revoked the ChatGPT session.");
    else console.log("Signed out locally, but the ChatGPT session could not be revoked. Revoke it in ChatGPT settings.");
    return 0;
  }
  console.error("Usage: bun src/chatgpt/auth.ts <login|logout>");
  return 2;
}

if (import.meta.main) {
  main(process.argv)
    .then((code) => process.exit(code))
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    });
}
