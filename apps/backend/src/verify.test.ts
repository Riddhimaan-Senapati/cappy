import { describe, expect, test } from "bun:test";
import { VerifyRequest, VerifyResponse, type Verdict } from "@browser-agent/shared";
import { createApp } from "./app";
import { stubAdapter } from "./stub-adapter";
import { stubLlm } from "./stub-llm";
import { stubRequester } from "./requester";
import { splitDataUrl, stubVerifier, type Verifier } from "./verifier";
import { stubPreferenceCompiler } from "./preferences";
import { toGeminiSchema } from "./gemini-adapter";
import { z } from "zod";

const shot = "data:image/png;base64,iVBORw0KGgo=";
const verifyBody = (axeBefore: number, axeAfter: number) => ({
  adaptation: {
    id: "a1",
    sites: ["www.w3.org"],
    reason: { text: "Needs bigger text", needId: "n1" },
    blocks: [{ block: "text_focus", fontScale: 1.4, lineHeight: 1.7, font: "atkinson", hide: [] }],
  },
  before: shot,
  after: shot,
  axeBefore,
  axeAfter,
});

function appWith(verifier: Verifier) {
  return createApp({ adapter: stubAdapter, llm: stubLlm, requester: stubRequester, verifier, compilePreference: stubPreferenceCompiler });
}

function post(path: string, payload: unknown, instance = appWith(stubVerifier)) {
  return instance.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof payload === "string" ? payload : JSON.stringify(payload),
  });
}

describe("stub verifier", () => {
  test.each([
    [5, 2, "improved", "axe violations fell from 5 to 2"],
    [3, 3, "no_change", "axe violations unchanged at 3"],
    [2, 6, "worse", "axe violations rose from 2 to 6"],
  ] as [number, number, Verdict, string][])("axe %i -> %i gives %s", async (before, after, verdict, notes) => {
    const res = await post("/verify", verifyBody(before, after));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ verdict, notes });
  });
});

describe("POST /verify", () => {
  test("bad bodies return 400", async () => {
    expect((await post("/verify", { before: "x" })).status).toBe(400);
    expect((await post("/verify", "{not json")).status).toBe(400);
    expect((await post("/verify", { ...verifyBody(1, 1), before: "https://example.test/a.png" })).status).toBe(400);
  });

  test("oversized body returns 413", async () => {
    const big = await appWith(stubVerifier).request("/verify", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": String(11 * 1024 * 1024) },
      body: "{}",
    });
    expect(big.status).toBe(413);
  });

  test("throwing verifier returns 502", async () => {
    const res = await post(
      "/verify",
      verifyBody(1, 1),
      appWith(async () => {
        throw new Error("model down");
      }),
    );
    expect(res.status).toBe(502);
  });
});

describe("verifier helpers", () => {
  test("splitDataUrl strips the prefix and keeps the mime type", () => {
    expect(splitDataUrl(shot)).toEqual({ mimeType: "image/png", data: "iVBORw0KGgo=" });
    expect(() => splitDataUrl("https://example.test/a.png")).toThrow();
  });

  test("verify response schema has no const keywords for Gemini", () => {
    const schema = toGeminiSchema(z.toJSONSchema(VerifyResponse, { io: "output" }));
    expect(JSON.stringify(schema)).not.toContain('"const"');
  });

  test("VerifyRequest accepts a valid body", () => {
    expect(VerifyRequest.safeParse(verifyBody(1, 0)).success).toBe(true);
  });
});

describe("stub verifier with measured page stats", () => {
  const zero = {
    inputsWithoutLabel: 0,
    smallTargets: 0,
    smallText: 0,
    lowContrastText: 0,
    imagesWithoutAlt: 0,
    runningAnimations: 0,
    visibleAdsOrPopups: 0,
  };
  const request = (extra: Record<string, unknown>) => VerifyRequest.parse({ ...verifyBody(3, 3), ...extra });

  test("a falling problem total is improved even when axe is unchanged", async () => {
    const res = await stubVerifier(request({ statsBefore: { ...zero, smallText: 12 }, statsAfter: zero }));
    expect(res.verdict).toBe("improved");
  });

  test("a rising problem total is worse even when axe is unchanged", async () => {
    const res = await stubVerifier(request({ statsBefore: zero, statsAfter: { ...zero, smallTargets: 2 } }));
    expect(res.verdict).toBe("worse");
  });

  test("equal totals fall back to axe", async () => {
    const res = await stubVerifier(request({ axeAfter: 1, statsBefore: zero, statsAfter: zero }));
    expect(res.verdict).toBe("improved");
  });
});
