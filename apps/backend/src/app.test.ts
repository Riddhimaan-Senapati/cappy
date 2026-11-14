import { describe, expect, test } from "bun:test";
import {
  Adaptation,
  AdaptRequest,
  Profile,
  type AdaptResponse,
  type LlmRequest,
} from "@browser-agent/shared";
import { createApp, type AppDeps } from "./app";
import { stubAdapter } from "./stub-adapter";
import { stubLlm } from "./stub-llm";
import { stubRequester } from "./requester";
import { stubVerifier } from "./verifier";

const outline = { title: "Survey", headings: ["Survey"], forms: 1, images: 0, videos: 0, canvases: 0 };
const profile = Profile.parse({
  version: 1,
  summary: "Likes larger text",
  needs: [{ id: "n1", kind: "text_size", detail: "Prefers larger text", source: "onboarding" }],
});
const adaptRequest = AdaptRequest.parse({ url: "https://www.w3.org/survey", outline, profile });

const deps: AppDeps = { adapter: stubAdapter, llm: stubLlm, requester: stubRequester, verifier: stubVerifier };
const app = createApp(deps);

function post(path: string, body: unknown) {
  return app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function appWithAdapter(response: unknown) {
  return createApp({
    adapter: async () => response as AdaptResponse,
    llm: stubLlm,
    requester: stubRequester,
    verifier: stubVerifier,
  });
}

const cssAdaptation = {
  kind: "adaptation",
  adaptation: {
    id: "x1",
    sites: ["www.w3.org"],
    reason: { text: "Needs bigger text", needId: "n1" },
    blocks: [],
    css: "body{background:url(https://evil.test/?c=1)}",
  },
};

describe("health", () => {
  test("GET /health returns ok", async () => {
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});

describe("POST /adapt", () => {
  test("valid request returns an adaptation that passes Adaptation.parse", async () => {
    const res = await post("/adapt", adaptRequest);
    expect(res.status).toBe(200);
    const body = (await res.json()) as AdaptResponse;
    expect(body.kind).toBe("adaptation");
    if (body.kind !== "adaptation") throw new Error("expected adaptation");
    expect(() => Adaptation.parse(body.adaptation)).not.toThrow();
    expect<string[]>(body.adaptation.sites).toEqual(["www.w3.org"]);
  });

  test("empty needs returns none", async () => {
    const res = await post("/adapt", { ...adaptRequest, profile: { ...profile, needs: [] } });
    expect(await res.json()).toEqual({ kind: "none", reason: "no needs in profile" });
  });

  test("malformed body returns 400 with issues", async () => {
    const res = await post("/adapt", { url: "not a url" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { issues: unknown[] };
    expect(body.issues.length).toBeGreaterThan(0);
  });

  test("non-JSON body returns 400", async () => {
    const res = await post("/adapt", "{not json");
    expect(res.status).toBe(400);
  });

  test("adapter output with forbidden css is blocked", async () => {
    const res = await appWithAdapter(cssAdaptation).request("/adapt", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(adaptRequest),
    });
    expect(await res.json()).toEqual({ kind: "blocked", reason: "adaptation failed validation" });
  });

  test("adaptation scoped to another host is blocked", async () => {
    const offHost = {
      kind: "adaptation",
      adaptation: {
        id: "x2",
        sites: ["evil.test"],
        reason: { text: "Needs bigger text", needId: "n1" },
        blocks: [{ block: "text_focus", fontScale: 1.3, lineHeight: 1.6, font: "atkinson", hide: [] }],
      },
    };
    const res = await appWithAdapter(offHost).request("/adapt", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(adaptRequest),
    });
    expect(await res.json()).toEqual({ kind: "blocked", reason: "adaptation failed validation" });
  });

  test("throwing adapter returns 502 blocked", async () => {
    const failing = createApp({
      adapter: async () => {
        throw new Error("upstream down");
      },
      llm: stubLlm,
      requester: stubRequester,
      verifier: stubVerifier,
    });
    const res = await failing.request("/adapt", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(adaptRequest),
    });
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ kind: "blocked", reason: "adapter unavailable" });
  });
});

describe("POST /llm", () => {
  test("colorblind message returns a color_vision proposal", async () => {
    const req: LlmRequest = {
      messages: [{ role: "user", content: "I am colorblind" }],
      jsonSchema: { type: "object" },
    };
    const res = await post("/llm", req);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { text: string };
    const parsed = JSON.parse(body.text);
    expect(parsed.proposal).toEqual({
      kind: "color_vision",
      detail: "red-green colorblind",
      why: "You said you are colorblind",
    });
    expect(typeof parsed.reply).toBe("string");
  });

  test("plain message with jsonSchema returns null proposal", async () => {
    const req: LlmRequest = {
      messages: [{ role: "user", content: "Hello" }],
      jsonSchema: { type: "object" },
    };
    const res = await post("/llm", req);
    expect(JSON.parse(((await res.json()) as { text: string }).text)).toEqual({
      reply: "Thanks. I noted that.",
      proposal: null,
    });
  });

  test("malformed body returns 400", async () => {
    const res = await post("/llm", { messages: [] });
    expect(res.status).toBe(400);
  });
});

describe("CORS", () => {
  test("allows chrome extension and localhost origins only", async () => {
    const allowed = await app.request("/health", { headers: { origin: "chrome-extension://abc" } });
    expect(allowed.headers.get("access-control-allow-origin")).toBe("chrome-extension://abc");

    const local = await app.request("/health", { headers: { origin: "http://localhost:5173" } });
    expect(local.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");

    const other = await app.request("/health", { headers: { origin: "https://evil.test" } });
    expect(other.headers.get("access-control-allow-origin")).toBeNull();
  });
});
