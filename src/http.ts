/**
 * Streamable HTTP transport (MCP spec 2025-11-25) — stateful sessions.
 *
 * Single MCP endpoint (/mcp) supporting POST, GET (server->client SSE) and
 * DELETE (session termination). One McpServer + transport per session, keyed
 * by the MCP-Session-Id header the transport issues at initialize.
 *
 * Security (per spec): Origin header validated, binds to localhost by default.
 */
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";
import { createServer, checkCardsBuilt } from "./server.js";
import { sourceFromEnv } from "./telemetry/index.js";
import { startAlertMonitor, type AlertMonitor } from "./alerts.js";
import { getStore, storeHealth } from "./store/index.js";

const source = sourceFromEnv(); // shared across sessions so the simulator clock is continuous

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? "127.0.0.1";
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

interface Session { transport: WebStandardStreamableHTTPServerTransport; monitor: AlertMonitor; lastSeen: number }
const sessions = new Map<string, Session>();

/**
 * Reap idle sessions.
 *
 * A client that closes its tab, loses the network, or crashes never sends DELETE, so
 * onsessionclosed never fires and that session's alert monitor keeps polling forever.
 * Over a long judging session those orphans accumulate, burning the inverter API's rate
 * limit and holding memory. Anything silent for SESSION_TTL_MS is closed.
 */
const SESSION_TTL_MS = Number(process.env.SESSION_TTL_MS ?? 30 * 60_000);
const REAP_EVERY_MS = 60_000;

function closeSession(id: string, reason: string): void {
  const s = sessions.get(id);
  if (!s) return;
  s.monitor.stop();
  sessions.delete(id);
  try { void s.transport.close?.(); } catch { /* already gone */ }
  console.log(`[session] closed ${id} (${reason}); ${sessions.size} open`);
}

const reaper = setInterval(() => {
  const cutoff = Date.now() - SESSION_TTL_MS;
  for (const [id, s] of sessions) if (s.lastSeen < cutoff) closeSession(id, "idle");
}, REAP_EVERY_MS);
reaper.unref?.();

function originAllowed(origin: string | undefined): boolean {
  if (!origin) return true; // non-browser clients omit Origin
  if (ALLOWED_ORIGINS.includes(origin)) return true;
  try {
    const { hostname } = new URL(origin);
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
  } catch {
    return false;
  }
}

async function newSession(): Promise<WebStandardStreamableHTTPServerTransport> {
  // TODO: derive userId from auth (OAuth token / Alexa account linking).
  const userId = process.env.DEMO_USER_ID ?? "demo-household";
  const server = createServer({ userId, source });
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (id) => {
      sessions.set(id, { transport, monitor: startAlertMonitor(server, source, userId), lastSeen: Date.now() });
      console.log(`[session] opened ${id}; ${sessions.size} open`);
    },
    onsessionclosed: (id) => closeSession(id, "client"),
  });
  await server.connect(transport);
  return transport;
}

const app = new Hono();

app.get("/healthz", async (c) => {
  const store = await storeHealth();
  return c.json({ ok: store.ok, sessions: sessions.size, telemetry: source.name, store }, store.ok ? 200 : 503);
});

app.all("/mcp", async (c) => {
  const req = c.req.raw;
  if (!originAllowed(req.headers.get("origin") ?? undefined)) {
    return c.json({ jsonrpc: "2.0", error: { code: -32000, message: "Forbidden origin" } }, 403);
  }

  const sessionId = req.headers.get("mcp-session-id");
  const existing = sessionId ? sessions.get(sessionId) : undefined;
  if (existing) existing.lastSeen = Date.now();
  let transport = existing?.transport;

  if (!transport) {
    if (sessionId) {
      // Unknown/expired session -> 404 so the client re-initializes (spec §Session Management).
      return c.json({ jsonrpc: "2.0", error: { code: -32001, message: "Session not found" } }, 404);
    }
    if (req.method !== "POST") {
      return c.json({ jsonrpc: "2.0", error: { code: -32000, message: "Missing MCP-Session-Id" } }, 400);
    }
    transport = await newSession(); // initialize request; transport validates it is one
  }

  return transport.handleRequest(req);
});

// A rejected promise anywhere must not take the server down mid-demo.
process.on("unhandledRejection", (reason) => console.error("[powerline] unhandled rejection:", reason));
process.on("uncaughtException", (err) => console.error("[powerline] uncaught exception:", err));

void checkCardsBuilt();
void storeHealth().then((h) => console.log(`Store: ${h.backend} — ${h.ok ? h.detail : `UNAVAILABLE: ${h.detail}`}`));
const server = serve({ fetch: app.fetch, port: PORT, hostname: HOST }, () => {
  console.log(`Powerline MCP endpoint: http://${HOST}:${PORT}/mcp  (telemetry: ${source.name}, store: ${getStore().name})`);
});

/** Stop timers and close sessions so Ctrl+C exits promptly and leaves nothing half-written. */
let shuttingDown = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (shuttingDown) process.exit(130);
    shuttingDown = true;
    console.log(`\n[powerline] ${signal} — closing ${sessions.size} session(s)…`);
    clearInterval(reaper);
    for (const id of [...sessions.keys()]) closeSession(id, "shutdown");
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3_000).unref?.();
  });
}
