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
import { Authenticator } from "./auth.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";
import { createServer, checkCardsBuilt, VERSION } from "./server.js";
import { sourceFromEnv } from "./telemetry/index.js";
import { startAlertMonitor, type AlertMonitor } from "./alerts.js";
import { getStore, storeHealth } from "./store/index.js";
import { cardHtml } from "./views.js";
import { checkMessages, llmEnabled, nextTurn, type ToolSpec } from "./demo/llm.js";
import { OAuthServer, consentPage } from "./oauth.js";
import { startHistoryRecorder } from "./recorder.js";
import { seedHousehold } from "./seed.js";

const source = sourceFromEnv(); // shared across sessions so the simulator clock is continuous

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? "127.0.0.1";
/** Bearer tokens identify the household (see auth.ts). No tokens configured = open, demo household. */
const auth = new Authenticator();
/** OAuth 2.1 account linking (see oauth.ts). Only meaningful when there are households to link. */
const oauth = new OAuthServer((household, secret) => auth.verify(household, secret));
auth.oauthLookup = (t) => oauth.householdFor(t);
/**
 * The public origin, for OAuth metadata and redirects. Behind a load balancer / a tunnel the process sees
 * plain HTTP on an internal host, so the forwarded headers (or PUBLIC_URL) decide what clients are told.
 */
const PUBLIC_URL = process.env.PUBLIC_URL?.replace(/\/$/, "");
const originOf = (url: string, h?: { get(name: string): string | undefined }) => {
  if (PUBLIC_URL) return PUBLIC_URL;
  const u = new URL(url);
  const proto = h?.get("x-forwarded-proto")?.split(",")[0].trim();
  const host = h?.get("x-forwarded-host")?.split(",")[0].trim();
  if (proto === "https" || proto === "http") u.protocol = `${proto}:`;
  if (host && /^[A-Za-z0-9.\-\[\]:]+$/.test(host)) { u.port = ""; u.host = host; } // a port-less forwarded host must not inherit the internal port
  return u.origin;
};
const challenge = (origin: string, presented?: string) => `Bearer realm="powerline"${presented ? `, error="invalid_token", error_description="The token is unknown or expired"` : ""}, resource_metadata="${origin}/.well-known/oauth-protected-resource"`;
/** Read a body with a hard byte ceiling, whatever Content-Length claims (chunked bodies have none). */
async function boundedText(req: Request, max: number): Promise<string | null> {
  if (Number(req.headers.get("content-length") ?? 0) > max) return null;
  const reader = req.body?.getReader(); if (!reader) return "";
  const chunks: Uint8Array[] = []; let total = 0;
  for (;;) { const { done, value } = await reader.read(); if (done) break; total += value.byteLength; if (total > max) { await reader.cancel().catch(() => {}); return null; } chunks.push(value); }
  return Buffer.concat(chunks).toString("utf8");
}
/** Fixed-window counter for unauthenticated endpoints that must not be hammered. */
const counters = new Map<string, number[]>();
function overLimit(key: string, max: number, windowMs = 60_000): boolean {
  const now = Date.now(); const hits = (counters.get(key) ?? []).filter((t) => now - t < windowMs);
  hits.push(now); counters.set(key, hits);
  if (counters.size > 10_000) counters.clear(); // never let the table itself become the problem
  return hits.length > max;
}

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

interface Session { transport: WebStandardStreamableHTTPServerTransport; monitor: AlertMonitor; lastSeen: number; householdId: string }
const sessions = new Map<string, Session>();

/**
 * Reap idle sessions.
 *
 * A client that closes its tab, loses the network, or crashes never sends DELETE, so
 * onsessionclosed never fires and that session's alert monitor keeps polling forever.
 * Over a long judging session those orphans accumulate, burning the inverter API's rate
 * limit and holding memory. Anything silent for SESSION_TTL_MS is closed.
 *
 * The default is generous (6 h) on purpose: a household that armed a plan at 09:00 and
 * said nothing since must still get its 15:00 reminder, and thanks to CachedSource an
 * idle session costs one timer and a little memory, not upstream API calls.
 */
const SESSION_TTL_MS = Number(process.env.SESSION_TTL_MS ?? 6 * 3_600_000);
const REAP_EVERY_MS = 60_000;
/** Ceiling on open sessions and on a request body: an open (token-less) endpoint must not be a memory sink. */
const MAX_SESSIONS = Number(process.env.MAX_SESSIONS ?? 500);
const MAX_BODY_BYTES = 1_000_000;

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

function originAllowed(origin: string | undefined, self?: string): boolean {
  if (!origin) return true; // non-browser clients omit Origin
  if (self && origin === self) return true; // the server's own pages (/demo) are always allowed to talk to it
  if (ALLOWED_ORIGINS.includes(origin)) return true;
  try {
    const { hostname } = new URL(origin);
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
  } catch {
    return false;
  }
}

async function newSession(householdId: string): Promise<WebStandardStreamableHTTPServerTransport> {
  const server = createServer({ userId: householdId, source });
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (id) => {
      sessions.set(id, { transport, monitor: startAlertMonitor(server, source, householdId), lastSeen: Date.now(), householdId });
      console.log(`[session] opened ${id} for household "${householdId}"; ${sessions.size} open`);
    },
    onsessionclosed: (id) => closeSession(id, "client"),
  });
  await server.connect(transport);
  return transport;
}

const app = new Hono();

/**
 * A human-readable front door. Anyone who opens the server's address in a browser —
 * a judge, a teammate — sees what this is, whether it is healthy, and how to connect,
 * instead of a 404. No secrets are shown; auth mode is described, tokens never are.
 */
app.get("/", async (c) => {
  const store = await storeHealth();
  const e = (v: unknown) => String(v).replace(/[<&>"]/g, (ch) => ({ "<": "&lt;", "&": "&amp;", ">": "&gt;", '"': "&quot;" }[ch]!));
  const endpoint = `${originOf(c.req.url, { get: (n) => c.req.header(n) })}/mcp`; // the public origin, not the task's
  const row = (k: string, v: string, ok = true) => `<tr><th>${e(k)}</th><td class="${ok ? "ok" : "bad"}">${e(v)}</td></tr>`;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Powerline ${e(VERSION)}</title>
<style>
:root{--ink:#16202a;--ink2:#47566a;--ink3:#66788c;--charge:#1e9e5a;--alarm:#c8452f;--rule:rgba(22,32,42,.14);--field:rgba(22,32,42,.05)}
@media(prefers-color-scheme:dark){:root{--ink:#e7edf4;--ink2:#9fb0c4;--ink3:#98a9bd;--rule:rgba(231,237,244,.16);--field:rgba(231,237,244,.06)}body{background:#0f171f}}
body{margin:0;padding:40px 20px;font:15px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:var(--ink);font-variant-numeric:tabular-nums}
main{max-width:640px;margin:0 auto}h1{font-size:26px;margin:0 0 4px;letter-spacing:-.02em}h1 small{font-size:13px;color:var(--ink3);font-weight:400;margin-left:8px}
p.lead{color:var(--ink2);margin:0 0 24px}table{border-collapse:collapse;width:100%;margin:0 0 26px}th,td{text-align:left;padding:8px 10px;border-top:1px solid var(--rule);vertical-align:top}
th{width:34%;font-weight:500;color:var(--ink3)}tr:last-child td,tr:last-child th{border-bottom:1px solid var(--rule)}td.ok{color:var(--ink)}td.bad{color:var(--alarm);font-weight:600}
code{background:var(--field);padding:2px 6px;border-radius:3px;font-size:13px}ol{padding-left:22px;color:var(--ink2)}li{margin:6px 0}li b{color:var(--ink);font-weight:500}
a{color:var(--charge)}footer{margin-top:28px;font-size:12.5px;color:var(--ink3)}
</style></head><body><main>
<h1>Powerline<small>v${e(VERSION)}</small></h1>
<p class="lead">Home power copilot — an MCP server over Streamable HTTP with interactive cards.</p>
<p><a href="/demo" style="display:inline-block;background:var(--charge);color:#fff;text-decoration:none;font-weight:600;padding:10px 16px;border-radius:999px">Open the simulated Alexa+ host →</a> <span style="color:var(--ink3);font-size:13px;margin-left:8px">talk to it in this browser — cards, reminders, voice</span></p>
<table>
${row("MCP endpoint", endpoint)}
${row("Protocol", "MCP 2025-11-25 · Streamable HTTP · MCP Apps")}
${row("Telemetry", source.name)}
${row("Store", store.ok ? (store.backend === "disk" ? `disk — ${/\((\d+ households?)\)/.exec(store.detail)?.[1] ?? "ok"}` : `${store.backend} — ${store.detail}`) : `${store.backend} — UNAVAILABLE`, store.ok)}
${row("Auth", auth.describe())}
${row("Open sessions", String(sessions.size))}
</table>
<ol>
<li><b>Or any MCP Apps host</b> (e.g. MCPJam Inspector: <code>npx @mcpjam/inspector@latest</code>) → Add server → HTTP → <code>${e(endpoint)}</code>${auth.required ? " with header <code>Authorization: Bearer &lt;token&gt;</code>" : ""}.</li>
<li>Say <b>“Set up my solar: 4.5 kW array, 10 kWh battery, 5 kW inverter, 20% reserve”</b>, then <b>“How's the power?”</b> for the dashboard card.</li>
<li><b>“Plan my power for today”</b> opens the planner; <b>Arm plan</b> makes Powerline push reminders on its own.</li>
</ol>
<footer>Health: <a href="/healthz">/healthz</a> · Source: <a href="https://github.com/EdidiongA/powerline">github.com/EdidiongA/powerline</a> · MIT</footer>
</main></body></html>`;
  return c.html(html, store.ok ? 200 : 503);
});

// ---- OAuth 2.1: discovery, registration, consent, token (active when auth is configured) ----
const oauthOff = (c: { json: (b: unknown, s: 404) => Response }) => c.json({ error: "oauth_disabled", error_description: "This server runs open; set API_TOKENS to enable account linking." }, 404);
app.get("/.well-known/oauth-protected-resource", (c) => auth.required ? withCors(c.json(oauth.protectedResourceMetadata(originOf(c.req.url, { get: (n) => c.req.header(n) }))), c.req.header("origin") ?? null) : oauthOff(c));
app.get("/.well-known/oauth-protected-resource/mcp", (c) => auth.required ? withCors(c.json(oauth.protectedResourceMetadata(originOf(c.req.url, { get: (n) => c.req.header(n) }))), c.req.header("origin") ?? null) : oauthOff(c));
app.get("/.well-known/oauth-authorization-server", (c) => auth.required ? withCors(c.json(oauth.authorizationServerMetadata(originOf(c.req.url, { get: (n) => c.req.header(n) }))), c.req.header("origin") ?? null) : oauthOff(c));
app.options("/oauth/*", (c) => withCors(new Response(null, { status: 204 }), c.req.header("origin") ?? null));
app.options("/.well-known/*", (c) => withCors(new Response(null, { status: 204 }), c.req.header("origin") ?? null));
app.post("/oauth/register", async (c) => {
  if (!auth.required) return oauthOff(c);
  const origin = c.req.header("origin") ?? null;
  if (overLimit("register", 60)) return withCors(c.json({ error: "temporarily_unavailable", error_description: "Too many registrations; try again in a minute" }, 429, { "Retry-After": "60" }), origin);
  const raw = await boundedText(c.req.raw, 16_000);
  if (raw === null) return withCors(c.json({ error: "invalid_client_metadata", error_description: "Request body too large" }, 413), origin);
  let body: unknown; try { body = JSON.parse(raw); } catch { body = {}; }
  const r = oauth.register(body);
  return r.ok ? withCors(c.json(r.client, 201), origin) : withCors(c.json({ error: r.error, error_description: r.description }, 400), origin);
});
app.get("/oauth/authorize", (c) => {
  if (!auth.required) return oauthOff(c);
  const q = new URL(c.req.url).searchParams;
  const v = oauth.checkAuthorizeRequest(q);
  if (!v.ok && v.redirectTo) return c.redirect(v.redirectTo, 302);
  if (!v.ok) return c.html(`<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;padding:24px"><h2>Cannot link</h2><p>${v.message.replace(/[<&>]/g, "")}</p></body>`, v.status as 400);
  return c.html(consentPage({ clientName: v.client.name, clientId: v.client.clientId, redirectUri: v.redirectUri, challenge: v.challenge, state: v.state }), 200, CONSENT_HEADERS);
});
const CONSENT_HEADERS = { "Cache-Control": "no-store", "X-Frame-Options": "DENY", "Content-Security-Policy": "frame-ancestors 'none'; default-src 'none'; style-src 'unsafe-inline'; form-action 'self'", "Referrer-Policy": "no-referrer" };
app.post("/oauth/authorize", async (c) => {
  if (!auth.required) return oauthOff(c);
  if (overLimit("consent", 120)) return c.html("<!doctype html><meta charset=\"utf-8\"><body style=\"font-family:system-ui;padding:24px\"><h2>Slow down</h2><p>Too many link attempts; try again in a minute.</p></body>", 429, { "Retry-After": "60" });
  const raw = await boundedText(c.req.raw, 16_000);
  let f: Record<string, unknown> = {};
  if (raw !== null && (c.req.header("content-type") ?? "").includes("application/x-www-form-urlencoded")) f = Object.fromEntries(new URLSearchParams(raw));
  const s = (k: string, max = 2048) => (typeof f[k] === "string" ? (f[k] as string).slice(0, max) : "");
  const fields = { clientId: s("client_id"), redirectUri: s("redirect_uri"), challenge: s("code_challenge"), state: s("state", 4096) || null, householdId: s("household").trim(), secret: s("secret") };
  const v = oauth.checkAuthorizeRequest(new URLSearchParams({ client_id: fields.clientId, redirect_uri: fields.redirectUri, response_type: "code", code_challenge: fields.challenge }));
  if (!v.ok) return c.html("<!doctype html><meta charset=\"utf-8\"><body style=\"font-family:system-ui;padding:24px\"><h2>Cannot link</h2><p>The request is no longer valid. Start again from the host.</p></body>", 400);
  const locked = oauth.lockedOut(fields.householdId);
  const to = locked ? null : oauth.grant(fields);
  if (!to) return c.html(consentPage({ clientName: v.client.name, clientId: fields.clientId, redirectUri: fields.redirectUri, challenge: fields.challenge, state: fields.state, error: locked ? "Too many attempts for that household. Try again in ten minutes." : "That household and secret do not match." }), locked ? 429 : 401, CONSENT_HEADERS);
  return c.redirect(to, 302);
});
app.post("/oauth/token", async (c) => {
  if (!auth.required) return oauthOff(c);
  const origin = c.req.header("origin") ?? null;
  // RFC 6749 says form-encoded; some hosts post JSON anyway. Accept both.
  const raw = await boundedText(c.req.raw, 16_000);
  if (raw === null) return withCors(c.json({ error: "invalid_request", error_description: "Request body too large" }, 413), origin);
  let form: URLSearchParams;
  if ((c.req.header("content-type") ?? "").includes("application/json")) {
    try { const j = JSON.parse(raw); form = new URLSearchParams(Object.entries(j && typeof j === "object" ? j : {}).filter((e): e is [string, string] => typeof e[1] === "string")); } catch { form = new URLSearchParams(); }
  } else form = new URLSearchParams(raw);
  const r = oauth.token(form);
  const headers = { "Cache-Control": "no-store", Pragma: "no-cache" };
  return r.ok ? withCors(c.json(r.body, 200, headers), origin) : withCors(c.json({ error: r.error, error_description: r.description }, 400, headers), origin);
});

app.get("/healthz", async (c) => {
  const store = await storeHealth();
  const publicStore = { ...store, detail: store.detail.replace(/\/[^\s(]+store\.json/, "store.json") }; // no filesystem paths on a public endpoint
  return c.json({ ok: store.ok, sessions: sessions.size, telemetry: source.name, store: publicStore, llm: llmEnabled, version: VERSION, auth: auth.required ? "token-or-oauth" : "open", oauth: auth.required ? oauth.stats : null }, store.ok ? 200 : 503);
});

/**
 * The simulated Alexa+ host (src/ui/demo.html): a complete MCP Apps host in one page, served
 * by the same process. The page is public (it holds no secrets); everything it does goes
 * through /mcp and /demo/llm, which carry the same auth as the MCP endpoint.
 */
app.get("/demo", async (c) => c.html(await cardHtml("demo.html")));

const LLM_RATE = { windowMs: 60_000, max: Number(process.env.DEMO_LLM_PER_MINUTE ?? 60) };
let llmCalls: number[] = [];
app.post("/demo/llm", async (c) => {
  const origin = c.req.header("origin") ?? null;
  if (!originAllowed(origin ?? undefined, originOf(c.req.url, { get: (n) => c.req.header(n) }))) return c.json({ error: "Forbidden origin" }, 403);
  if (!auth.authenticate(c.req.header("authorization"))) return withCors(c.json({ error: "Unauthorized" }, 401, { "WWW-Authenticate": challenge(originOf(c.req.url, { get: (n) => c.req.header(n) }), c.req.header("authorization")) }), origin);
  if (Number(c.req.header("content-length") ?? 0) > 200_000) return withCors(c.json({ error: "Request body too large" }, 413), origin);
  const now = Date.now(); llmCalls = llmCalls.filter((t) => now - t < LLM_RATE.windowMs);
  if (llmCalls.length >= LLM_RATE.max) return withCors(c.json({ error: "Too many requests; try again in a minute" }, 429, { "Retry-After": "60" }), origin);
  llmCalls.push(now);
  let body: { messages?: unknown; tools?: unknown };
  try { body = await c.req.json(); } catch { return withCors(c.json({ error: "Body must be JSON" }, 400), origin); }
  const messages = checkMessages(body.messages);
  if (typeof messages === "string") return withCors(c.json({ error: messages }, 400), origin);
  const tools = (Array.isArray(body.tools) ? body.tools : []).filter((t): t is ToolSpec => !!t && typeof (t as ToolSpec).name === "string").slice(0, 40);
  try {
    return withCors(c.json(await nextTurn(messages, tools)), origin);
  } catch (e) {
    // Bedrock down or throttled: tell the page plainly; it shows the message instead of hanging.
    const reason = (e as Error).message;
    console.error(`[demo] model step failed: ${reason}`);
    return withCors(c.json({ error: `The model is unavailable right now (${reason.slice(0, 120)}). Tool calls still work; try a direct phrasing like "how's the power?".` }, 503), origin);
  }
});

/**
 * CORS for browser-based hosts. Only origins that pass originAllowed() get the headers, so
 * this widens nothing: a disallowed origin is still refused. `Mcp-Session-Id` must be
 * exposed or a browser client can never read the session it was given.
 */
const CORS_HEADERS = {
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, Accept, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID",
  "Access-Control-Expose-Headers": "Mcp-Session-Id, Mcp-Protocol-Version",
  "Access-Control-Max-Age": "600",
};
function withCors(res: Response, origin: string | null): Response {
  if (!origin || !originAllowed(origin)) return res;
  const out = new Response(res.body, res);
  out.headers.set("Access-Control-Allow-Origin", origin);
  out.headers.set("Vary", "Origin");
  for (const [k, v] of Object.entries(CORS_HEADERS)) out.headers.set(k, v);
  return out;
}

app.options("/mcp", (c) => {
  const origin = c.req.header("origin") ?? null;
  // A preflight carries no credentials by design; it must succeed before auth is even attempted.
  if (origin && !originAllowed(origin)) return c.body(null, 403);
  return withCors(new Response(null, { status: 204 }), origin);
});

app.all("/mcp", async (c) => {
  const req = c.req.raw;
  const origin = req.headers.get("origin");
  const principal = auth.authenticate(req.headers.get("authorization"));
  if (!originAllowed(origin ?? undefined, originOf(req.url, { get: (n) => req.headers.get(n) ?? undefined }))) {
    return c.json({ jsonrpc: "2.0", error: { code: -32000, message: "Forbidden origin" } }, 403);
  }
  if (!principal) {
    return withCors(c.json({ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized" } }, 401, { "WWW-Authenticate": challenge(originOf(c.req.url, { get: (n) => c.req.header(n) }), req.headers.get("authorization") ?? undefined) }), origin);
  }

  if (Number(req.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) {
    return withCors(c.json({ jsonrpc: "2.0", error: { code: -32000, message: "Request body too large" } }, 413), origin);
  }
  const sessionId = req.headers.get("mcp-session-id");
  const existing = sessionId ? sessions.get(sessionId) : undefined;
  // A session belongs to the household whose token opened it. A different household's
  // token must not be able to attach to it, even by guessing the session id.
  if (existing && existing.householdId !== principal.householdId) {
    return withCors(c.json({ jsonrpc: "2.0", error: { code: -32001, message: "Session not found" } }, 404), origin);
  }
  if (existing) existing.lastSeen = Date.now();
  let transport = existing?.transport;

  if (!transport) {
    if (sessionId) {
      // Unknown/expired session -> 404 so the client re-initializes (spec §Session Management).
      return withCors(c.json({ jsonrpc: "2.0", error: { code: -32001, message: "Session not found" } }, 404), origin);
    }
    if (req.method !== "POST") {
      return withCors(c.json({ jsonrpc: "2.0", error: { code: -32000, message: "Missing MCP-Session-Id" } }, 400), origin);
    }
    if (sessions.size >= MAX_SESSIONS) {
      return withCors(c.json({ jsonrpc: "2.0", error: { code: -32000, message: "Too many open sessions; try again shortly" } }, 503, { "Retry-After": "60" }), origin);
    }
    transport = await newSession(principal.householdId); // initialize request; transport validates it is one
  }

  // The Content-Length check above is advisory; a chunked body has none. Read with a hard ceiling.
  let bounded = req;
  if (req.method === "POST") {
    const text = await boundedText(req, MAX_BODY_BYTES);
    if (text === null) return withCors(c.json({ jsonrpc: "2.0", error: { code: -32000, message: "Request body too large" } }, 413), origin);
    bounded = new Request(req.url, { method: req.method, headers: req.headers, body: text });
  }
  return withCors(await transport.handleRequest(bounded), origin);
});

// A rejected promise anywhere must not take the server down mid-demo.
process.on("unhandledRejection", (reason) => console.error("[powerline] unhandled rejection:", reason));
process.on("uncaughtException", (err) => console.error("[powerline] uncaught exception:", err));

void checkCardsBuilt();
void storeHealth().then((h) => console.log(`Store: ${h.backend} — ${h.ok ? h.detail : `UNAVAILABLE: ${h.detail}`}`));

// History accumulates whether or not anyone is connected (one reading an hour per household).
// With simulated telemetry, SEED_HISTORY_DAYS=7 gives a household that has no readings yet a
// week of plausible history ending where the simulated clock starts, so reports and learning
// are demonstrable from the first minute of a fresh deployment.
const envNum = (name: string, dflt: number) => { const n = Number(process.env[name]); return process.env[name]?.trim() && Number.isFinite(n) && n > 0 ? n : dflt; };
const seedDays = Math.min(60, envNum("SEED_HISTORY_DAYS", 0));
const seeded: Promise<unknown> = source.name === "simulated" && seedDays > 0
  ? Promise.all(auth.householdIds.map((id) => {
      const end = process.env.SIM_CLOCK_START && !Number.isNaN(Date.parse(process.env.SIM_CLOCK_START)) ? process.env.SIM_CLOCK_START : new Date().toISOString();
      return seedHousehold(id, seedDays, end, { arrayKw: envNum("SIM_ARRAY_KW", 4.5), batteryKwh: envNum("SIM_BATTERY_KWH", 10), onlyIfEmpty: true })
        .then((n) => n && console.log(`[history] seeded ${n} hourly readings for "${id}"`))
        .catch((e) => console.error(`[history] seed failed for "${id}": ${(e as Error).message}`));
    }))
  : Promise.resolve();
// The recorder starts once seeding has settled, so its first sample can never pre-empt the seed's "no readings yet" check.
let recorder = { stop: () => {} };
void seeded.then(() => { recorder = startHistoryRecorder(source, () => auth.householdIds, envNum("HISTORY_INTERVAL_MS", 30_000)); });
const server = serve({ fetch: app.fetch, port: PORT, hostname: HOST }, () => {
  console.log(`Powerline MCP endpoint: http://${HOST}:${PORT}/mcp  (telemetry: ${source.name}, store: ${getStore().name}, auth: ${auth.describe()})`);
});

/** Stop timers and close sessions so Ctrl+C exits promptly and leaves nothing half-written. */
let shuttingDown = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (shuttingDown) process.exit(130);
    shuttingDown = true;
    console.log(`\n[powerline] ${signal} — closing ${sessions.size} session(s)…`);
    clearInterval(reaper); recorder.stop();
    for (const id of [...sessions.keys()]) closeSession(id, "shutdown");
    server.close(() => process.exit(0));
    // close() waits for keep-alive and SSE connections to end on their own; a host that keeps
    // its GET stream open would otherwise hold the port until the backstop fires.
    (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
    // Deliberately NOT unref'd: this is the backstop that guarantees the port is released
    // even if a connection or an in-flight retry refuses to settle. (Regressed once; keep it.)
    setTimeout(() => { console.error("[powerline] forced exit after 3 s"); process.exit(0); }, 3_000);
  });
}
