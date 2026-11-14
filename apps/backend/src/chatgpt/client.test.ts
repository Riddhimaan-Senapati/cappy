import { describe, expect, test } from "bun:test";
import { buildResponsesBody, chooseModel, collectOutput, DEFAULT_MODEL, responses, strictCompatible, type ClientDeps } from "./client";

const sse = (...events: object[]) => events.map((e) => `event: x\ndata: ${JSON.stringify(e)}\n\n`).join("");
const completed = { type: "response.completed", response: { output: [] } };

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function streamResponse(text: string): Response {
  return new Response(text, { status: 200, headers: { "content-type": "text/event-stream" } });
}

describe("buildResponsesBody", () => {
  test("sends store false, stream true, the model, and structured output", () => {
    const schema = { $schema: "x", type: "object", properties: { a: { type: "string" } }, required: ["a"], additionalProperties: false };
    const body = buildResponsesBody("gpt-test", {
      instructions: "be brief",
      input: [{ role: "user", content: "hi" }],
      schema: { name: "reply", schema },
    });
    expect(body).toEqual({
      model: "gpt-test",
      instructions: "be brief",
      input: [{ role: "user", content: "hi" }],
      store: false,
      stream: true,
      text: {
        format: {
          type: "json_schema",
          name: "reply",
          schema: { type: "object", properties: { a: { type: "string" } }, required: ["a"], additionalProperties: false },
          strict: true,
        },
      },
    });
  });

  test("falls back to non-strict when an object leaves a property optional", () => {
    const schema = { type: "object", properties: { a: { type: "string" }, b: { type: "string" } }, required: ["a"], additionalProperties: false };
    const body = buildResponsesBody("m", { input: [], schema: { name: "s", schema } }) as {
      text: { format: { strict: boolean } };
    };
    expect(body.text.format.strict).toBe(false);
    expect(strictCompatible(schema)).toBe(false);
  });

  test("omits instructions and text when not given", () => {
    const body = buildResponsesBody("m", { input: [{ role: "user", content: "x" }] });
    expect(body).not.toHaveProperty("instructions");
    expect(body).not.toHaveProperty("text");
  });
});

describe("responses", () => {
  test("posts the right URL, headers, and body, and returns the streamed text", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const deps: ClientDeps = {
      accessToken: async () => "tok-1",
      refreshToken: async () => {
        throw new Error("should not refresh");
      },
      model: async () => "gpt-test",
      fetch: async (input, init) => {
        calls.push({ url: String(input), init: init! });
        return streamResponse(
          sse(
            { type: "response.output_text.delta", delta: "Hel" },
            { type: "response.output_text.delta", delta: "lo" },
            completed,
          ),
        );
      },
    };
    const text = await responses({ input: [{ role: "user", content: "hi" }] }, deps);
    expect(text).toBe("Hello");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.openai.com/v1/responses");
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe("Bearer tok-1");
    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body.store).toBe(false);
    expect(body.stream).toBe(true);
    expect(body.model).toBe("gpt-test");
  });

  test("refreshes once on 401 and retries with the new token", async () => {
    const tokens: string[] = [];
    const deps: ClientDeps = {
      accessToken: async () => "old",
      refreshToken: async () => "new",
      model: async () => "m",
      fetch: async (_input, init) => {
        tokens.push((init!.headers as Record<string, string>).Authorization!);
        return tokens.length === 1
          ? jsonResponse(401, { error: { message: "expired" } })
          : streamResponse(sse({ type: "response.output_text.delta", delta: "ok" }, completed));
      },
    };
    expect(await responses({ input: [{ role: "user", content: "x" }] }, deps)).toBe("ok");
    expect(tokens).toEqual(["Bearer old", "Bearer new"]);
  });

  test("surfaces plan-limit failures from the stream", async () => {
    const deps: ClientDeps = {
      accessToken: async () => "t",
      refreshToken: async () => "t",
      model: async () => "m",
      fetch: async () =>
        streamResponse(
          sse({ type: "response.failed", response: { error: { code: "subscription_sharing_usage_limit_exceeded" } } }),
        ),
    };
    await expect(responses({ input: [{ role: "user", content: "x" }] }, deps)).rejects.toThrow(/plan limit/);
  });
});

describe("collectOutput", () => {
  test("uses the completed output when no deltas were streamed", () => {
    const text = collectOutput(
      sse({
        type: "response.completed",
        response: { output: [{ type: "message", content: [{ type: "output_text", text: "{\"a\":1}" }] }] },
      }),
    );
    expect(text).toBe('{"a":1}');
  });

  test("throws when the stream ends before completion", () => {
    expect(() => collectOutput(sse({ type: "response.output_text.delta", delta: "partial" }))).toThrow(/completed/);
  });

  test("throws on an incomplete response", () => {
    expect(() => collectOutput(sse({ type: "response.incomplete" }))).toThrow(/stopped/);
  });
});

describe("chooseModel", () => {
  test("an explicit CHATGPT_MODEL wins without a network call", async () => {
    const fetchImpl = (async () => {
      throw new Error("should not be called");
    }) as unknown as typeof fetch;
    expect(await chooseModel("t", " gpt-explicit ", fetchImpl)).toBe("gpt-explicit");
  });

  test("otherwise picks the first listed model from the account catalog", async () => {
    const seen: { url: string; auth: string }[] = [];
    const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
      seen.push({ url: String(input), auth: (init!.headers as Record<string, string>).Authorization! });
      return jsonResponse(200, {
        models: [
          { slug: "hidden-one", visibility: "hide" },
          { slug: "first-listed", visibility: "list" },
          { slug: "second-listed", visibility: "list" },
        ],
      });
    }) as unknown as typeof fetch;
    expect(await chooseModel("tok", undefined, fetchImpl)).toBe("first-listed");
    expect(seen).toEqual([{ url: "https://api.openai.com/v1/models", auth: "Bearer tok" }]);
  });

  test("falls back to the documented default when the catalog fails", async () => {
    const fetchImpl = (async () => jsonResponse(401, {})) as unknown as typeof fetch;
    expect(await chooseModel("tok", "", fetchImpl)).toBe(DEFAULT_MODEL);
  });
});
