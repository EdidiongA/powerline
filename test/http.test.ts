/**
 * Transport-level tests against a real Powerline process: CORS preflight ordering,
 * auth and session responses, header exposure, and a shutdown that actually exits.
 *
 * Spawned with the current Node binary and tsx's CLI entry (not `npx`, which is a
 * .cmd on Windows and cannot be spawned by name).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { boot } from "./helpers/boot.js";

const PROTO = "2025-11-25";
const initBody = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: PROTO, capabilities: {}, clientInfo: { name: "t", version: "0" } } });
const jsonHeaders = { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": PROTO };

test("CORS preflight is answered before auth, only for allowed origins, and exposes the session header", async () => {
  const s = await boot({ API_TOKENS: "home:secret-token-1234", ALLOWED_ORIGINS: "https://host.example" });
  try {
    const ok = await fetch(`${s.url}/mcp`, { method: "OPTIONS", headers: { origin: "https://host.example", "access-control-request-method": "POST" } });
    assert.equal(ok.status, 204, "preflight carries no token and must still succeed");
    assert.equal(ok.headers.get("access-control-allow-origin"), "https://host.example");
    assert.match(ok.headers.get("access-control-expose-headers") ?? "", /Mcp-Session-Id/i);
    assert.match(ok.headers.get("access-control-allow-headers") ?? "", /Authorization/i);

    const evil = await fetch(`${s.url}/mcp`, { method: "OPTIONS", headers: { origin: "https://evil.example" } });
    assert.equal(evil.status, 403);
    assert.equal(evil.headers.get("access-control-allow-origin"), null);

    const noToken = await fetch(`${s.url}/mcp`, { method: "POST", headers: { ...jsonHeaders, origin: "https://host.example" }, body: initBody });
    assert.equal(noToken.status, 401);
    assert.match(noToken.headers.get("www-authenticate") ?? "", /Bearer/);
    assert.equal(noToken.headers.get("access-control-allow-origin"), "https://host.example", "a browser must be able to read the 401");

    const init = await fetch(`${s.url}/mcp`, { method: "POST", headers: { ...jsonHeaders, origin: "https://host.example", authorization: "Bearer secret-token-1234" }, body: initBody });
    assert.equal(init.status, 200);
    const sid = init.headers.get("mcp-session-id");
    assert.ok(sid, "session id issued");
    await init.text();

    const noSession = await fetch(`${s.url}/mcp`, { method: "GET", headers: { accept: "text/event-stream", "mcp-protocol-version": PROTO, authorization: "Bearer secret-token-1234" } });
    assert.equal(noSession.status, 400);
    const unknown = await fetch(`${s.url}/mcp`, { method: "GET", headers: { accept: "text/event-stream", "mcp-protocol-version": PROTO, "mcp-session-id": "not-a-session", authorization: "Bearer secret-token-1234" } });
    assert.equal(unknown.status, 404);

    const del = await fetch(`${s.url}/mcp`, { method: "DELETE", headers: { "mcp-session-id": sid!, "mcp-protocol-version": PROTO, authorization: "Bearer secret-token-1234" } });
    assert.ok(del.status < 300, `DELETE → ${del.status}`);
    const gone = await fetch(`${s.url}/mcp`, { method: "GET", headers: { accept: "text/event-stream", "mcp-protocol-version": PROTO, "mcp-session-id": sid!, authorization: "Bearer secret-token-1234" } });
    assert.equal(gone.status, 404, "closed session is forgotten");
  } finally {
    const { ms } = await s.stop();
    assert.ok(ms < 4_500, `shutdown took ${ms} ms — the forced-exit backstop is missing`);
  }
});

test("SIGTERM exits promptly even with a session and an open SSE stream", async () => {
  const s = await boot({});
  const init = await fetch(`${s.url}/mcp`, { method: "POST", headers: jsonHeaders, body: initBody });
  const sid = init.headers.get("mcp-session-id")!;
  await init.text();
  const ac = new AbortController();
  const stream = await fetch(`${s.url}/mcp`, { method: "GET", headers: { accept: "text/event-stream", "mcp-protocol-version": PROTO, "mcp-session-id": sid }, signal: ac.signal });
  assert.equal(stream.status, 200);
  const { code, ms } = await s.stop();
  ac.abort();
  assert.ok(ms < 4_500, `shutdown took ${ms} ms`);
  if (process.platform !== "win32") assert.equal(code, 0);
});

test("the front door at / describes the server without leaking secrets; /healthz reports the store", async () => {
  const s = await boot({ API_TOKENS: "home:super-secret-token-value" });
  try {
    const r = await fetch(`${s.url}/`);
    assert.equal(r.status, 200);
    const html = await r.text();
    assert.match(html, /Powerline/);
    assert.match(html, /\/mcp/);
    assert.match(html, /Authorization: Bearer/);
    assert.doesNotMatch(html, /super-secret-token-value/, "token leaked on the landing page");
    assert.doesNotMatch(html, /store\.json|\/tmp\/|[A-Z]:\\/, "filesystem path leaked on the landing page");
    const h = await (await fetch(`${s.url}/healthz`)).json() as { ok: boolean; store: { backend: string } };
    assert.equal(h.ok, true);
    assert.equal(h.store.backend, "disk");
  } finally { await s.stop(); }
});

test("oversized bodies are refused and the session ceiling returns 503 with Retry-After", async () => {
  const s = await boot({ MAX_SESSIONS: "1" });
  try {
    // fetch() will not send a false Content-Length, so speak HTTP directly for the oversized case.
    const { request } = await import("node:http");
    const status = await new Promise<number>((res, rej) => {
      const rq = request(`${s.url}/mcp`, { method: "POST", headers: { ...jsonHeaders, "content-length": "5000000" } }, (r) => { res(r.statusCode ?? 0); r.resume(); });
      rq.on("error", rej); rq.write(initBody); // never finishes the body; the server must answer from the header alone
    });
    assert.equal(status, 413);
    const first = await fetch(`${s.url}/mcp`, { method: "POST", headers: jsonHeaders, body: initBody });
    assert.equal(first.status, 200); await first.text();
    const second = await fetch(`${s.url}/mcp`, { method: "POST", headers: jsonHeaders, body: initBody });
    assert.equal(second.status, 503);
    assert.equal(second.headers.get("retry-after"), "60");
  } finally { await s.stop(); }
});

test("the simulated host is served, and /demo/llm answers in rules mode with the same auth as /mcp", async () => {
  const s = await boot({ API_TOKENS: "home:demo-token-0123456789", DEMO_LLM_PER_MINUTE: "4" });
  try {
    const page = await fetch(`${s.url}/demo`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Simulated Alexa\+ host/);
    const health = await (await fetch(`${s.url}/healthz`)).json() as { llm: boolean; version: string };
    assert.equal(health.llm, false); assert.equal(typeof health.version, "string");

    const noAuth = await fetch(`${s.url}/demo/llm`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(noAuth.status, 401);
    const H = { "content-type": "application/json", authorization: "Bearer demo-token-0123456789" };
    const bad = await fetch(`${s.url}/demo/llm`, { method: "POST", headers: H, body: "not json" });
    assert.equal(bad.status, 400);
    const empty = await fetch(`${s.url}/demo/llm`, { method: "POST", headers: H, body: JSON.stringify({ messages: [] }) });
    assert.equal(empty.status, 400);
    const ok = await fetch(`${s.url}/demo/llm`, { method: "POST", headers: H, body: JSON.stringify({ messages: [{ role: "user", content: [{ text: "How's the power?" }] }], tools: [{ name: "power_status", inputSchema: {} }] }) });
    assert.equal(ok.status, 200);
    const reply = await ok.json() as { mode: string; toolCalls: Array<{ name: string }> };
    assert.equal(reply.mode, "rules"); assert.equal(reply.toolCalls[0]?.name, "power_status");
    // After a tool result, rules mode speaks the result.
    const spoken = await (await fetch(`${s.url}/demo/llm`, { method: "POST", headers: H, body: JSON.stringify({ messages: [
      { role: "user", content: [{ text: "How's the power?" }] },
      { role: "assistant", content: [{ toolUse: { toolUseId: "1", name: "power_status", input: {} } }] },
      { role: "user", content: [{ toolResult: { toolUseId: "1", content: [{ text: "Solar 0 W, battery 55%." }] } }] },
    ], tools: [] }) })).json() as { text: string; toolCalls: unknown[] };
    assert.equal(spoken.text, "Solar 0 W, battery 55%."); assert.deepEqual(spoken.toolCalls, []);
    // Rate limit: four per minute in this boot (every authenticated POST counts), the fifth is refused.
    const fourth = await fetch(`${s.url}/demo/llm`, { method: "POST", headers: H, body: JSON.stringify({ messages: [{ role: "user", content: [{ text: "hi" }] }] }) });
    assert.equal(fourth.status, 429); assert.equal(fourth.headers.get("retry-after"), "60");
  } finally { await s.stop(); }
});
