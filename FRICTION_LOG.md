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

## 2026-09-09 — `sendLoggingMessage()` is a silent no-op without the `logging` capability
- **Task:** Push low-battery alerts to the client over the GET SSE stream.
- **Steps:** `server.sendLoggingMessage({level:"warning", data})` from a background timer.
- **Expected:** A `notifications/message` frame on the stream, or an error.
- **Actual:** Resolves successfully and sends nothing unless `new McpServer(info, { capabilities: { logging: {} } })`. Cost ~45 min.
- **Severity:** Major.
- **Workaround:** Declare the capability. Also: notifications sent before a client opens its GET stream are dropped silently, so alerts must repeat while the condition persists.
- **Suggestion:** Throw (or at least warn) when the capability is missing; document the drop-before-GET behaviour in the Streamable HTTP section.

## 2026-09-09 — vite-plugin-singlefile: one entry per build
- **Task:** Bundle two MCP App views (dashboard + planner) into two self-contained HTML files.
- **Actual:** `output.inlineDynamicImports` rejects multiple inputs.
- **Severity:** Minor.
- **Workaround:** Run vite once per page (`UI_PAGE=card`, `UI_PAGE=planner`) via `cross-env`.
- **Suggestion:** ext-apps templates could ship a multi-view build recipe.

## 2026-09-15 — New AWS accounts cannot invoke Bedrock for up to 2 hours
- **Task:** Call Claude on Bedrock after redeeming the hackathon credits.
- **Steps:** Sign up → redeem $150 → Bedrock → Model catalog → submit Anthropic use-case form → playground → "hello".
- **Expected:** A response, since the use-case form had been accepted.
- **Actual:** `AccessDeniedException: Your account is currently being verified. Verification normally takes less than 2 hours.`
- **Severity:** Major for a timed event — a participant who redeems credits on submission day cannot use Bedrock that day.
- **Workaround:** Wait; it cleared within the stated window.
- **Suggestion:** The hackathon credit email should say that new AWS accounts need verification before Bedrock calls succeed, and advise redeeming early.

## 2026-09-15 — AWS "Free" account plan silently disqualifies promotional credits
- **Task:** Create an AWS account to redeem the hackathon credits.
- **Actual:** Sign-up offers Free vs Paid plans. The Free plan is documented as not eligible for other promotional credits and discounts, so redeeming the hackathon code there would have failed; the page itself does not say this.
- **Severity:** Major (would have cost the whole AWS mini-challenge).
- **Workaround:** Choose the Paid plan — still no charge while credits cover usage.
- **Suggestion:** The credit email should state "choose the Paid account plan" for new accounts.

## 2026-09-15 — IAM create-user wizard re-enables console access
- **Task:** Create a programmatic-only IAM user for the server.
- **Actual:** The "Provide user access to the AWS Management Console" checkbox became ticked between screens, adding a console password the user never needs and a 4th wizard step.
- **Severity:** Minor, but it mints an unnecessary long-lived credential by default.
- **Workaround:** Untick before Next, or disable the password afterwards via Security credentials → Manage console access.
- **Suggestion:** Default that checkbox off when the flow began from "access key" intent.

## 2026-09-15 — Bedrock and DynamoDB need separate IAM policies, and the docs for the credit path don't say so
- **Task:** Give one IAM user the permissions Powerline needs for both AWS services.
- **Actual:** `AmazonBedrockFullAccess` alone yields `AccessDeniedException` on the first DynamoDB call, with no indication which permission is missing until you read the error's service name.
- **Severity:** Minor, but it costs a debugging cycle for anyone adding a second AWS service.
- **Workaround:** Attach `AmazonDynamoDBFullAccess` as well; Powerline now turns that failure into a message naming the table and the policy to attach.
- **Suggestion:** The AWS Builder mini-challenge guidance could list the policies a typical multi-service submission needs.

## 2026-09-20 — `spawnSync npx ENOENT` on Windows
- **Task:** Run the card render tests on the Windows laptop after they passed on Linux.
- **Actual:** Node's `execFileSync("npx", …)` fails with ENOENT on Windows because the executable is `npx.cmd`; six tests failed, all in the harness, none in the cards.
- **Severity:** Minor, but it makes a green suite look red on the platform most entrants use.
- **Workaround:** Call esbuild's JS API (`buildSync`) instead of spawning a CLI.
- **Suggestion:** None for Amazon — this is a Node-on-Windows quirk — but it belongs in the log because it cost a debugging cycle on the day I wired up AWS.
