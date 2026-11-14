import "dotenv/config";
import express from "express";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import type { ClientMessage, RunRequest, ServerMessage, Tier } from "../shared/protocol.js";
import { login, signOut } from "./auth/chatgpt.js";
import { defaultProviderId, describeProviders, forget, getProvider, keyFor, resolveProvider, wantModels } from "./agent/providers/index.js";
import type { AgentProvider } from "./agent/providers/types.js";
import { recallForRun } from "./agent/memory.js";
import { pickTier } from "./agent/router.js";
import { classifyItems } from "./agent/classify.js";
import { suggestFor } from "./agent/suggest.js";
import { AgentSession, RunCancelledError } from "./agent/session.js";
import { setKey } from "./keys.js";
import { audio } from "./audio.js";
import { detectInjection } from "./safety.js";

const PORT = Number(process.env.PORT ?? 8787);
const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const sockets = new Set<WebSocket>();
let signingIn = false;

const app = express();
app.use("/api/audio", audio);
app.use("/demo", express.static(path.join(rootDir, "demo-sites")));
app.get("/api/health", async (_req, res) => {
  res.json({ ok: true, defaultProvider: defaultProviderId(), providers: (await describeProviders()).map(({ id, ready }) => ({ id, ready })) });
});

const server = createServer(app);
const wss = new WebSocketServer({ server, path: "/agent" });

const sendTo = (socket: WebSocket, message: ServerMessage) => {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
};

async function broadcastProviders() {
  const message: ServerMessage = { type: "providers", providers: await describeProviders(), defaultProvider: defaultProviderId() };
  for (const socket of sockets) sendTo(socket, message);
}

async function execute(session: AgentSession, request: RunRequest, provider: AgentProvider) {
  const injection = detectInjection(request.page);
  if (injection) {
    console.warn(`[safety] injection blocked before any model call: "${injection}"`);
    session.send({ type: "blocked", runId: request.runId, reason: injection });
    session.send({ type: "done", runId: request.runId, reply: "This page contains text that tries to instruct me, so I didn't change anything." });
    return;
  }

  let tier: Tier = pickTier(request);
  session.tier = tier;
  const modelFor = (which: Tier) => request.models?.[which] || provider.models[which];
  const announce = () => session.send({ type: "tier", runId: request.runId, tier, model: modelFor(tier) });
  announce();
  let reply = await provider.run(session, tier, modelFor(tier), (usage) => session.reportUsage(usage, modelFor(tier)));

  if (tier === "fast" && request.routing === "auto" && !session.blockedReason && (session.escalation || session.struggled())) {
    session.progress(session.escalation ? `Switching to Pro: ${session.escalation}` : "That didn't land. Switching to Pro");
    console.log(`[route] escalated to frontier: ${session.escalation ?? "fast model struggled"}`);
    await session.undoAppliedChanges();
    session.escalation = null;
    tier = "frontier";
    session.tier = tier;
    announce();
    reply = await provider.run(session, tier, modelFor(tier), (usage) => session.reportUsage(usage, modelFor(tier)));
  }

  if (session.blockedReason) {
    console.warn(`[safety] injection blocked: "${session.blockedReason}"`);
    session.send({ type: "blocked", runId: request.runId, reason: session.blockedReason });
    reply = "This page contains text that tries to instruct me, so I didn't change anything.";
  }
  session.send({ type: "done", runId: request.runId, reply });
}

async function signIn(socket: WebSocket) {
  if (signingIn) return sendTo(socket, { type: "notice", level: "info", text: "Sign-in already in progress. Finish it in your browser." });
  signingIn = true;
  sendTo(socket, { type: "notice", level: "info", text: "Finish signing in to ChatGPT in the browser tab that just opened." });
  try {
    await login();
    forget("chatgpt-signin");
    await broadcastProviders();
  } catch (error) {
    sendTo(socket, { type: "notice", level: "error", text: `ChatGPT sign-in failed: ${error instanceof Error ? error.message : String(error)}` });
  } finally {
    signingIn = false;
  }
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

  sockets.add(socket);
  const sessions = new Map<string, AgentSession>();
  void describeProviders().then((providers) => sendTo(socket, { type: "providers", providers, defaultProvider: defaultProviderId() }));

  socket.on("message", async (raw) => {
    let message: ClientMessage;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (!message || typeof message !== "object") return;
    switch (message.type) {
      case "toolResult":
        for (const session of sessions.values()) session.handleToolResult(message);
        return;
      case "cancel":
        sessions.get(message.runId)?.close();
        sessions.delete(message.runId);
        console.log("[run] cancelled, replaced by a newer request");
        return;
      case "listModels":
        wantModels(message.provider);
        return void broadcastProviders();
      case "chatgptLogin":
        return void signIn(socket);
      case "classify": {
        const provider = resolveProvider(message.provider);
        const started = Date.now();
        const model = message.models?.fast || provider?.models.fast;
        const verdicts = provider ? await classifyItems(provider, message, (usage) => sendTo(socket, { type: "usage", usage, requestId: message.requestId, model: model ?? "" })).catch(() => null) : null;
        console.log(`[classify] ${message.items.length} items for "${message.match.slice(0, 60)}" in ${Date.now() - started}ms: ${verdicts ? verdicts.filter(Boolean).length : "failed"} matched`);
        return sendTo(socket, { type: "classified", requestId: message.requestId, verdicts });
      }
      case "suggest": {
        const provider = resolveProvider(message.provider);
        const suggestion = provider ? await suggestFor(provider, message, (usage) => sendTo(socket, { type: "usage", usage, requestId: message.requestId, model: message.models?.fast || provider.models.fast })).catch(() => null) : null;
        return sendTo(socket, { type: "suggestion", requestId: message.requestId, suggestion });
      }
      case "chatgptLogout":
        signOut();
        forget("chatgpt-signin");
        console.log("[auth] signed out of ChatGPT on this computer");
        await broadcastProviders();
        return sendTo(socket, { type: "notice", level: "info", text: "Signed out of ChatGPT on this computer. To fully revoke access, remove the app in your ChatGPT account settings." });
      case "setKey": {
        const name = keyFor(message.provider);
        const key = message.key?.trim() || null;
        if (!name) return sendTo(socket, { type: "notice", level: "error", text: "That provider does not use an API key." });
        if (key && (key.length > 4096 || /\s/.test(key))) return sendTo(socket, { type: "notice", level: "error", text: "Enter a valid API key." });
        if (key && key.length < 20) return sendTo(socket, { type: "notice", level: "error", text: "That doesn't look like a full API key." });
        setKey(name, key);
        forget(message.provider);
        console.log(`[keys] ${key ? "saved" : "removed"} key for ${message.provider}`);
        await broadcastProviders();
        if (!key && getProvider(message.provider)) sendTo(socket, { type: "notice", level: "error", text: `That key also comes from .env, so it is still active. Remove ${name} from .env to turn it off.` });
        return;
      }
      case "run":
        break;
      default:
        return;
    }

    const session = new AgentSession(socket, { ...message, profile: await recallForRun(message) });
    const provider = resolveProvider(message.provider);
    if (!provider) {
      session.send({ type: "error", runId: message.runId, message: "No AI provider is set up yet. Open settings to sign in with ChatGPT or add an API key." });
      return;
    }
    sessions.set(message.runId, session);
    const started = Date.now();
    try {
      await execute(session, message, provider);
      console.log(`[run] ${message.trigger} via ${provider.name} done in ${Date.now() - started}ms`);
    } catch (error) {
      if (session.cancelled) return;
      if (!(error instanceof RunCancelledError)) console.error("[run] failed", error instanceof Error ? error.name : "Unknown error");
      session.send({ type: "error", runId: message.runId, message: safeProviderError(error) });
    } finally {
      sessions.delete(message.runId);
    }
  });

  socket.on("close", () => {
    sockets.delete(socket);
    for (const session of sessions.values()) session.close();
    sessions.clear();
  });
});

server.listen(PORT, "localhost", () => {
  const active = defaultProviderId();
  console.log(`browser-agent server on http://localhost:${PORT}`);
  console.log(active ? `default provider: ${active}` : "no AI provider set up yet: open the extension settings to sign in with ChatGPT or add an API key");
  console.log(`demo site: http://localhost:${PORT}/demo/campus.html`);
});
