import assert from "node:assert/strict";
import { createServer, request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import express from "express";
import type { WebSocket } from "ws";
import type { RunRequest } from "../shared/protocol.js";
import { AgentSession } from "../server/agent/session.js";
import { logViewer } from "../server/log-viewer.js";

function sessionWith(revert: (id: string) => Promise<{ ok: boolean }>) {
  const session = new AgentSession({ readyState: 3, send() {} } as unknown as WebSocket, { runId: "r" } as RunRequest);
  (session as any).callTab = (_name: string, input: { id: string }) => revert(input.id);
  return session;
}

test("undo keeps the ids it could not revert and reports failure", async () => {
  const session = sessionWith(async (id) => ({ ok: id !== "b" }));
  for (const id of ["a", "b", "c"]) session.appliedIds.add(id);
  assert.equal(await session.undoAppliedChanges(), false);
  assert.deepEqual([...session.appliedIds], ["b"]);
});

test("undo treats a rejected revert as failed and succeeds when all revert", async () => {
  const flaky = sessionWith(async () => { throw new Error("tab gone"); });
  flaky.appliedIds.add("a");
  assert.equal(await flaky.undoAppliedChanges(), false);
  const fine = sessionWith(async () => ({ ok: true }));
  fine.appliedIds.add("a");
  assert.equal(await fine.undoAppliedChanges(), true);
  assert.equal(fine.appliedIds.size, 0);
});

function get(server: Server, path: string, headers: Record<string, string>): Promise<number> {
  const { port } = server.address() as AddressInfo;
  return new Promise((resolve, reject) => {
    httpRequest({ port, host: "127.0.0.1", path, headers }, (res) => { res.resume(); resolve(res.statusCode ?? 0); }).on("error", reject).end();
  });
}

test("the log viewer needs logging on, a local host and no cross-site request", async () => {
  const app = express();
  app.use(logViewer);
  const server = createServer(app).listen(0);
  try {
    delete process.env.log_llm_requests;
    delete process.env.log_llm_request;
    delete process.env.LOG_LLM_REQUESTS;
    assert.equal(await get(server, "/api/llm-logs", {}), 404);
    process.env.LOG_LLM_REQUESTS = "true";
    assert.equal(await get(server, "/api/llm-logs", {}), 200);
    assert.equal(await get(server, "/api/llm-logs", { Host: "evil.example" }), 404);
    assert.equal(await get(server, "/api/llm-logs", { "Sec-Fetch-Site": "cross-site" }), 404);
    assert.equal(await get(server, "/api/llm-logs", { Origin: "https://evil.example" }), 404);
  } finally {
    delete process.env.LOG_LLM_REQUESTS;
    server.close();
  }
});
