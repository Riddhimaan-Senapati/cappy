import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRemoteJWKSet, jwtVerify } from "jose";

const ISSUER = "https://auth.openai.com";
const AUTHORIZE_URL = `${ISSUER}/api/accounts/authorize`;
const TOKEN_URL = `${ISSUER}/api/accounts/oauth/token`;
const RESOURCE = "https://api.openai.com/v1";
const SCOPES = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
const REQUIRED_SCOPE = "chatgpt.tokens.use.direct";
const CALLBACK_PORT = Number(process.env.CHATGPT_CALLBACK_PORT ?? 1455);
const REDIRECT_URI = `http://127.0.0.1:${CALLBACK_PORT}/auth/callback`;
const AGENT_NAME = "Adaptive Browser Agent";
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

const rootDir = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
export const CREDENTIALS_PATH = path.join(rootDir, ".chatgpt-credentials.json");

export interface ChatGptCredentials {
  email?: string;
  issuer: string;
  subject: string;
  client_id: string;
  ext_agent_host_id: string;
  id_token?: string;
  access_token?: string;
  refresh_token?: string;
  token_type: string;
  expires_in: number;
  scopes: string[];
  saved_at: string;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  token_type: string;
  expires_in: number;
  scope?: string;
}

const base64url = (buffer: Buffer) => buffer.toString("base64url");

export function isSignedIn(): boolean {
  return Boolean(readCredentials()?.refresh_token);
}

// Keeps the issued client_id and host id so the next sign-in reuses the same registration, as OpenAI's docs ask.
export function signOut() {
  const current = readCredentials();
  if (!current) return;
  const { access_token: _access, refresh_token: _refresh, id_token: _id, ...registration } = current;
  writeCredentials({ ...registration, scopes: [], expires_in: 0, saved_at: new Date().toISOString() });
}

export function readCredentials(): ChatGptCredentials | null {
  if (!existsSync(CREDENTIALS_PATH)) return null;
  return JSON.parse(readFileSync(CREDENTIALS_PATH, "utf8")) as ChatGptCredentials;
}

function writeCredentials(credentials: ChatGptCredentials) {
  const temp = `${CREDENTIALS_PATH}.tmp`;
  writeFileSync(temp, JSON.stringify(credentials, null, 2), { mode: 0o600 });
  renameSync(temp, CREDENTIALS_PATH);
}

async function postToken(body: Record<string, string>): Promise<TokenResponse> {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
  });
  const json = (await response.json()) as TokenResponse & { error?: string; error_description?: string };
  if (!response.ok) throw new Error(`Token endpoint ${response.status}: ${json.error ?? ""} ${json.error_description ?? ""}`.trim());
  return json;
}

async function verifyIdToken(idToken: string, clientId: string, nonce?: string) {
  const discovery = (await (await fetch(`${ISSUER}/.well-known/openid-configuration`)).json()) as { jwks_uri: string };
  const { payload } = await jwtVerify(idToken, createRemoteJWKSet(new URL(discovery.jwks_uri)), { issuer: ISSUER, audience: clientId });
  if (nonce && payload.nonce !== nonce) throw new Error("ID token nonce mismatch");
  if (!payload.sub) throw new Error("ID token has no subject");
  return payload as { sub: string; email?: string };
}

function grantedScopes(token: TokenResponse, fallback: string[]): string[] {
  return token.scope ? token.scope.split(/\s+/).filter(Boolean) : fallback;
}

let refreshing: Promise<ChatGptCredentials> | null = null;

export async function getAccessToken(): Promise<string> {
  const credentials = readCredentials();
  if (!credentials?.access_token || !credentials.refresh_token) throw new Error("Not signed in to ChatGPT. Sign in from the extension settings.");
  const expiresAt = Date.parse(credentials.saved_at) + credentials.expires_in * 1000;
  if (Date.now() < expiresAt - REFRESH_MARGIN_MS) return credentials.access_token;
  const refreshed = await refreshCredentials(credentials);
  if (!refreshed.access_token) throw new Error("ChatGPT did not return an access token. Sign in again from the extension settings.");
  return refreshed.access_token;
}

export function refreshCredentials(current = readCredentials()): Promise<ChatGptCredentials> {
  if (!current?.refresh_token) return Promise.reject(new Error("Not signed in to ChatGPT. Sign in from the extension settings."));
  refreshing ??= (async () => {
    try {
      const token = await postToken({
        grant_type: "refresh_token",
        client_id: current.client_id,
        refresh_token: current.refresh_token!,
        resource: RESOURCE,
      });
      const next: ChatGptCredentials = {
        ...current,
        access_token: token.access_token,
        refresh_token: token.refresh_token ?? current.refresh_token,
        id_token: token.id_token ?? current.id_token,
        token_type: token.token_type,
        expires_in: token.expires_in,
        scopes: grantedScopes(token, current.scopes),
        saved_at: new Date().toISOString(),
      };
      writeCredentials(next);
      return next;
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

function openBrowser(url: string) {
  const command = process.platform === "win32" ? "cmd" : process.platform === "darwin" ? "open" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url.replace(/&/g, "^&")] : [url];
  spawn(command, args, { stdio: "ignore", detached: true }).unref();
}

export async function login(): Promise<ChatGptCredentials> {
  const existing = readCredentials();
  const hostId = existing?.ext_agent_host_id ?? `urn:uuid:${randomUUID()}`;
  const clientId = existing?.client_id;
  const state = base64url(randomBytes(24));
  const nonce = base64url(randomBytes(24));
  const verifier = base64url(randomBytes(48));
  const challenge = base64url(createHash("sha256").update(verifier).digest());

  const params = new URLSearchParams({
    client_id: clientId ?? "dynamic_agent_client",
    ext_agent_host_id: hostId,
    response_type: "code",
    redirect_uri: REDIRECT_URI,
    scope: SCOPES,
    resource: RESOURCE,
    state,
    nonce,
    code_challenge_method: "S256",
    code_challenge: challenge,
  });
  if (clientId) {
    if (existing!.id_token) params.set("id_token_hint", existing!.id_token);
    if (existing!.email) params.set("login_hint", existing!.email);
  } else {
    params.set("agent_name_hint", AGENT_NAME);
  }

  const callback = await new Promise<URLSearchParams>((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", REDIRECT_URI);
      if (url.pathname !== "/auth/callback") return void res.writeHead(404).end();
      res.writeHead(200, { "content-type": "text/html" }).end("<p>Signed in. You can close this tab and go back to the terminal.</p>");
      server.close();
      resolve(url.searchParams);
    });
    server.on("error", reject);
    server.listen(CALLBACK_PORT, "127.0.0.1", () => {
      const url = `${AUTHORIZE_URL}?${params}`;
      console.log(`Opening your browser to sign in with ChatGPT.\nIf it does not open, visit:\n${url}\n`);
      openBrowser(url);
    });
  });

  if (callback.get("state") !== state) throw new Error("State mismatch; aborting sign-in");
  if (callback.get("error")) throw new Error(`Sign-in cancelled: ${callback.get("error")}`);
  const issuedClientId = callback.get("client_id") ?? clientId;
  if (!issuedClientId) throw new Error("Registration incomplete: no client_id was issued");
  if (clientId && callback.get("client_id") && callback.get("client_id") !== clientId) throw new Error("Server returned a different client_id; aborting");

  const token = await postToken({
    grant_type: "authorization_code",
    client_id: issuedClientId,
    code: callback.get("code") ?? "",
    code_verifier: verifier,
    redirect_uri: REDIRECT_URI,
    resource: RESOURCE,
  });
  if (!token.id_token || !token.refresh_token) throw new Error("Token response missing id_token or refresh_token");

  const identity = await verifyIdToken(token.id_token, issuedClientId, nonce);
  if (existing && existing.subject !== identity.sub) console.warn("Signed in as a different account; replacing saved credentials.");
  const scopes = grantedScopes(token, (callback.get("scope") ?? "").split(/[\s+]+/).filter(Boolean));
  if (!scopes.includes(REQUIRED_SCOPE)) throw new Error(`Plan usage was not granted (missing ${REQUIRED_SCOPE}). Approve "Use your ChatGPT plan" when signing in.`);

  const credentials: ChatGptCredentials = {
    email: identity.email,
    issuer: ISSUER,
    subject: identity.sub,
    client_id: issuedClientId,
    ext_agent_host_id: hostId,
    id_token: token.id_token,
    access_token: token.access_token,
    refresh_token: token.refresh_token,
    token_type: token.token_type,
    expires_in: token.expires_in,
    scopes,
    saved_at: new Date().toISOString(),
  };
  writeCredentials(credentials);
  return credentials;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  login()
    .then((credentials) => console.log(`Signed in${credentials.email ? ` as ${credentials.email}` : ""}. Set LLM_PROVIDER=chatgpt-signin in .env.`))
    .catch((error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    });
}
