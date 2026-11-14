import "dotenv/config";
import express from "express";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import type { ClientMessage } from "../shared/protocol.js";
import { createProvider } from "./agent/providers/index.js";
import { AgentSession, RunCancelledError } from "./agent/session.js";

const PORT = Number(process.env.PORT ?? 8787);
const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const provider = createProvider();
const app = express();

app.use("/demo", express.static(path.join(rootDir, "demo-sites")));
app.get("/api/health", (_req, res) => {
  res.json({ ok: true, provider: provider.name, model: provider.model });
});

const server = createServer(app);
const wss = new WebSocketServer({ server, path: "/agent" });

wss.on("connection", (socket, request) => {
  if (!(request.headers.origin ?? "").startsWith("chrome-extension://")) {
    socket.close(1008, "Only the extension may connect");
    return;
  }

  const sessions = new Map<string, AgentSession>();
  socket.send(JSON.stringify({ type: "hello", provider: provider.name, model: provider.model }));

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
      const reply = await provider.run(session);
      if (session.blockedReason) {
        console.warn(`[safety] injection blocked: "${session.blockedReason}"`);
        session.warn(`Blocked: this page tried to give the agent instructions ("${session.blockedReason.slice(0, 80)}")`);
        session.send({ type: "done", runId: message.runId, reply: "This page contains text that tries to instruct me, so I didn't change anything." });
      } else {
        session.send({ type: "done", runId: message.runId, reply });
      }
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
  console.log(`browser-agent server on http://localhost:${PORT} (${provider.name}: ${provider.model})`);
  console.log(`demo site: http://localhost:${PORT}/demo/campus.html`);
});
