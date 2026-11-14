import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  assertPlanScope,
  buildAuthorizeUrl,
  callbackPort,
  decodeIdToken,
  parseScopes,
  pkcePair,
  readCredentials,
  writeCredentials,
  type ChatGptCredentials,
} from "./auth";
import { newHostId } from "./auth";

const sample: ChatGptCredentials = {
  issuer: "https://auth.openai.com",
  client_id: "oaiapp_test",
  ext_agent_host_id: "host-1",
  subject: "user-1",
  email: "user@example.com",
  id_token: "header.payload.sig",
  access_token: "access",
  refresh_token: "refresh",
  scopes: ["openid", "chatgpt.tokens.use.direct"],
  expires_at: 1_900_000_000_000,
};

describe("PKCE", () => {
  test("challenge is base64url SHA-256 of the verifier (RFC 7636 vector)", () => {
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    const { challenge } = pkcePair();
    expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(createHash("sha256").update(verifier).digest("base64url")).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });

  test("each call produces a fresh verifier whose challenge matches it", () => {
    const first = pkcePair();
    const second = pkcePair();
    expect(first.verifier).not.toBe(second.verifier);
    expect(first.verifier.length).toBeGreaterThanOrEqual(43);
    expect(createHash("sha256").update(first.verifier).digest("base64url")).toBe(first.challenge);
  });
});

describe("scope check", () => {
  test("rejects a grant without chatgpt.tokens.use.direct", () => {
    expect(() => assertPlanScope(parseScopes("openid profile email offline_access resource.invoke"))).toThrow(
      /chatgpt\.tokens\.use\.direct/,
    );
    expect(() => assertPlanScope([])).toThrow();
  });

  test("accepts a grant that includes chatgpt.tokens.use.direct", () => {
    expect(() => assertPlanScope(parseScopes("openid chatgpt.tokens.use.direct  offline_access"))).not.toThrow();
  });
});

describe("authorize URL", () => {
  const base = {
    hostId: "host-1",
    redirectUri: "http://127.0.0.1:1455/auth/callback",
    state: "s",
    nonce: "n",
    challenge: "c",
  };

  test("first sign-in registers dynamically with an agent name and no consent forcing", () => {
    const url = new URL(buildAuthorizeUrl(base));
    expect(url.searchParams.get("client_id")).toBe("dynamic_agent_client");
    expect(url.searchParams.get("agent_name_hint")).toBeTruthy();
    expect(url.searchParams.get("scope")).toBe(
      "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",
    );
    expect(url.searchParams.get("resource")).toBe("https://api.openai.com/v1");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.has("prompt")).toBe(false);
  });

  test("re-auth reuses the saved client id and hints, without a registration name", () => {
    const url = new URL(
      buildAuthorizeUrl({ ...base, clientId: "oaiapp_test", idTokenHint: "old.id.token", loginHint: "user@example.com" }),
    );
    expect(url.searchParams.get("client_id")).toBe("oaiapp_test");
    expect(url.searchParams.get("id_token_hint")).toBe("old.id.token");
    expect(url.searchParams.get("login_hint")).toBe("user@example.com");
    expect(url.searchParams.has("agent_name_hint")).toBe(false);
    expect(url.searchParams.has("prompt")).toBe(false);
  });
});

describe("ID token claims", () => {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const token = (claims: Record<string, unknown>) => `${encode({ alg: "none" })}.${encode(claims)}.sig`;
  const valid = { iss: "https://auth.openai.com", aud: "oaiapp_test", nonce: "n1", sub: "user-1", exp: Date.now() / 1000 + 600 };

  test("accepts matching claims and returns the subject", () => {
    expect(decodeIdToken(token(valid), "oaiapp_test", "n1")).toEqual({ sub: "user-1", email: undefined });
  });

  test("rejects a nonce mismatch and a foreign audience", () => {
    expect(() => decodeIdToken(token(valid), "oaiapp_test", "other")).toThrow(/nonce/);
    expect(() => decodeIdToken(token(valid), "oaiapp_other", "n1")).toThrow(/different client/);
  });
});

describe("credentials file", () => {
  test("round-trips with mode 600", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "chatgpt-creds-"));
    try {
      const file = path.join(dir, "creds.json");
      writeCredentials(sample, file);
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(readCredentials(file)).toEqual(sample);
      writeCredentials({ ...sample, access_token: "rotated" }, file);
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(JSON.parse(readFileSync(file, "utf8")).access_token).toBe("rotated");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("missing file reads as null", () => {
    expect(readCredentials(path.join(tmpdir(), "does-not-exist-chatgpt.json"))).toBeNull();
  });
});

describe("callback port", () => {
  test("defaults to 1455 and honours CHATGPT_CALLBACK_PORT", () => {
    expect(callbackPort({})).toBe(1455);
    expect(callbackPort({ CHATGPT_CALLBACK_PORT: "8123" })).toBe(8123);
    expect(callbackPort({ CHATGPT_CALLBACK_PORT: "nope" })).toBe(1455);
  });
});

test("host id uses the urn:uuid form OpenAI accepts", () => {
  expect(newHostId()).toMatch(/^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  expect(newHostId()).not.toBe(newHostId());
});
