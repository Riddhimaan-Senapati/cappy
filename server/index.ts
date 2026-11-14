import "dotenv/config";
import express from "express";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import type { ClientMessage, ProviderSetup, RunRequest, Tier } from "../shared/protocol.js";
import { login } from "./auth/chatgpt.js";
import { setKey } from "./keys.js";
import { audio } from "./audio.js";
import { createProvider, providerKeys, providerOptions } from "./agent/providers/index.js";
import { pickTier } from "./agent/router.js";
import { AgentSession, RunCancelledError } from "./agent/session.js";
import { detectInjection } from "./safety.js";

const PORT = Number(process.env.PORT ?? 8787);
const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

let provider = initialProvider();
let signingIn = false;

function initialProvider() {
  try {
    return createProvider();
  } catch {
    const ready = providerOptions().find((entry) => entry.ready);
    return ready ? createProvider(ready.id) : undefined;
  }
}
const app = express();
app.use("/api/audio", audio);

app.use("/demo", express.static(path.join(rootDir, "demo-sites")));
app.get("/api/health", (_req, res) => {
  res.json({ ok: true, provider: provider?.name, models: provider?.models });
});

const server = createServer(app);
const wss = new WebSocketServer({ server, path: "/agent" });

async function execute(session: AgentSession, request: RunRequest, provider: ReturnType<typeof createProvider>) {
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

const clients = new Set<WebSocket>();
const modelLists = new WeakMap<NonNullable<typeof provider>, Promise<string[]>>();

function publishProviders(socket: WebSocket, available: string[] = []) {
  if (socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify({
    type: "hello",
    provider: provider?.name ?? "",
    models: provider?.models,
    available,
    providers: providerOptions(),
  }));
  const selected = provider;
  if (!selected || available.length) return;
  let models = modelLists.get(selected);
  if (!models) {
    models = Promise.resolve().then(() => selected.listModels?.() ?? []).then((ids) => [...new Set(ids)].sort()).catch(() => []);
    modelLists.set(selected, models);
  }
  void models.then((ids) => {
    if (ids.length && selected === provider) publishProviders(socket, ids);
  });
}

async function configureProvider(socket: WebSocket, message: ProviderSetup) {
  const result = { type: "providerSetupResult", id: message.id, error: undefined as string | undefined };
  try {
    if (!providerOptions().some(({ id }) => id === message.provider)) throw new Error("Unknown provider.");
    switch (message.action) {
      case "key": {
        const name = providerKeys.get(message.provider);
        const key = typeof message.key === "string" ? message.key.trim() : "";
        if (!name || !key || key.length > 4096 || /\s/.test(key)) throw new Error("Enter a valid API key.");
        setKey(name, key);
        break;
      }
      case "signin":
        if (message.provider !== "chatgpt-signin" || signingIn) throw new Error("ChatGPT sign-in is unavailable or already in progress.");
        signingIn = true;
        try {
          await login({ log: false });
        } catch {
          throw new Error("ChatGPT sign-in failed. Start it again from Settings.");
        } finally {
          signingIn = false;
        }
        break;
      case "select":
        break;
      default:
        throw new Error("Unknown setup action.");
    }
    provider = createProvider(message.provider);
    for (const client of clients) publishProviders(client);
  } catch (error) {
    result.error = message.action === "key" ? "Could not save the API key. Check the key and try again." : error instanceof Error ? error.message : "Provider setup failed.";
  }
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(result));
}

function safeProviderError(error: unknown): string {
  const message = error instanceof Error ? error.message : "Agent failed";
  const status = (error as { status?: unknown } | null)?.status;
  if (status === 401 || status === 403) return "The provider rejected the credentials or model access. Check provider setup.";
  return message;
}

wss.on("connection", (socket, request) => {
  if (!(request.headers.origin ?? "").startsWith("chrome-extension://")) {
    socket.close(1008, "Only the extension may connect");
    return;
  }

  const sessions = new Map<string, AgentSession>();
  clients.add(socket);
  publishProviders(socket);

  socket.on("message", async (raw) => {
    let message: ClientMessage;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (!message || typeof message !== "object") return;
    if (message.type === "providerSetup") return configureProvider(socket, message);
    if (message.type === "cancel") {
      sessions.get(message.runId)?.close();
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
      if (!provider) throw new Error("Choose a model provider in extension settings.");
      await execute(session, message, provider);
      console.log(`[run] ${message.trigger} done in ${Date.now() - started}ms`);
    } catch (error) {
      if (!(error instanceof RunCancelledError)) console.error("[run] failed", error instanceof Error ? error.name : "Unknown error");
      session.send({ type: "error", runId: message.runId, message: safeProviderError(error) });
    } finally {
      sessions.delete(message.runId);
    }
  });

  socket.on("close", () => {
    clients.delete(socket);
    for (const session of sessions.values()) session.close();
    sessions.clear();
  });
});

server.listen(PORT, "localhost", () => {
  console.log(`browser-agent server on http://localhost:${PORT} (${provider?.name ?? "setup required"})`);
  console.log(`demo site: http://localhost:${PORT}/demo/campus.html`);
});
