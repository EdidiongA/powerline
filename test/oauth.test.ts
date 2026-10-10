/**
 * Account linking, end to end, with the official MCP client doing the OAuth 2.1 flow against a
 * real Powerline process: 401 with resource metadata → discovery → dynamic registration →
 * consent page (household + secret) → code → PKCE token exchange → authenticated session bound
 * to that household → refresh rotation. Plus the negative cases: wrong secret, wrong verifier,
 * code reuse, unregistered redirect URI, open server.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Client, StreamableHTTPClientTransport, UnauthorizedError, type OAuthClientProvider } from "@modelcontextprotocol/client";
import { boot } from "./helpers/boot.js";

/** A provider that "opens the browser" by submitting the consent form itself. */
function makeProvider(household: string, secret: string) {
  let info: Record<string, unknown> | undefined;
  let tokens: Record<string, unknown> | undefined;
  let verifier = "";
  let lastAuthUrl: URL | null = null;
  const provider: OAuthClientProvider = {
    get redirectUrl() { return "http://127.0.0.1:9/callback"; },
    get clientMetadata() { return { client_name: "Powerline test host", redirect_uris: ["http://127.0.0.1:9/callback"], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }; },
    clientInformation: () => info as never,
    saveClientInformation: (ci) => { info = ci as never; },
    tokens: () => tokens as never,
    saveTokens: (t) => { tokens = t as never; },
    redirectToAuthorization: (url) => { lastAuthUrl = url; },
    saveCodeVerifier: (v) => { verifier = v; },
    codeVerifier: () => verifier,
  };
  /** Submit the consent form like a person would; return the redirect's code. */
  const consent = async (h = household, s = secret) => {
    assert.ok(lastAuthUrl, "the client should have asked to open the authorization URL");
    const page = await fetch(lastAuthUrl!);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /Link Powerline to Powerline test host/);
    const q = lastAuthUrl!.searchParams;
    const res = await fetch(`${lastAuthUrl!.origin}/oauth/authorize`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: q.get("client_id")!, redirect_uri: q.get("redirect_uri")!, code_challenge: q.get("code_challenge")!, state: q.get("state") ?? "", household: h, secret: s }) });
    return res;
  };
  return { provider, consent, get tokens() { return tokens; }, get info() { return info; }, get authUrl() { return lastAuthUrl; } };
}

test("a host links a household through OAuth 2.1 with PKCE, then talks to it; refresh rotates", async () => {
  const s = await boot({ API_TOKENS: "lagos:lagos-secret-abcdef12,office:office-secret-abcdef12" });
  try {
    // Discovery documents exist and point at this server.
    const prm = await (await fetch(`${s.url}/.well-known/oauth-protected-resource`)).json() as { resource: string; authorization_servers: string[] };
    assert.equal(prm.resource, `${s.url}/mcp`); assert.deepEqual(prm.authorization_servers, [s.url]);
    const asm = await (await fetch(`${s.url}/.well-known/oauth-authorization-server`)).json() as { code_challenge_methods_supported: string[]; registration_endpoint: string };
    assert.deepEqual(asm.code_challenge_methods_supported, ["S256"]);
    const bare = await fetch(`${s.url}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: "{}" });
    assert.equal(bare.status, 401); assert.match(bare.headers.get("www-authenticate") ?? "", /resource_metadata="[^"]+oauth-protected-resource"/);

    // 1. The client hits 401, discovers, registers, and asks to open the consent page.
    const p = makeProvider("lagos", "lagos-secret-abcdef12");
    let transport = new StreamableHTTPClientTransport(new URL(`${s.url}/mcp`), { authProvider: p.provider });
    const client = new Client({ name: "linker", version: "0" });
    await assert.rejects(client.connect(transport), (e: unknown) => e instanceof UnauthorizedError || /[Uu]nauthorized/.test(String((e as Error).message)));
    assert.ok(p.info?.client_id, "dynamic registration produced a client_id");
    assert.ok(p.authUrl, "redirectToAuthorization was called");

    // 2. The person consents; the code comes back on the redirect.
    const res = await p.consent();
    assert.equal(res.status, 302);
    const back = new URL(res.headers.get("location")!);
    assert.equal(back.origin + back.pathname, "http://127.0.0.1:9/callback");
    const code = back.searchParams.get("code")!; assert.ok(code);
    assert.equal(back.searchParams.get("state"), p.authUrl!.searchParams.get("state"));

    // 3. The client exchanges the code (PKCE) and connects as that household.
    await transport.finishAuth(code);
    assert.ok(p.tokens?.access_token && p.tokens?.refresh_token, "tokens saved");
    transport = new StreamableHTTPClientTransport(new URL(`${s.url}/mcp`), { authProvider: p.provider });
    const linked = new Client({ name: "linker", version: "0" });
    await linked.connect(transport);
    await linked.callTool({ name: "add_appliance", arguments: { name: "borehole pump", watts: 1100, minutes: 40 } });

    // The static token for the same household sees the same data; another household does not.
    const direct = new StreamableHTTPClientTransport(new URL(`${s.url}/mcp`), { requestInit: { headers: { authorization: "Bearer lagos-secret-abcdef12" } } });
    const dc = new Client({ name: "direct", version: "0" }); await dc.connect(direct);
    const list = await dc.callTool({ name: "list_appliances", arguments: {} }) as { content: Array<{ text?: string }> };
    assert.match(list.content[0].text ?? "", /borehole pump/);
    const other = new StreamableHTTPClientTransport(new URL(`${s.url}/mcp`), { requestInit: { headers: { authorization: "Bearer office-secret-abcdef12" } } });
    const oc = new Client({ name: "other", version: "0" }); await oc.connect(other);
    assert.match(((await oc.callTool({ name: "list_appliances", arguments: {} })) as { content: Array<{ text?: string }> }).content[0].text ?? "", /No appliances yet/);

    // 4. Refresh rotates: the old refresh token dies, the new access token works.
    const oldRefresh = p.tokens!.refresh_token as string;
    const r1 = await fetch(`${s.url}/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: oldRefresh, client_id: p.info!.client_id as string }) });
    assert.equal(r1.status, 200);
    const fresh = await r1.json() as { access_token: string; refresh_token: string };
    assert.notEqual(fresh.refresh_token, oldRefresh);
    const r2 = await fetch(`${s.url}/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: oldRefresh, client_id: p.info!.client_id as string }) });
    assert.equal(r2.status, 400, "a refresh token is single-use");
    const r3 = await fetch(`${s.url}/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: fresh.refresh_token }) });
    assert.equal(r3.status, 400, "public clients must send client_id on refresh (RFC 6749 §3.2.1)");
    const fresh2 = await fetch(`${s.url}/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: fresh.refresh_token, client_id: p.info!.client_id as string, resource: `${s.url}/mcp` }) });
    assert.equal(fresh2.status, 200, "RFC 8707 resource naming this server is accepted");
    const wrongRes = await fetch(`${s.url}/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: (await fresh2.json() as { refresh_token: string }).refresh_token, client_id: p.info!.client_id as string, resource: "https://other.example/mcp2" }) });
    assert.equal(wrongRes.status, 400, "a token for some other resource is refused");
    const probe = await fetch(`${s.url}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-11-25", authorization: `Bearer ${fresh.access_token}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "x", version: "0" } } }) });
    assert.equal(probe.status, 200, "the rotated access token is accepted");
    const h = await (await fetch(`${s.url}/healthz`)).json() as { auth: string; oauth: { clients: number; activeTokens: number } };
    assert.equal(h.auth, "token-or-oauth"); assert.ok(h.oauth.clients >= 1 && h.oauth.activeTokens >= 1);
    await linked.close(); await dc.close(); await oc.close();
  } finally { await s.stop(); }
});

test("OAuth refuses what it must: wrong secret, bad verifier, reused code, foreign redirect, open server", async () => {
  const s = await boot({ API_TOKENS: "lagos:lagos-secret-abcdef12" });
  try {
    const reg = await (await fetch(`${s.url}/oauth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "t", redirect_uris: ["http://127.0.0.1:9/cb"] }) })).json() as { client_id: string };
    const badReg = await fetch(`${s.url}/oauth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ redirect_uris: ["http://evil.example/cb"] }) });
    assert.equal(badReg.status, 400, "non-loopback http redirect is refused");
    const { createHash, randomBytes } = await import("node:crypto");
    const verifier = randomBytes(32).toString("base64url"), chal = createHash("sha256").update(verifier).digest("base64url");
    const form = (h: string, sec: string, uri = "http://127.0.0.1:9/cb") => new URLSearchParams({ client_id: reg.client_id, redirect_uri: uri, code_challenge: chal, household: h, secret: sec });
    const post = (b: URLSearchParams) => fetch(`${s.url}/oauth/authorize`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded" }, body: b });
    assert.equal((await post(form("lagos", "wrong-secret-value"))).status, 401);
    assert.equal((await post(form("nobody", "lagos-secret-abcdef12"))).status, 401, "unknown household is indistinguishable from a wrong secret");
    assert.equal((await post(form("lagos", "lagos-secret-abcdef12", "http://127.0.0.1:9/elsewhere"))).status, 400, "redirect must be registered — no open redirect");
    const foreign = await fetch(`${s.url}/oauth/authorize?client_id=${reg.client_id}&redirect_uri=http://attacker.example/cb&response_type=code&code_challenge=${chal}`);
    assert.equal(foreign.status, 400);
    const noPkce = await fetch(`${s.url}/oauth/authorize?client_id=${reg.client_id}&redirect_uri=http://127.0.0.1:9/cb&response_type=code`, { redirect: "manual" });
    assert.equal(noPkce.status, 302, "PKCE is mandatory — the client is told so on its own callback");
    assert.equal(new URL(noPkce.headers.get("location")!).searchParams.get("error"), "invalid_request");

    const ok = await post(form("lagos", "lagos-secret-abcdef12"));
    const code = new URL(ok.headers.get("location")!).searchParams.get("code")!;
    const tok = (body: Record<string, string>) => fetch(`${s.url}/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body) });
    assert.equal((await tok({ grant_type: "authorization_code", code, client_id: reg.client_id, redirect_uri: "http://127.0.0.1:9/cb", code_verifier: "not-the-verifier" })).status, 400, "wrong PKCE verifier");
    assert.equal((await tok({ grant_type: "authorization_code", code, client_id: reg.client_id, redirect_uri: "http://127.0.0.1:9/cb", code_verifier: verifier })).status, 400, "a failed exchange burns the code");
    const ok2 = await post(form("lagos", "lagos-secret-abcdef12"));
    const code2 = new URL(ok2.headers.get("location")!).searchParams.get("code")!;
    assert.equal((await tok({ grant_type: "authorization_code", code: code2, client_id: reg.client_id, redirect_uri: "http://127.0.0.1:9/cb", code_verifier: verifier })).status, 200);
    assert.equal((await tok({ grant_type: "authorization_code", code: code2, client_id: reg.client_id, redirect_uri: "http://127.0.0.1:9/cb", code_verifier: verifier })).status, 400, "codes are single use");
    assert.equal((await tok({ grant_type: "password" })).status, 400);
    // Malformed inputs never crash the process: a non-S256-shaped challenge, a garbage consent body, a JSON token body.
    const badChal = await fetch(`${s.url}/oauth/authorize?client_id=${reg.client_id}&redirect_uri=http://127.0.0.1:9/cb&response_type=code&code_challenge=${"x".repeat(5000)}`, { redirect: "manual" });
    assert.equal(badChal.status, 302, "challenge must look like a SHA-256 — reported to the client");
    const garbage = await fetch(`${s.url}/oauth/authorize`, { method: "POST", redirect: "manual", headers: { "content-type": "multipart/form-data; boundary=nope" }, body: "not a form" });
    assert.equal(garbage.status, 400);
    const ok3 = await post(form("lagos", "lagos-secret-abcdef12"));
    const code3 = new URL(ok3.headers.get("location")!).searchParams.get("code")!;
    const jsonTok = await fetch(`${s.url}/oauth/token`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ grant_type: "authorization_code", code: code3, client_id: reg.client_id, code_verifier: verifier }) });
    assert.equal(jsonTok.status, 200, "a JSON token request is accepted too");
    assert.equal((await fetch(`${s.url}/oauth/token`, { method: "POST", headers: { "content-type": "application/json" }, body: "{broken" })).status, 400);
    assert.equal((await fetch(`${s.url}/healthz`)).status, 200, "still alive after the hostile requests");
  } finally { await s.stop(); }
  const open = await boot({});
  try {
    assert.equal((await fetch(`${open.url}/.well-known/oauth-authorization-server`)).status, 404, "nothing to link on an open server");
  } finally { await open.stop(); }
});

test("public origin: forwarded headers or PUBLIC_URL decide what OAuth metadata advertises; repeated wrong secrets lock the household name", async () => {
  const s = await boot({ API_TOKENS: "lagos:lagos-secret-abcdef12" });
  try {
    const fwd = await (await fetch(`${s.url}/.well-known/oauth-authorization-server`, { headers: { "x-forwarded-proto": "https", "x-forwarded-host": "powerline.example.com" } })).json() as { issuer: string; token_endpoint: string };
    assert.equal(fwd.issuer, "https://powerline.example.com");
    assert.equal(fwd.token_endpoint, "https://powerline.example.com/oauth/token");
    const plain = await (await fetch(`${s.url}/.well-known/oauth-authorization-server`)).json() as { issuer: string };
    assert.equal(plain.issuer, s.url);
    const reg = await (await fetch(`${s.url}/oauth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ redirect_uris: ["http://127.0.0.1:9/cb"] }) })).json() as { client_id: string };
    const attempt = (secret: string) => fetch(`${s.url}/oauth/authorize`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: reg.client_id, redirect_uri: "http://127.0.0.1:9/cb", code_challenge: "x".repeat(43), household: "lagos", secret }) });
    for (let i = 0; i < 10; i++) assert.equal((await attempt("wrong")).status, 401);
    assert.equal((await attempt("wrong")).status, 429, "locked after ten failures");
    assert.equal((await attempt("lagos-secret-abcdef12")).status, 429, "even the right secret waits out the lock");
    // Flooding the failure table with junk names must not flush a live lock (consent posts are rate limited, so stay under it).
    const junk = (name: string) => fetch(`${s.url}/oauth/authorize`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: reg.client_id, redirect_uri: "http://127.0.0.1:9/cb", code_challenge: "x".repeat(43), household: name, secret: "nope" }) });
    for (let i = 0; i < 60; i++) await junk(`junk-${i}`);
    assert.equal((await attempt("lagos-secret-abcdef12")).status, 429, "still locked under table pressure");
    // Errors for a trusted client+redirect go back to the client (RFC 6749 §4.1.2.1), never to a dead-end page.
    const bad = await fetch(`${s.url}/oauth/authorize?client_id=${reg.client_id}&redirect_uri=http://127.0.0.1:9/cb&response_type=token&code_challenge=${"x".repeat(43)}&state=s1`, { redirect: "manual" });
    assert.equal(bad.status, 302);
    const loc = new URL(bad.headers.get("location")!);
    assert.equal(loc.origin + loc.pathname, "http://127.0.0.1:9/cb");
    assert.equal(loc.searchParams.get("error"), "unsupported_response_type");
    assert.equal(loc.searchParams.get("state"), "s1");
    // A presented-but-bad token gets error="invalid_token" so a host refreshes instead of re-linking; no token gets the plain challenge.
    const withTok = await fetch(`${s.url}/mcp`, { method: "POST", headers: { authorization: "Bearer stale", "content-type": "application/json", accept: "application/json, text/event-stream" }, body: "{}" });
    assert.equal(withTok.status, 401);
    assert.match(withTok.headers.get("www-authenticate")!, /error="invalid_token"/);
    const noTok = await fetch(`${s.url}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: "{}" });
    assert.doesNotMatch(noTok.headers.get("www-authenticate")!, /invalid_token/);
    assert.match(noTok.headers.get("www-authenticate")!, /resource_metadata=/);
    // IPv6 loopback is a dev origin too.
    const v6 = await fetch(`${s.url}/.well-known/oauth-authorization-server`, { headers: { origin: "http://[::1]:5173" } });
    assert.equal(v6.headers.get("access-control-allow-origin"), "http://[::1]:5173");
    // Consent page is never cached or framed.
    const page = await fetch(`${s.url}/oauth/authorize?client_id=${reg.client_id}&redirect_uri=http://127.0.0.1:9/cb&response_type=code&code_challenge=${"x".repeat(43)}`);
    assert.equal(page.headers.get("cache-control"), "no-store");
    assert.equal(page.headers.get("x-frame-options"), "DENY");
    // A chunked body with no Content-Length still hits the ceiling.
    const big = await fetch(`${s.url}/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "grant_type=" + "a".repeat(40_000) });
    assert.equal(big.status, 413);
  } finally { await s.stop(); }
  const pub = await boot({ API_TOKENS: "lagos:lagos-secret-abcdef12", PUBLIC_URL: "https://pl.example.org/" });
  try {
    const m = await (await fetch(`${pub.url}/.well-known/oauth-protected-resource`)).json() as { resource: string };
    assert.equal(m.resource, "https://pl.example.org/mcp");
  } finally { await pub.stop(); }
});
