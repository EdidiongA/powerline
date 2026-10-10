/**
 * OAuth 2.1 authorization server — the account-linking path.
 *
 * Alexa+ (and any MCP host that follows the MCP authorization spec) links a user to a server
 * through OAuth: discover the authorization server from the protected-resource metadata,
 * register a client, send the user to /oauth/authorize, exchange the code (PKCE) for a bearer
 * token, present it on every request. Powerline implements that end to end, in-process:
 *
 *   /.well-known/oauth-protected-resource     who protects /mcp and where to authorise
 *   /.well-known/oauth-authorization-server   endpoints and capabilities
 *   POST /oauth/register                      dynamic client registration (public clients)
 *   GET|POST /oauth/authorize                 consent page: household + its secret → code
 *   POST /oauth/token                         authorization_code (PKCE S256) and refresh_token
 *
 * The household's static secret (API_TOKENS) is the credential a person types on the consent
 * page; the token the host receives is a separate, expiring bearer that maps to the household.
 * Storage is in-process (a restart logs hosts out, and refresh re-links them). Only active
 * when auth is configured — an open server has nothing to link to.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export interface OAuthClient { clientId: string; redirectUris: string[]; name: string }
interface Code { clientId: string; redirectUri: string; challenge: string; householdId: string; exp: number }
interface Access { householdId: string; clientId: string; exp: number }
interface Refresh { householdId: string; clientId: string; exp: number }

const ttl = (raw: string | undefined, dflt: number) => { const n = Number(raw); return raw?.trim() && Number.isFinite(n) && n > 0 ? n : dflt; }; // a misconfigured TTL must never mean "forever"
const ACCESS_TTL_S = ttl(process.env.OAUTH_ACCESS_TTL_S, 3600);
const REFRESH_TTL_S = ttl(process.env.OAUTH_REFRESH_TTL_S, 30 * 86400);
const CODE_TTL_MS = 5 * 60_000;
const MAX_CLIENTS = 500;
const MAX_STATE_LEN = 4096;
const MAX_FAILURE_ENTRIES = 1000; // hostile household names cannot grow the lockout table without bound

const b64url = (b: Buffer) => b.toString("base64url");
const rnd = (n = 32) => b64url(randomBytes(n));
const sha256 = (s: string) => b64url(createHash("sha256").update(s).digest());
const same = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };

export class OAuthServer {
  private clients = new Map<string, OAuthClient>();
  private codes = new Map<string, Code>();
  private access = new Map<string, Access>();
  private refresh = new Map<string, Refresh>();
  /** Failed consent attempts per household name; ten in ten minutes locks that name for ten minutes. */
  private failures = new Map<string, { count: number; until: number }>();

  constructor(private verifyHousehold: (householdId: string, secret: string) => boolean) {}

  /** True while a household name is locked after repeated wrong secrets. */
  lockedOut(householdId: string): boolean {
    const f = this.failures.get(householdId);
    if (!f) return false;
    if (f.until < Date.now()) { this.failures.delete(householdId); return false; }
    return f.count >= 10;
  }

  // ---- discovery ----
  protectedResourceMetadata(origin: string) {
    return { resource: `${origin}/mcp`, authorization_servers: [origin], bearer_methods_supported: ["header"], scopes_supported: ["powerline"], resource_name: "Powerline" };
  }
  authorizationServerMetadata(origin: string) {
    return {
      issuer: origin,
      authorization_endpoint: `${origin}/oauth/authorize`,
      token_endpoint: `${origin}/oauth/token`,
      registration_endpoint: `${origin}/oauth/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: ["powerline"],
    };
  }

  // ---- dynamic client registration (RFC 7591), public clients only ----
  register(body: unknown): { ok: true; client: Record<string, unknown> } | { ok: false; error: string; description: string } {
    const b = (body && typeof body === "object" ? body : {}) as { redirect_uris?: unknown; client_name?: unknown; token_endpoint_auth_method?: unknown };
    const uris = Array.isArray(b.redirect_uris) ? b.redirect_uris.filter((u): u is string => typeof u === "string" && u.length < 2048) : [];
    if (uris.length === 0) return { ok: false, error: "invalid_redirect_uri", description: "redirect_uris is required" };
    for (const u of uris) {
      let parsed: URL; try { parsed = new URL(u); } catch { return { ok: false, error: "invalid_redirect_uri", description: `not a URL: ${u}` }; }
      const loopback = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]";
      if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) return { ok: false, error: "invalid_redirect_uri", description: "redirect URIs must be https, or http on loopback" };
    }
    if (b.token_endpoint_auth_method !== undefined && b.token_endpoint_auth_method !== "none") return { ok: false, error: "invalid_client_metadata", description: "only public clients (token_endpoint_auth_method 'none') are supported" };
    if (this.clients.size >= MAX_CLIENTS) { const oldest = this.clients.keys().next().value; if (oldest) this.clients.delete(oldest); }
    const client: OAuthClient = { clientId: rnd(16), redirectUris: uris, name: typeof b.client_name === "string" ? b.client_name.slice(0, 80) : "MCP client" };
    this.clients.set(client.clientId, client);
    return { ok: true, client: { client_id: client.clientId, client_name: client.name, redirect_uris: uris, token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], client_id_issued_at: Math.floor(Date.now() / 1000) } };
  }

  // ---- authorization ----
  /** Validate an authorization request; returns the fields the consent page needs, or an error to show (never redirect on a bad redirect_uri). */
  checkAuthorizeRequest(q: URLSearchParams): { ok: true; client: OAuthClient; redirectUri: string; challenge: string; state: string | null } | { ok: false; status: number; message: string; redirectTo?: string } {
    const client = this.clients.get(q.get("client_id") ?? "");
    if (!client) return { ok: false, status: 400, message: "Unknown client_id — register first at /oauth/register." };
    const redirectUri = q.get("redirect_uri") ?? client.redirectUris[0];
    if (!client.redirectUris.includes(redirectUri)) return { ok: false, status: 400, message: "redirect_uri is not registered for this client." };
    const state = q.get("state");
    // From here the client and redirect are trusted, so RFC 6749 §4.1.2.1 says: send the error back to the client, not to the person.
    const bounce = (error: string, message: string) => {
      const u = new URL(redirectUri); u.searchParams.set("error", error); u.searchParams.set("error_description", message);
      if (state && state.length <= MAX_STATE_LEN) u.searchParams.set("state", state);
      return { ok: false as const, status: 302, message, redirectTo: u.toString() };
    };
    if (state && state.length > MAX_STATE_LEN) return bounce("invalid_request", "state is too long");
    if (q.get("response_type") !== "code") return bounce("unsupported_response_type", "response_type must be 'code'");
    const challenge = q.get("code_challenge") ?? "";
    // RFC 7636: S256 challenge is base64url of a SHA-256 — 43 characters, no padding. Plain is not accepted.
    if (!/^[A-Za-z0-9\-_]{43}$/.test(challenge) || (q.get("code_challenge_method") ?? "S256") !== "S256") return bounce("invalid_request", "PKCE with S256 is required");
    const resource = q.get("resource");
    if (resource && !this.resourceOk(resource)) return bounce("invalid_target", "resource must be this server's /mcp endpoint");
    return { ok: true, client, redirectUri, challenge, state };
  }

  /** RFC 8707 audience: the only resource this server issues tokens for is its own /mcp endpoint. */
  private resourceOk(resource: string): boolean { try { return new URL(resource).pathname.replace(/\/$/, "") === "/mcp"; } catch { return false; } }

  /** The person typed a household and its secret on the consent page. Returns the redirect URL or null when the credentials are wrong. */
  grant(fields: { clientId: string; redirectUri: string; challenge: string; state: string | null; householdId: string; secret: string }): string | null {
    const client = this.clients.get(fields.clientId);
    if (!client || !client.redirectUris.includes(fields.redirectUri)) return null;
    if (this.lockedOut(fields.householdId)) return null;
    if (!this.verifyHousehold(fields.householdId, fields.secret)) {
      const f = this.failures.get(fields.householdId) ?? { count: 0, until: 0 };
      if (this.failures.size >= MAX_FAILURE_ENTRIES && !this.failures.has(fields.householdId)) {
        // Evict the oldest entry that is not an active lock, so junk names cannot flush a real lockout.
        const now = Date.now();
        for (const [k, v] of this.failures) if (v.count < 10 || v.until < now) { this.failures.delete(k); break; }
        if (this.failures.size >= MAX_FAILURE_ENTRIES) return null; // table is nothing but live locks: refuse rather than forget one
      }
      this.failures.set(fields.householdId, { count: f.count + 1, until: Date.now() + 10 * 60_000 });
      return null;
    }
    this.failures.delete(fields.householdId);
    this.sweep();
    const code = rnd(32);
    this.codes.set(code, { clientId: fields.clientId, redirectUri: fields.redirectUri, challenge: fields.challenge, householdId: fields.householdId, exp: Date.now() + CODE_TTL_MS });
    const u = new URL(fields.redirectUri);
    u.searchParams.set("code", code);
    if (fields.state) u.searchParams.set("state", fields.state);
    return u.toString();
  }

  // ---- token ----
  token(form: URLSearchParams): { ok: true; body: Record<string, unknown> } | { ok: false; error: string; description: string } {
    this.sweep();
    const grant = form.get("grant_type");
    const resource = form.get("resource");
    if (resource && !this.resourceOk(resource)) return { ok: false, error: "invalid_target", description: "resource must be this server's /mcp endpoint" };
    if (grant === "authorization_code") {
      const code = this.codes.get(form.get("code") ?? "");
      this.codes.delete(form.get("code") ?? ""); // single use, even when the exchange fails
      if (!code || code.exp < Date.now()) return { ok: false, error: "invalid_grant", description: "code is unknown, used or expired" };
      if (code.clientId !== form.get("client_id")) return { ok: false, error: "invalid_grant", description: "client_id does not match the code" };
      if (form.get("redirect_uri") && form.get("redirect_uri") !== code.redirectUri) return { ok: false, error: "invalid_grant", description: "redirect_uri does not match" };
      const verifier = form.get("code_verifier") ?? "";
      if (!verifier || !same(sha256(verifier), code.challenge)) return { ok: false, error: "invalid_grant", description: "PKCE verification failed" };
      return { ok: true, body: this.issue(code.householdId, code.clientId) };
    }
    if (grant === "refresh_token") {
      const key = form.get("refresh_token") ?? "";
      const r = this.refresh.get(key);
      if (!r || r.exp < Date.now()) return { ok: false, error: "invalid_grant", description: "refresh token is unknown or expired" };
      if (form.get("client_id") !== r.clientId) return { ok: false, error: "invalid_grant", description: "client_id is required for public clients and must match" };
      this.refresh.delete(key); // rotate
      return { ok: true, body: this.issue(r.householdId, r.clientId) };
    }
    return { ok: false, error: "unsupported_grant_type", description: "use authorization_code or refresh_token" };
  }

  private issue(householdId: string, clientId: string): Record<string, unknown> {
    const access_token = rnd(32), refresh_token = rnd(32);
    this.access.set(access_token, { householdId, clientId, exp: Date.now() + ACCESS_TTL_S * 1000 });
    this.refresh.set(refresh_token, { householdId, clientId, exp: Date.now() + REFRESH_TTL_S * 1000 });
    return { access_token, token_type: "Bearer", expires_in: ACCESS_TTL_S, refresh_token, scope: "powerline" };
  }

  /** Household for a presented access token, or null. */
  householdFor(token: string): string | null {
    const a = this.access.get(token);
    if (!a) return null;
    if (a.exp < Date.now()) { this.access.delete(token); return null; }
    return a.householdId;
  }

  get stats() { return { clients: this.clients.size, activeTokens: this.access.size }; }

  private sweep() {
    const now = Date.now();
    for (const [k, v] of this.codes) if (v.exp < now) this.codes.delete(k);
    for (const [k, v] of this.access) if (v.exp < now) this.access.delete(k);
    for (const [k, v] of this.refresh) if (v.exp < now) this.refresh.delete(k);
    for (const [k, v] of this.failures) if (v.until < now) this.failures.delete(k);
  }
}

/** The consent page. Plain HTML, no scripts, same design language as the rest. */
export function consentPage(p: { clientName: string; clientId: string; redirectUri: string; challenge: string; state: string | null; error?: string }): string {
  const e = (v: string) => v.replace(/[<&>"']/g, (c) => ({ "<": "&lt;", "&": "&amp;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Link Powerline</title>
<style>:root{--ink:#16202a;--ink2:#47566a;--ink3:#66788c;--charge:#1e9e5a;--alarm:#c8452f;--rule:rgba(22,32,42,.14);--field:rgba(22,32,42,.05)}
@media(prefers-color-scheme:dark){:root{--ink:#e7edf4;--ink2:#9fb0c4;--ink3:#98a9bd;--rule:rgba(231,237,244,.16);--field:rgba(231,237,244,.06)}body{background:#0f171f}}
body{margin:0;padding:40px 20px;font:15px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:var(--ink)}main{max-width:420px;margin:0 auto}
h1{font-size:22px;margin:0 0 6px;letter-spacing:-.02em}p{color:var(--ink2);margin:0 0 18px}label{display:block;font-size:13px;color:var(--ink3);margin:12px 0 4px}
input{width:100%;box-sizing:border-box;font:inherit;padding:9px 11px;border:1px solid var(--rule);border-radius:6px;background:var(--field);color:var(--ink)}
button{margin-top:18px;font:inherit;font-weight:600;background:var(--charge);color:#fff;border:0;padding:10px 18px;border-radius:999px;cursor:pointer}
.err{color:var(--alarm);font-size:13px;margin-top:10px}.fine{font-size:12px;color:var(--ink3);margin-top:22px}</style></head><body><main>
<h1>Link Powerline to ${e(p.clientName)}</h1>
<p>${e(p.clientName)} is asking to talk to your household's Powerline. Enter the household and its secret; ${e(p.clientName)} never sees the secret — it receives an expiring token instead.</p>
<form method="post" action="/oauth/authorize">
<input type="hidden" name="client_id" value="${e(p.clientId)}"><input type="hidden" name="redirect_uri" value="${e(p.redirectUri)}"><input type="hidden" name="code_challenge" value="${e(p.challenge)}">${p.state ? `<input type="hidden" name="state" value="${e(p.state)}">` : ""}
<label for="h">Household</label><input id="h" name="household" autocomplete="username" required>
<label for="s">Household secret</label><input id="s" name="secret" type="password" autocomplete="current-password" required>
${p.error ? `<div class="err">${e(p.error)}</div>` : ""}
<button type="submit">Link household</button>
</form>
<div class="fine">This is the same OAuth 2.1 flow Alexa+ account linking uses: authorization code with PKCE, a short-lived access token, a rotating refresh token.</div>
</main></body></html>`;
}
