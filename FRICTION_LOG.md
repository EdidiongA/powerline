# Friction log

Format per entry: task → steps → expected vs actual → severity (Blocker / Major / Minor) → workaround → suggestion.
Judges award up to 10% bonus for these. Log as you go; don't reconstruct at the end.

## 2026-09-08 — SDK package split not reflected in hackathon links
- **Task:** Install the MCP TypeScript SDK to build a Streamable HTTP server.
- **Steps:** `npm install @modelcontextprotocol/sdk` (v1.30) then `@modelcontextprotocol/ext-apps` (v2.0).
- **Expected:** The two packages interoperate.
- **Actual:** ext-apps 2.x peer-depends on the new split packages (`@modelcontextprotocol/server`, `core`, `client` v2), not `sdk` v1. Type errors on `registerAppTool(server, …)`.
- **Severity:** Major (cost ~30 min).
- **Workaround:** Uninstall `sdk`, install `@modelcontextprotocol/server@^2`; use `WebStandardStreamableHTTPServerTransport` + Hono.
- **Suggestion:** Hackathon resources page should name the v2 packages explicitly and link a Streamable HTTP + MCP Apps combined example.

## 2026-09-08 — v2 SDK ships two protocol eras
- **Task:** Confirm which spec version the server negotiates.
- **Actual:** `@modelcontextprotocol/server` v2 introduces a "modern" 2026-07-28 per-request era alongside "legacy" 2025-era sessions; `createMcpHandler` defaults to the modern path. The hackathon minimum is 2025-11-25, so sessionful `WebStandardStreamableHTTPServerTransport` was used directly.
- **Severity:** Minor (documentation).
- **Suggestion:** Rules should state whether 2026-07-28 submissions are acceptable ("or a later version, once confirmed" is ambiguous).

## 2026-09-08 — MCP App view build: top-level await
- **Task:** Bundle the view with Vite + vite-plugin-singlefile.
- **Actual:** `await app.connect()` at module top level fails esbuild's default target.
- **Severity:** Minor.
- **Workaround:** `app.connect().catch(console.error)`.
- **Suggestion:** ext-apps quickstart should show the non-top-level-await form or set `build.target: "esnext"` in the template.

## 2026-09-08 — VRM demo user cannot read `diagnostics`
- **Task:** Get live PV/load/SOC from the Victron VRM demo installation.
- **Steps:** `loginAsDemo` → `installations/{id}/diagnostics`.
- **Expected:** Current attribute values (documented endpoint).
- **Actual:** `forbidden` for the demo user; `system-overview` returns device metadata only.
- **Severity:** Minor.
- **Workaround:** `stats?type=custom&attributeCodes[]=Pdc&…&ac_loads&bp&bs&gp` returns the last 15-min values.
- **Suggestion:** VRM docs list which endpoints the demo user can access.

## 2026-09-08 — Growatt OpenAPI v1 payload field names undocumented in one place
- **Task:** Map `mix_last_data` / `tlx_last_data` to PV / load / SOC / battery / grid.
- **Actual:** Field names (`ppv`, `pLocalLoad`, `pcharge1`, `pdischarge1`, `pacToUserTotal`, `soc`…) vary by
  model/firmware; the official showdoc pages are the only reference and are behind a Chinese-language portal.
- **Severity:** Major (blocks confident mapping without a live unit).
- **Workaround:** Adapter tries several aliases and keeps `raw` for inspection.
- **Suggestion:** Growatt publish an English OpenAPI schema; hackathon resources could link it.
