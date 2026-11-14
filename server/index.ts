import "dotenv/config";
import express from "express";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import type { ClientMessage, RunRequest, Tier } from "../shared/protocol.js";
import { createProvider } from "./agent/providers/index.js";
import { pickTier } from "./agent/router.js";
import { AgentSession, RunCancelledError } from "./agent/session.js";
import { detectInjection } from "./safety.js";

const PORT = Number(process.env.PORT ?? 8787);
const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const provider = createProvider();
const app = express();

app.use("/demo", express.static(path.join(rootDir, "demo-sites")));
let availableModels: string[] = [];
let availableAt = 0;
async function getAvailableModels() {
  if (Date.now() - availableAt < 5 * 60_000) return availableModels;
  try {
    availableModels = [...new Set((await provider.listModels?.()) ?? [])].sort();
  } catch (error) {
    console.warn("[models] could not list models:", error instanceof Error ? error.message : error);
  }
  availableAt = Date.now();
  return availableModels;
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, provider: provider.name, models: provider.models });
});

const server = createServer(app);
const wss = new WebSocketServer({ server, path: "/agent" });

async function execute(session: AgentSession, request: RunRequest) {
  const injection = detectInjection(request.page);
  if (injection) {
    console.warn(`[safety] injection blocked before any model call: "${injection}"`);
    session.send({ type: "blocked", runId: request.runId, reason: injection });
    session.send({ type: "done", runId: request.runId, reply: "This page contains text that tries to instruct me, so I didn't change anything." });
    return;
  }

  let tier: Tier = pickTier(request);
  const modelFor = (which: Tier) => request.models?.[which] || provider.models[which];
  const announce = () => session.send({ type: "tier", runId: request.runId, tier, model: modelFor(tier) });
  announce();
  let reply = await provider.run(session, tier, modelFor(tier));

  if (tier === "fast" && request.routing === "auto" && !session.blockedReason && session.struggled()) {
    session.progress("That didn't land. Trying a stronger model");
    await session.undoAppliedChanges();
    tier = "frontier";
    announce();
    reply = await provider.run(session, tier, modelFor(tier));
  }

  if (session.blockedReason) {
    console.warn(`[safety] injection blocked: "${session.blockedReason}"`);
    session.send({ type: "blocked", runId: request.runId, reason: session.blockedReason });
    reply = "This page contains text that tries to instruct me, so I didn't change anything.";
  }
  session.send({ type: "done", runId: request.runId, reply });
}

wss.on("connection", (socket, request) => {
  if (!(request.headers.origin ?? "").startsWith("chrome-extension://")) {
    socket.close(1008, "Only the extension may connect");
    return;
  }

  const sessions = new Map<string, AgentSession>();
  void getAvailableModels().then((available) => socket.send(JSON.stringify({ type: "hello", provider: provider.name, models: provider.models, available })));

  socket.on("message", async (raw) => {
    let message: ClientMessage;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (message.type === "toolResult") {
      for (const session of sessions.values()) session.handleToolResult(message);
      return;
    }
    if (message.type !== "run") return;

    const session = new AgentSession(socket, message);
    sessions.set(message.runId, session);
    const started = Date.now();
    try {
      await execute(session, message);
      console.log(`[run] ${message.trigger} done in ${Date.now() - started}ms`);
    } catch (error) {
      if (!(error instanceof RunCancelledError)) console.error("[run] failed", error);
      session.send({ type: "error", runId: message.runId, message: error instanceof Error ? error.message : "Agent failed" });
    } finally {
      sessions.delete(message.runId);
    }
  });

  socket.on("close", () => {
    for (const session of sessions.values()) session.close();
    sessions.clear();
  });
});

server.listen(PORT, () => {
  console.log(`browser-agent server on http://localhost:${PORT} (${provider.name}: fast=${provider.models.fast}, frontier=${provider.models.frontier})`);
  console.log(`demo site: http://localhost:${PORT}/demo/campus.html`);
});
