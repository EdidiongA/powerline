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
import { createServer } from "./server.js";
import { sourceFromEnv } from "./telemetry/index.js";
import { startAlertMonitor, type AlertMonitor } from "./alerts.js";

const source = sourceFromEnv(); // shared across sessions so the simulator clock is continuous

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? "127.0.0.1";
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const sessions = new Map<string, WebStandardStreamableHTTPServerTransport>();
const monitors = new Map<string, AlertMonitor>();

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
      sessions.set(id, transport);
      monitors.set(id, startAlertMonitor(server, source, userId));
      console.log(`[session] opened ${id}`);
    },
    onsessionclosed: (id) => {
      sessions.delete(id);
      monitors.get(id)?.stop();
      monitors.delete(id);
      console.log(`[session] closed ${id}`);
    },
  });
  await server.connect(transport);
  return transport;
}

const app = new Hono();

app.get("/healthz", (c) => c.json({ ok: true, sessions: sessions.size }));

app.all("/mcp", async (c) => {
  const req = c.req.raw;
  if (!originAllowed(req.headers.get("origin") ?? undefined)) {
    return c.json({ jsonrpc: "2.0", error: { code: -32000, message: "Forbidden origin" } }, 403);
  }

  const sessionId = req.headers.get("mcp-session-id");
  let transport = sessionId ? sessions.get(sessionId) : undefined;

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

serve({ fetch: app.fetch, port: PORT, hostname: HOST }, () => {
  console.log(`Powerline MCP endpoint: http://${HOST}:${PORT}/mcp  (telemetry: ${source.name})`);
});
