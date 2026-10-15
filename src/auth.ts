/**
 * Bearer-token authentication and household identity.
 *
 * Tokens are configured as `household:secret` pairs, comma-separated:
 *
 *   API_TOKENS=lagos-home:9f3c…,office:7a1b…
 *
 * A request presenting `Authorization: Bearer 9f3c…` is served as household
 * `lagos-home`. The token IS the identity, so every session is scoped to the
 * household that owns it and two households can never see each other's state.
 *
 * `API_TOKEN=<secret>` (singular, no household) is still accepted for local
 * development and maps to DEMO_USER_ID. With neither set the endpoint is open.
 *
 * Secrets are compared in constant time so a token cannot be guessed byte by byte.
 * Alexa account linking would replace this with an OAuth token → household lookup;
 * nothing else needs to change.
 */
import { timingSafeEqual } from "node:crypto";

export interface Principal { householdId: string }

interface Credential { householdId: string; secret: Buffer }

function parseTokens(env: NodeJS.ProcessEnv): Credential[] {
  const out: Credential[] = [];
  const multi = env.API_TOKENS?.trim();
  if (multi) {
    for (const pair of multi.split(",")) {
      const idx = pair.indexOf(":");
      if (idx <= 0) { console.error(`[auth] ignoring malformed API_TOKENS entry (expected household:secret): "${pair.slice(0, 12)}…"`); continue; }
      const householdId = pair.slice(0, idx).trim();
      const secret = pair.slice(idx + 1).trim();
      if (!householdId || secret.length < 8) { console.error(`[auth] ignoring API_TOKENS entry for "${householdId}": secret must be at least 8 characters`); continue; }
      out.push({ householdId, secret: Buffer.from(secret) });
    }
  }
  const single = env.API_TOKEN?.trim();
  if (single) out.push({ householdId: env.DEMO_USER_ID ?? "demo-household", secret: Buffer.from(single) });
  return out;
}

export class Authenticator {
  private readonly credentials: Credential[];
  private readonly fallback: string;
  private readonly configured: boolean;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.credentials = parseTokens(env);
    this.fallback = env.DEMO_USER_ID ?? "demo-household";
    // Fail closed: if the operator set either variable, auth is required even when every
    // entry turned out to be unusable. A typo must not silently open the endpoint.
    this.configured = Boolean(env.API_TOKENS?.trim() || env.API_TOKEN?.trim());
    if (this.configured && this.credentials.length === 0) {
      console.error("[auth] API_TOKENS/API_TOKEN is set but no entry is valid — every request will be rejected until it is fixed");
    }
  }

  /** True when auth is configured — i.e. the endpoint is not open. */
  get required(): boolean { return this.configured; }

  get householdCount(): number { return this.credentials.length; }

  /** Every household this server serves: the configured ones, or the demo household when open. */
  get householdIds(): string[] { return this.required ? [...new Set(this.credentials.map((c) => c.householdId))] : [this.fallback]; }

  /**
   * Resolve the household for a request. Returns null when a token is required and
   * absent or wrong. With no tokens configured, every request is the demo household.
   */
  authenticate(authorizationHeader: string | null | undefined): Principal | null {
    if (!this.required) return { householdId: this.fallback };
    const header = authorizationHeader ?? "";
    const m = /^bearer\s+(.+)$/i.exec(header.trim()); // the scheme is case-insensitive (RFC 9110 §11.1)
    if (!m) return null;
    const presented = Buffer.from(m[1].trim());
    // Check every credential rather than returning early, so timing does not reveal
    // which household a guessed token was close to.
    let match: Credential | null = null;
    for (const c of this.credentials) {
      if (c.secret.length === presented.length && timingSafeEqual(c.secret, presented)) match = c;
    }
    if (match) return { householdId: match.householdId };
    // Not a static secret: perhaps an OAuth access token issued by the built-in authorization server.
    const linked = this.oauthLookup?.(presented.toString());
    return linked ? { householdId: linked } : null;
  }

  /** Hook for the OAuth server: resolve an access token to a household. */
  oauthLookup?: (token: string) => string | null;

  /** Does this household/secret pair exist? Constant-time on the secret; used by the OAuth consent page. */
  verify(householdId: string, secret: string): boolean {
    const presented = Buffer.from(secret);
    let ok = false;
    for (const c of this.credentials) {
      const idMatch = c.householdId === householdId;
      const secretMatch = c.secret.length === presented.length && timingSafeEqual(c.secret, presented);
      if (idMatch && secretMatch) ok = true;
    }
    return ok;
  }

  describe(): string {
    if (!this.required) return "open — set API_TOKENS to require one";
    if (this.householdCount === 0) return "bearer token — MISCONFIGURED, no valid entries, all requests rejected";
    return `bearer token or OAuth 2.1 (${this.householdCount} household${this.householdCount === 1 ? "" : "s"})`;
  }
}
